// ============================================================
// LEO DUNGEON RPG - Server
// Autoritativer Echtzeit-Multiplayer-Server (Node.js + Socket.io)
// ============================================================

// Optional: Einstellungen aus einer ".env"-Datei im Projektordner lesen (z.B. MONGO_URI, ADMIN_USERNAMES).
// Praktisch bei Hostern ohne Eingabefeld fuer Umgebungsvariablen. Bereits gesetzte Variablen haben Vorrang.
try {
  const envText = require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
} catch (e) { /* keine .env-Datei: kein Problem */ }

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  perMessageDeflate: true
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Datenbank (Accounts / dauerhafter Fortschritt) ----------------
const MONGO_URI = process.env.MONGO_URI || '';
let accountsCol = null;
let guildsCol = null;

async function initDb() {
  if (!MONGO_URI) {
    console.warn('WARNUNG: MONGO_URI ist nicht gesetzt. Accounts werden NICHT gespeichert (nur In-Memory, geht bei Neustart verloren).');
    return;
  }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db('leo_dungeon_rpg');
    accountsCol = db.collection('accounts');
    guildsCol = db.collection('guilds');
    await accountsCol.createIndex({ username: 1 }, { unique: true });
    console.log('MongoDB verbunden - Accounts werden dauerhaft gespeichert.');
  } catch (err) {
    console.error('MongoDB-Verbindung fehlgeschlagen:', err.message);
  }
}
initDb();

async function loadAccount(username) {
  if (!accountsCol) return null;
  return accountsCol.findOne({ username });
}

async function createAccount(username, passwordHash, cls) {
  const doc = {
    username, passwordHash, cls,
    level: 1, xp: 0, gold: 0, potions: 1, speedPotions: 0,
    upgDmg: 0, upgHp: 0, upgSpeed: 0, upgLuck: 0, quests: [],
    inventory: [], equipment: {}, skills: {}, essence: 0, cosmetics: {}, pet: null,
    stats: {}, achievements: [], daily: {}, friends: [], guild: null,
    keys: 0, prestige: 0, season: { id: '', points: 0 }, week: { id: '', points: 0 }, bossBest: {},
    storage: { items: [], gold: 0, essence: 0, potions: 0, speedPotions: 0 },
    createdAt: new Date()
  };
  if (accountsCol) await accountsCol.insertOne(doc);
  return doc;
}

async function saveAccountProgress(p) {
  if (!accountsCol || !p.username) return;
  try {
    await accountsCol.updateOne(
      { username: p.username },
      { $set: {
        level: p.level, xp: p.xp, gold: p.gold, potions: p.potions, speedPotions: p.speedPotions, cls: p.cls,
        upgDmg: p.upgDmg, upgHp: p.upgHp, upgSpeed: p.upgSpeed, upgLuck: p.upgLuck || 0, quests: p.quests || [],
        inventory: p.inventory || [], equipment: p.equipment || {}, skills: p.skills || {}, essence: p.essence || 0,
        cosmetics: p.cosmetics || {}, pet: p.pet || null, stats: p.stats || {}, achievements: p.achievements || [], daily: p.daily || {}, friends: p.friends || [], guild: p.guild || null, displayName: p.name || p.username,
        keys: p.keys || 0, prestige: p.prestige || 0, season: p.season || { id: '', points: 0 },
        week: p.week || { id: '', points: 0 }, bossBest: p.bossBest || {},
        storage: p.storage || { items: [], gold: 0, essence: 0, potions: 0, speedPotions: 0 },
        dailyQuest: p.dailyQuest || null
      } }
    );
  } catch (err) {
    console.error('Speichern fehlgeschlagen fuer', p.username, err.message);
  }
}

// ---------------- Konfiguration ----------------
const TILE = 32;
const TICK_RATE = 20; // Server-Ticks pro Sekunde
const MAX_PLAYERS_PER_DUNGEON = 6;

// Neue Systeme: Fallen, Tresore, Wiedergeburt, Raid, Saison
const TRAP_CYCLE = 3200, TRAP_WARN_FROM = 1800, TRAP_ACTIVE_FROM = 2400;   // Fallen: 0.6 s Warnung, 0.8 s aktiv
const VAULT_RESPAWN_MS = 8 * 60 * 1000, SECRET_RESPAWN_MS = 5 * 60 * 1000;
const KEY_DROP_MONSTER = 0.03;
const PRESTIGE_MIN_LEVEL = 50, PRESTIGE_MAX = 10, CLASS_CHANGE_COST = 750;
const RAID_INTERVAL_MS = 35 * 60 * 1000, RAID_DURATION_MS = 10 * 60 * 1000, RAID_MIN_LEVEL = 5, RAID_MAX_DEATHS = 5;

// Dungeon-Layout: 1 = Wand, 0 = Boden
// Prozedural generiert (Randomized-DFS-Raumgraph), garantiert zusammenhaengend.
function generateDungeon(gridW, gridH, cellSize) {
  const W = gridW * cellSize + 1;
  const H = gridH * cellSize + 1;
  const grid = [];
  for (let y = 0; y < H; y++) grid.push(new Array(W).fill('1'));

  const idx = (gx, gy) => gy * gridW + gx;
  const visited = new Uint8Array(gridW * gridH);
  const stack = [[0, 0]];
  visited[idx(0, 0)] = 1;
  const edges = [];

  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const options = [];
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && ny >= 0 && nx < gridW && ny < gridH && !visited[idx(nx, ny)]) options.push([nx, ny]);
    }
    if (options.length) {
      const [nx, ny] = options[Math.floor(Math.random() * options.length)];
      visited[idx(nx, ny)] = 1;
      edges.push([[cx, cy], [nx, ny]]);
      stack.push([nx, ny]);
    } else {
      stack.pop();
    }
  }

  const margin = 1;
  function carveRoom(gx, gy) {
    // Zufaellige Raumgroesse pro Zelle (zentriert), mehr Abwechslung statt immer gleicher Quadrate
    const maxSize = cellSize - 2 * margin;
    const size = Math.max(4, maxSize - Math.floor(Math.random() * 3));
    const off = Math.floor((maxSize - size) / 2);
    const sx = gx * cellSize + margin + off, sy = gy * cellSize + margin + off;
    for (let y = 0; y < size; y++) {
      const row = grid[sy + y];
      for (let x = 0; x < size; x++) row[sx + x] = '0';
    }
  }
  function roomCenter(gx, gy) {
    return { x: gx * cellSize + Math.floor(cellSize / 2), y: gy * cellSize + Math.floor(cellSize / 2) };
  }
  function carveCorridor(a, b) {
    let x = a.x, y = a.y;
    const horizFirst = Math.random() < 0.5;
    if (horizFirst) {
      while (x !== b.x) { grid[y][x] = '0'; x += x < b.x ? 1 : -1; }
      while (y !== b.y) { grid[y][x] = '0'; y += y < b.y ? 1 : -1; }
    } else {
      while (y !== b.y) { grid[y][x] = '0'; y += y < b.y ? 1 : -1; }
      while (x !== b.x) { grid[y][x] = '0'; x += x < b.x ? 1 : -1; }
    }
    grid[b.y][b.x] = '0';
  }

  for (let gy = 0; gy < gridH; gy++) for (let gx = 0; gx < gridW; gx++) carveRoom(gx, gy);
  for (const [a, b] of edges) carveCorridor(roomCenter(a[0], a[1]), roomCenter(b[0], b[1]));

  // Zusaetzliche zufaellige Verbindungen zwischen Nachbarzellen -> Schleifen statt reinem Baum,
  // das macht das Layout weniger vorhersehbar / abwechslungsreicher
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (gx + 1 < gridW && Math.random() < 0.12) carveCorridor(roomCenter(gx, gy), roomCenter(gx + 1, gy));
      if (gy + 1 < gridH && Math.random() < 0.12) carveCorridor(roomCenter(gx, gy), roomCenter(gx, gy + 1));
    }
  }

  return grid.map(r => r.join(''));
}

// Hoehlen-Generator (Cellular Automata) - organische Hoehlen, nur die groesste zusammenhaengende Region bleibt
function generateCave(w, h) {
  for (let attempt = 0; attempt < 12; attempt++) {
    let grid = [];
    for (let y = 0; y < h; y++) {
      const row = new Uint8Array(w);
      for (let x = 0; x < w; x++) {
        row[x] = (x === 0 || y === 0 || x === w - 1 || y === h - 1 || Math.random() < 0.45) ? 1 : 0;
      }
      grid.push(row);
    }
    for (let it = 0; it < 5; it++) {
      const next = [];
      for (let y = 0; y < h; y++) {
        const row = new Uint8Array(w);
        for (let x = 0; x < w; x++) {
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { row[x] = 1; continue; }
          let walls = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) walls += grid[y + dy][x + dx];
          row[x] = walls >= 5 ? 1 : 0;
        }
        next.push(row);
      }
      grid = next;
    }
    // Groesste zusammenhaengende Bodenregion finden
    const region = new Int32Array(w * h).fill(-1);
    let bestId = -1, bestSize = 0, nextId = 0;
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        if (grid[sy][sx] !== 0 || region[sy * w + sx] !== -1) continue;
        const id = nextId++;
        let size = 0;
        const stack = [sy * w + sx];
        region[sy * w + sx] = id;
        while (stack.length) {
          const cur = stack.pop();
          size++;
          const cx = cur % w, cy = (cur - cx) / w;
          const nbs = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
          for (const [nx, ny] of nbs) {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (grid[ny][nx] !== 0 || region[ny * w + nx] !== -1) continue;
            region[ny * w + nx] = id;
            stack.push(ny * w + nx);
          }
        }
        if (size > bestSize) { bestSize = size; bestId = id; }
      }
    }
    if (bestSize < w * h * 0.25) continue;
    const rows = [];
    for (let y = 0; y < h; y++) {
      let row = '';
      for (let x = 0; x < w; x++) row += (region[y * w + x] === bestId) ? '0' : '1';
      rows.push(row);
    }
    return rows;
  }
  return generateDungeon(25, 5, 10); // Notfall-Fallback
}

// Labyrinth-Generator (Randomized DFS) mit ein paar zusaetzlichen Durchbruechen (Schleifen)
function generateMaze(cols, rows) {
  const W = cols * 2 + 1, H = rows * 2 + 1;
  const grid = [];
  for (let y = 0; y < H; y++) grid.push(new Array(W).fill('1'));
  const visited = new Uint8Array(cols * rows);
  const stack = [[0, 0]];
  visited[0] = 1;
  grid[1][1] = '0';
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const opts = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && !visited[ny * cols + nx]) opts.push([nx, ny, dx, dy]);
    }
    if (opts.length) {
      const [nx, ny, dx, dy] = opts[Math.floor(Math.random() * opts.length)];
      visited[ny * cols + nx] = 1;
      grid[ny * 2 + 1][nx * 2 + 1] = '0';
      grid[cy * 2 + 1 + dy][cx * 2 + 1 + dx] = '0';
      stack.push([nx, ny]);
    } else {
      stack.pop();
    }
  }
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (grid[y][x] !== '1' || Math.random() >= 0.05) continue;
      const horiz = grid[y][x - 1] === '0' && grid[y][x + 1] === '0';
      const vert = grid[y - 1][x] === '0' && grid[y + 1][x] === '0';
      if (horiz || vert) grid[y][x] = '0';
    }
  }
  return grid.map(r => r.join(''));
}

function buildTierRows(g) {
  if (g.type === 'cave') return generateCave(g.w, g.h);
  if (g.type === 'maze') return generateMaze(g.cols, g.rows);
  return generateDungeon(g.gridW, g.gridH, g.cellSize);
}

function makeArena(w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      row += (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? '1' : '0';
    }
    rows.push(row);
  }
  return rows;
}

function buildMapInfo(rows, w, h, excl) {
  // '1' = Wand, '0' = Boden, '2' = Tresortuer (Schluessel), '3' = Geheimwand (Angriff oeffnet sie), '4' = Boden in Tresor-/Geheimraeumen
  const open = new Set();   // geoeffnete Tueren als "x,y"
  function isWall(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return true;
    const c = rows[ty][tx];
    if (c === '1') return true;
    if (c === '2' || c === '3') return !open.has(tx + ',' + ty);
    return false;
  }
  function isFloor(tx, ty) { return !isWall(tx, ty) && !(excl && excl.has(tx + ',' + ty)); }
  const floor = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rows[y][x] === '0' && !(excl && excl.has(x + ',' + y))) floor.push({ x, y });
    }
  }
  return { rows, w, h, isWall, isFloor, floor, open };
}

// Tresorraeume (Tuer + Schluessel) und Geheimraeume (Wand, die auf Angriffe reagiert) in Waende einbauen
function carveFeatures(rowsIn, vaultCount, secretCount) {
  const PAD = 8, W = rowsIn[0].length;
  const wallRow = '1'.repeat(W), padded = [];
  for (let i = 0; i < PAD; i++) padded.push(wallRow);
  for (const r of rowsIn) padded.push(r);
  for (let i = 0; i < PAD; i++) padded.push(wallRow);
  const g = padded.map(r => r.split('')), H = g.length;
  const excl = new Set(), vaults = [], secrets = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const solid = (x, y) => x >= 1 && y >= 1 && x < W - 1 && y < H - 1 && g[y][x] === '1';
  function carveOne(kind) {
    for (let attempt = 0; attempt < 40000; attempt++) {
      const fx = 2 + Math.floor(Math.random() * (W - 4)), fy = 2 + Math.floor(Math.random() * (H - 4));
      if (g[fy][fx] !== '0') continue;
      const [dx, dy] = dirs[Math.floor(Math.random() * 4)], px = -dy, py = dx;
      let ok = true;
      for (let d = 1; d <= 6 && ok; d++) for (let w = -2; w <= 2; w++) {
        if (!solid(fx + dx * d + px * w, fy + dy * d + py * w)) { ok = false; break; }
      }
      if (!ok) continue;
      const door = { x: fx + dx, y: fy + dy };
      g[door.y][door.x] = kind === 'vault' ? '2' : '3';
      const cells = [];
      const put = (x, y) => { g[y][x] = '4'; cells.push({ x, y }); excl.add(x + ',' + y); };   // '4' = Raumboden (auf der Minimap unsichtbar)
      put(fx + dx * 2, fy + dy * 2);
      for (let d = 3; d <= 5; d++) for (let w = -1; w <= 1; w++) put(fx + dx * d + px * w, fy + dy * d + py * w);
      const mid = { x: fx + dx * 4, y: fy + dy * 4 }, side = { x: fx + dx * 4 + px, y: fy + dy * 4 + py };
      const room = { kind, door, cells, cellKeys: new Set(cells.map(c => c.x + ',' + c.y)), chestAt: kind === 'vault' ? [mid] : [mid, side], chests: [], lootedAt: 0 };
      (kind === 'vault' ? vaults : secrets).push(room);
      return true;
    }
    return false;
  }
  for (let i = 0; i < vaultCount; i++) carveOne('vault');
  for (let i = 0; i < secretCount; i++) carveOne('secret');
  return { rows: g.map(r => r.join('')), excl, vaults, secrets };
}

// Stachelfallen: kleine Gruppen aus 2-4 Feldern, jede mit eigenem Takt
function makeTraps(map, clusters) {
  const traps = [], seen = new Set();
  for (let c = 0; c < clusters; c++) {
    const t = map.floor[Math.floor(Math.random() * map.floor.length)];
    const horizontal = Math.random() < 0.5, len = 2 + Math.floor(Math.random() * 3), ph = Math.floor(Math.random() * TRAP_CYCLE);
    for (let i = 0; i < len; i++) {
      const x = t.x + (horizontal ? i : 0), y = t.y + (horizontal ? 0 : i), k = x + ',' + y;
      if (seen.has(k) || !map.isFloor(x, y)) break;
      seen.add(k);
      traps.push({ x, y, ph: (ph + i * 250) % TRAP_CYCLE });
    }
  }
  return traps;
}

// ---------------- Dungeon-Stufen (abhaengig vom Spieler-Level) ----------------
const DUNGEON_TIER_DEFS = [
  { key: 'tier1', name: 'Moosige Höhle', minLevel: 1, gen: { type: 'cave', w: 200, h: 50 }, monsterMult: 1.8, dmgMult: 1.2, lootMult: 1.3,
    pool: [['goblin', 5], ['slime', 4], ['bat', 2], ['archer', 2]],
    theme: { wall: '#2f3b2c', wallTop: '#1f2a1d', floorA: '#161d14', floorB: '#1a2218' } },
  { key: 'tier2', name: 'Verlassene Mine', minLevel: 8, gen: { type: 'rooms', gridW: 25, gridH: 5, cellSize: 10 }, monsterMult: 3.7, dmgMult: 1.9, lootMult: 1.9,
    pool: [['goblin', 4], ['ork', 3], ['bat', 3], ['archer', 3]],
    theme: { wall: '#3a3226', wallTop: '#272016', floorA: '#1d1913', floorB: '#221e17' } },
  { key: 'tier3', name: 'Katakomben', minLevel: 15, gen: { type: 'maze', cols: 100, rows: 22 }, monsterMult: 6.1, dmgMult: 2.6, lootMult: 2.5,
    pool: [['skeleton', 5], ['bat', 3], ['ork', 2], ['archer', 2], ['caster', 2]],
    theme: { wall: '#3b3b42', wallTop: '#26262c', floorA: '#17171c', floorB: '#1b1b21' } },
  { key: 'tier4', name: 'Eishöhlen', minLevel: 25, gen: { type: 'cave', w: 220, h: 55 }, monsterMult: 7.2, dmgMult: 4.0, lootMult: 3.0,
    pool: [['troll', 3], ['slime', 3], ['skeleton', 3], ['caster', 2], ['spitter', 2]],
    theme: { wall: '#2c4a5e', wallTop: '#1c3342', floorA: '#12202b', floorB: '#16283a' } },
  { key: 'tier5', name: 'Vulkan-Festung', minLevel: 35, gen: { type: 'rooms', gridW: 18, gridH: 4, cellSize: 14 }, monsterMult: 6.0, dmgMult: 3.4, lootMult: 3.6,
    pool: [['troll', 4], ['demon', 3], ['skeleton', 2], ['caster', 3]],
    theme: { wall: '#5a2a22', wallTop: '#3a1a15', floorA: '#2a1410', floorB: '#32180f' } },
  { key: 'tier6', name: 'Der Abgrund', minLevel: 50, gen: { type: 'maze', cols: 90, rows: 20 }, monsterMult: 8.3, dmgMult: 4.7, lootMult: 4.5,
    pool: [['demon', 5], ['troll', 3], ['caster', 3], ['spitter', 2]],
    theme: { wall: '#3a2350', wallTop: '#251538', floorA: '#150d20', floorB: '#1a1128' } },
  { key: 'tier7', name: 'Obsidian-Thron', minLevel: 65, gen: { type: 'rooms', gridW: 16, gridH: 4, cellSize: 15 }, monsterMult: 11.5, dmgMult: 5.8, lootMult: 5.8,
    pool: [['obsidianKnight', 3], ['voidStalker', 3], ['doomHerald', 3], ['demon', 2], ['caster', 2], ['spitter', 2]],
    theme: { wall: '#23232c', wallTop: '#121218', floorA: '#0c0c11', floorB: '#101017' } },
  { key: 'tier8', name: 'Aschenthron', minLevel: 80, gen: { type: 'rooms', gridW: 16, gridH: 4, cellSize: 15 }, monsterMult: 15, dmgMult: 6.5, lootMult: 6.5,
    pool: [['sensenmann', 3], ['obsidianKnight', 3], ['doomHerald', 3], ['voidStalker', 2], ['demon', 2]],
    theme: { wall: '#2e1a1a', wallTop: '#180d0d', floorA: '#120a0a', floorB: '#170d0d' } }
];
const DUNGEON_TIERS = {};
const FEATURES = {};   // zone -> { vaults, secrets, trapMap }
for (const def of DUNGEON_TIER_DEFS) {
  const built = carveFeatures(buildTierRows(def.gen), 3, 2);
  const rows = built.rows;
  const map = buildMapInfo(rows, rows[0].length, rows.length, built.excl);
  const traps = makeTraps(map, 28);
  DUNGEON_TIERS[def.key] = { ...def, rows, map, traps };
  FEATURES[def.key] = { vaults: built.vaults, secrets: built.secrets, trapMap: new Map(traps.map(t => [t.x + ',' + t.y, t.ph])) };
}
const DEFAULT_TIER_KEY = DUNGEON_TIER_DEFS[0].key;
function tierForLevel(level) {
  let chosen = DUNGEON_TIER_DEFS[0];
  for (const def of DUNGEON_TIER_DEFS) if (level >= def.minLevel) chosen = def;
  return chosen.key;
}
function isDungeonTier(zone) { return !!DUNGEON_TIERS[zone]; }

const ARENA_ROWS = makeArena(20, 13);
const ARENA = buildMapInfo(ARENA_ROWS, ARENA_ROWS[0].length, ARENA_ROWS.length);
const BOSSROOM_ROWS = makeArena(24, 16);
const BOSSROOM = buildMapInfo(BOSSROOM_ROWS, BOSSROOM_ROWS[0].length, BOSSROOM_ROWS.length);

// Hub-Stadt: sicherer Ort mit NPCs
function makeTownRows() {
  const g = makeArena(40, 24).map(r => r.split(''));
  const box = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = '1'; };
  box(4, 2, 12, 4); box(27, 2, 35, 4); box(4, 19, 12, 21); box(27, 19, 35, 21); box(19, 11, 20, 12);
  return g.map(r => r.join(''));
}
function makeRaidRows() {
  const g = makeArena(44, 28).map(r => r.split(''));
  const box = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = '1'; };
  box(11, 7, 12, 8); box(11, 19, 12, 20); box(31, 7, 32, 8); box(31, 19, 32, 20);
  return g.map(r => r.join(''));
}
const TOWN_ROWS = makeTownRows();
const TOWN = buildMapInfo(TOWN_ROWS, TOWN_ROWS[0].length, TOWN_ROWS.length);
const RAID_ROWS = makeRaidRows();
const RAID = buildMapInfo(RAID_ROWS, RAID_ROWS[0].length, RAID_ROWS.length);
const tileCenter = (x, y) => ({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 });
const TOWN_SPAWN = tileCenter(20, 16);
const RAID_ENTRY = tileCenter(4, 14), RAID_CENTER = tileCenter(22, 14);
const TOWN_NPCS = [
  { id: 'shop',    name: 'Händler Brun',       icon: '🏪', panel: 'shop',    ...tileCenter(8, 5) },
  { id: 'smith',   name: 'Schmied Ragna',      icon: '⚒️', panel: 'smith',   ...tileCenter(31, 5) },
  { id: 'quests',  name: 'Questgeberin Mira',  icon: '📜', panel: 'quests',  ...tileCenter(8, 18) },
  { id: 'herald',  name: 'Herold Torben',      icon: '🐉', panel: 'raid',    ...tileCenter(31, 18) },
  { id: 'rebirth', name: 'Meister der Wiedergeburt', icon: '⭐', panel: 'rebirth', ...tileCenter(20, 5) },
  { id: 'craft',   name: 'Werkstatt',           icon: '🔨', panel: 'craft',   ...tileCenter(20, 18) },
  { id: 'joker',   name: 'Gaukler Finn',        icon: '🤡', panel: 'buff',    ...tileCenter(35, 11) },
  { id: 'depot',   name: 'Verwalterin Lyra',    icon: '📦', panel: 'depot',   ...tileCenter(26, 11) }
];

function mapFor(zone) {
  if (zone === 'town') return TOWN;
  if (zone === 'raid') return RAID;
  if (zone === 'arena') return ARENA;
  if (zone === 'bossroom') return BOSSROOM;
  if (DUNGEON_TIERS[zone]) return DUNGEON_TIERS[zone].map;
  return DUNGEON_TIERS[DEFAULT_TIER_KEY].map;
}

function randomFloorTile(zone) {
  const m = mapFor(zone);
  return m.floor[Math.floor(Math.random() * m.floor.length)];
}
function randomTierSpawn(zone) {
  const t = randomFloorTile(zone || DEFAULT_TIER_KEY);
  return { x: t.x * TILE + TILE / 2, y: t.y * TILE + TILE / 2 };
}
const ARENA_SPAWN_TILE = ARENA.floor[Math.floor(ARENA.floor.length / 2)];
const ARENA_SPAWN = { x: ARENA_SPAWN_TILE.x * TILE + TILE / 2, y: ARENA_SPAWN_TILE.y * TILE + TILE / 2 };
const BOSSROOM_ENTRY_TILE = BOSSROOM.floor[Math.floor(BOSSROOM.floor.length * 0.15)];
const BOSSROOM_ENTRY = { x: BOSSROOM_ENTRY_TILE.x * TILE + TILE / 2, y: BOSSROOM_ENTRY_TILE.y * TILE + TILE / 2 };
const BOSSROOM_CENTER_TILE = BOSSROOM.floor[Math.floor(BOSSROOM.floor.length / 2)];
const BOSSROOM_CENTER = { x: BOSSROOM_CENTER_TILE.x * TILE + TILE / 2, y: BOSSROOM_CENTER_TILE.y * TILE + TILE / 2 };

// ---------------- Klassen-Definitionen ----------------
const CLASSES = {
  krieger: { name: 'Krieger', maxHp: 150, speed: 2.4, dmg: 18, range: 42, cooldown: 500, kind: 'melee', color: '#e74c3c' },
  magier:  { name: 'Magier',  maxHp: 80,  speed: 2.1, dmg: 27, range: 240, cooldown: 750, kind: 'ranged', color: '#3498db' },
  schurke: { name: 'Schurke', maxHp: 100, speed: 3.0, dmg: 10, range: 36, cooldown: 320, kind: 'melee', color: '#2ecc71', crit: 0.25 },
  paladin: { name: 'Paladin', maxHp: 190, speed: 2.2, dmg: 15, range: 46, cooldown: 620, kind: 'melee', color: '#f1c40f' },
  berserker: { name: 'Berserker', maxHp: 115, speed: 2.7, dmg: 30, range: 40, cooldown: 560, kind: 'melee', color: '#e67e22' }
};

function statsForLevel(clsKey, level) {
  const def = CLASSES[clsKey] || CLASSES.krieger;
  const lvlBonus = Math.max(0, level - 1);
  return {
    maxHp: def.maxHp + lvlBonus * 18,
    dmg: def.dmg + Math.round(lvlBonus * 3 * dmgScale(clsKey))
  };
}
// Schaden pro Treffer waechst mit der Angriffsdauer der Klasse (Referenz Krieger: 500 ms),
// damit schnelle und langsame Klassen pro Sekunde gleich viel dazugewinnen.
function dmgScale(clsKey) {
  const def = CLASSES[clsKey] || CLASSES.krieger;
  return def.cooldown / 500;
}

function recomputeStats(p) {
  const base = statsForLevel(p.cls, p.level);
  const eq = equipmentBonus(p);
  const vit = 1 + 0.04 * ((p.skills && p.skills.vit) || 0);
  const pm = 1 + 0.06 * (p.prestige || 0);   // Wiedergeburt: +6% Leben und Schaden je Stufe
  p.maxHp = Math.round((base.maxHp + p.upgHp * 15 + eq.hp) * vit * pm);
  p.dmg = Math.round((base.dmg + Math.round((p.upgDmg * 2 + eq.dmg) * dmgScale(p.cls))) * pm);
  p.speed = CLASSES[p.cls].speed + p.upgSpeed * 0.12 + eq.speed;
  p.critBonus = Math.min(0.5, eq.crit);
  p.hp = Math.min(p.hp, p.maxHp);
}

const SHOP_ITEMS = {
  potion: { label: '🧪 Heiltrank', cat: 'verbrauch', baseCost: 12, scale: 0, maxCount: null },
  speedpotion: { label: '⚡ Tempo-Trank (15s +60% Tempo)', cat: 'verbrauch', baseCost: 15, scale: 0, maxCount: null },
  dmg: { label: '⚔️ Waffe schärfen (+2 Schaden)', cat: 'upgrades', baseCost: 25, scale: 20, maxCount: 10 },
  hp: { label: '🛡️ Rüstung verstärken (+15 max. HP)', cat: 'upgrades', baseCost: 25, scale: 20, maxCount: 10 },
  speed: { label: '👢 Leichtere Stiefel (+Tempo)', cat: 'upgrades', baseCost: 30, scale: 25, maxCount: 5 },
  luck: { label: '🍀 Glücksstein (+seltenere Beute)', cat: 'upgrades', baseCost: 40, scale: 30, maxCount: 8 }
};
const UPG_KEYS = { dmg: 'upgDmg', hp: 'upgHp', speed: 'upgSpeed', luck: 'upgLuck' };
// Trinkgeld-Link: hier die eigene Ko-fi-URL eintragen (z.B. 'https://ko-fi.com/name').
// Solange leer, wird die Trinkgeld-Sektion im Shop ausgeblendet.
const DONATE_LINKS = { kofi: '' };
// Discord-Einladungslink (z.B. 'https://discord.gg/xyz') – wird im Spiel angezeigt, sobald gesetzt.
const DISCORD_INVITE = 'https://discord.gg/xe793t62a2';
const EMOTES = { wave: 'winkt', dance: 'tanzt', cheer: 'jubelt', cry: 'weint', laugh: 'lacht', flex: 'posiert', gg: 'gratuliert', hello: 'grüßt' };
function dailyDealKey() {
  const day = Math.floor(Date.now() / 86400000);
  const keys = Object.keys(SHOP_ITEMS);
  return keys[day % keys.length];
}
function shopCost(itemKey, currentCount) {
  const def = SHOP_ITEMS[itemKey];
  let c = def.baseCost + def.scale * currentCount;
  if (itemKey === dailyDealKey()) c = Math.round(c * 0.7);
  return c;
}

// ---------------- Game-State ----------------
const players = {};     // id -> player
const monsters = {};    // id -> monster
const tpaRequests = {}; // targetSocketId -> { fromId, expiresAt }
const duelRequests = {}; // targetSocketId -> { fromId, expiresAt }
const items = {};       // id -> ground item
const projectiles = {}; // id -> projectile

let monsterIdCounter = 0;
let itemIdCounter = 0;
let projectileIdCounter = 0;

const MONSTER_TYPES = {
  goblin: { name: 'Goblin', hp: 40, dmg: 8, speed: 1.3, xp: 15, range: 30, cooldown: 900, color: '#8e7c4d', radius: 12 },
  ork:    { name: 'Ork', hp: 95, dmg: 16, speed: 0.9, xp: 40, range: 34, cooldown: 1200, color: '#5b4636', radius: 16 },
  slime:    { name: 'Schleim', hp: 30, dmg: 6, speed: 0.8, xp: 10, range: 28, cooldown: 1000, color: '#55c26b', radius: 11, effect: 'slow' },
  bat:      { name: 'Fledermaus', hp: 25, dmg: 7, speed: 2.0, xp: 12, range: 26, cooldown: 700, color: '#7a5aa0', radius: 9, effect: 'poison' },
  skeleton: { name: 'Skelett', hp: 70, dmg: 14, speed: 1.1, xp: 30, range: 32, cooldown: 1000, color: '#d8d8c8', radius: 13 },
  troll:    { name: 'Troll', hp: 180, dmg: 24, speed: 0.8, xp: 70, range: 40, cooldown: 1300, color: '#4f7a4a', radius: 18, effect: 'slow' },
  demon:    { name: 'Dämon', hp: 260, dmg: 34, speed: 1.2, xp: 110, range: 38, cooldown: 1000, color: '#c03a3a', radius: 16, effect: 'burn' },
  treasure: { name: 'Schatzgoblin', hp: 150, dmg: 0, speed: 2.3, xp: 40, range: 20, cooldown: 99999, color: '#ffd700', radius: 10 },
  archer:  { name: 'Bogenschütze', hp: 45, dmg: 11, speed: 0.95, xp: 22, range: 260, cooldown: 1700, color: '#c9a66b', radius: 11, ranged: { speed: 6, life: 60, color: '#f1e3b0' } },
  caster:  { name: 'Hexer', hp: 60, dmg: 17, speed: 0.8, xp: 38, range: 300, cooldown: 2300, color: '#9b4dca', radius: 12, effect: 'burn', ranged: { speed: 4.5, life: 80, color: '#ff8a3c' } },
  spitter: { name: 'Säurespucker', hp: 70, dmg: 13, speed: 0.7, xp: 30, range: 240, cooldown: 2000, color: '#7bd05a', radius: 13, effect: 'poison', ranged: { speed: 4, life: 75, color: '#8fff6b' } },
  sensenmann:  { name: 'Sensenmann', hp: 300, dmg: 52, speed: 1.4, xp: 200, range: 34, cooldown: 900, color: '#1c1c26', radius: 15, effect: 'slow' },
  obsidianKnight: { name: 'Obsidianritter', hp: 340, dmg: 46, speed: 1.0, xp: 170, range: 36, cooldown: 1100, color: '#3d3d52', radius: 17, effect: 'slow' },
  voidStalker:   { name: 'Nichtshetzer', hp: 150, dmg: 30, speed: 1.9, xp: 120, range: 30, cooldown: 800, color: '#5a2a7a', radius: 12, effect: 'poison' },
  doomHerald:    { name: 'Unheilbote', hp: 210, dmg: 38, speed: 0.9, xp: 155, range: 290, cooldown: 2100, color: '#8a1f1f', radius: 14, effect: 'burn', ranged: { speed: 5, life: 85, color: '#ff4d4d' } },
  raidboss: { name: 'Weltenfresser', hp: 1, dmg: 38, speed: 1.1, xp: 0, range: 58, cooldown: 1000, color: '#7d3cff', radius: 44 },
  boss:   { name: 'Dungeon-Wächter', hp: 900, dmg: 22, speed: 1.0, xp: 400, range: 48, cooldown: 1100, color: '#c0392b', radius: 26 }
};
const MAX_MONSTERS_PER_TIER = 60;

function pickMonsterType(pool) {
  let total = 0;
  for (const [, w] of pool) total += w;
  let r = Math.random() * total;
  for (const [type, w] of pool) { r -= w; if (r <= 0) return type; }
  return pool[0][0];
}

function spawnMonster(zone, at, force, statsTier) {
  zone = zone || DEFAULT_TIER_KEY;
  const tierDef = DUNGEON_TIERS[statsTier || zone];
  if (!tierDef) return;
  const countInZone = Object.values(monsters).reduce((n, m) => n + ((m.zone || DEFAULT_TIER_KEY) === zone ? 1 : 0), 0);
  if (!force && countInZone >= MAX_MONSTERS_PER_TIER) return;
  const type = pickMonsterType(tierDef.pool);
  const def = MONSTER_TYPES[type];
  const tile = at || randomFloorTile(zone);
  const id = 'm' + (monsterIdCounter++);
  const mult = tierDef.monsterMult;
  monsters[id] = {
    id, type, zone, mult, dmgMult: tierDef.dmgMult || Math.pow(mult, 0.65),
    x: tile.x * TILE + TILE / 2,
    y: tile.y * TILE + TILE / 2,
    hp: Math.round(def.hp * mult), maxHp: Math.round(def.hp * mult),
    lastAttack: 0,
    targetId: null,
    homeX: tile.x * TILE + TILE / 2,
    homeY: tile.y * TILE + TILE / 2
  };
  return monsters[id];
}

function spawnItem(x, y, zone, forceType) {
  zone = zone || DEFAULT_TIER_KEY;
  const roll = Math.random();
  const type = forceType || (roll < 0.6 ? 'gold' : 'potion');
  const id = 'i' + (itemIdCounter++);
  const lootMult = (DUNGEON_TIERS[zone] && DUNGEON_TIERS[zone].lootMult) || 1;
  const amount = type === 'gold' ? Math.round((5 + Math.floor(Math.random() * 15)) * goldMult() * lootMult) : 1;
  items[id] = { id, type, x, y, amount, zone };
  return items[id];
}

// Initiale Monster pro Dungeon-Stufe
for (const key in DUNGEON_TIERS) {
  for (let i = 0; i < 25; i++) spawnMonster(key);
}
setInterval(() => {
  for (const key in DUNGEON_TIERS) {
    for (let i = 0; i < 2; i++) { if (Math.random() < 0.7) spawnMonster(key); }
  }
}, 3000);

// ---------------- Hilfsfunktionen ----------------
function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function xpToNextLevel(level) {
  return 80 + level * 60 + 2 * level * level;
}

// ---------------- Events (Doppel-Gold / Doppel-XP) ----------------
let goldEventUntil = 0;
let xpEventUntil = 0;
function goldMult() { return Date.now() < goldEventUntil ? 2 : 1; }
function xpMult() { return Date.now() < xpEventUntil ? 2 : 1; }

function circleHitsWall(mapInfo, x, y, radius) {
  const pts = [
    [x - radius, y - radius], [x + radius, y - radius],
    [x - radius, y + radius], [x + radius, y + radius]
  ];
  for (const [px, py] of pts) {
    if (mapInfo.isWall(Math.floor(px / TILE), Math.floor(py / TILE))) return true;
  }
  return false;
}

function tryMove(mapInfo, entity, dx, dy, radius) {
  const nx = entity.x + dx;
  const ny = entity.y + dy;
  if (!circleHitsWall(mapInfo, nx, entity.y, radius)) entity.x = nx;
  if (!circleHitsWall(mapInfo, entity.x, ny, radius)) entity.y = ny;
}

// ---------------- Truhen ----------------
const CHEST_COUNT_PER_TIER = 10;
const CHEST_RESPAWN_MS = 90000;
const chests = {};
(function initChests() {
  let counter = 1;
  for (const key in DUNGEON_TIERS) {
    const floor = DUNGEON_TIERS[key].map.floor;
    const step = Math.floor(floor.length / (CHEST_COUNT_PER_TIER + 1));
    for (let i = 1; i <= CHEST_COUNT_PER_TIER; i++) {
      const tile = floor[step * i];
      const id = 'c' + (counter++);
      chests[id] = {
        id, zone: key,
        x: tile.x * TILE + TILE / 2,
        y: tile.y * TILE + TILE / 2,
        looted: false,
        respawnAt: 0
      };
    }
  }
})();

// ================= Neue Systeme: Tresore, Fallen, 2. Faehigkeit, Saison, Raid =================
function giveKey(p, n) {
  p.keys = Math.min(99, (p.keys || 0) + n);
  notice(p, '🔑 Schlüssel gefunden (' + p.keys + ')');
}

// Geheimwand: reagiert auf Angriffe in der Naehe
function revealSecrets(p) {
  const feat = FEATURES[p.zone];
  if (!feat || p.dead) return;
  const map = DUNGEON_TIERS[p.zone].map;
  for (const room of feat.secrets) {
    const k = room.door.x + ',' + room.door.y;
    if (map.open.has(k)) continue;
    if (dist(p.x, p.y, room.door.x * TILE + TILE / 2, room.door.y * TILE + TILE / 2) > 52) continue;
    map.open.add(k);
    p.stats.secrets++;
    addSeasonPoints(p, 10);
    notice(p, '🔍 Du hast einen Geheimraum entdeckt!');
    checkAchievements(p);
    saveAccountProgress(p);
  }
}

// Stachelfallen
function checkTraps(p, now) {
  const feat = FEATURES[p.zone];
  if (!feat) return;
  const ph = feat.trapMap.get(Math.floor(p.x / TILE) + ',' + Math.floor(p.y / TILE));
  if (ph === undefined) return;
  if (((now + ph) % TRAP_CYCLE) < TRAP_ACTIVE_FROM) return;
  if (now - (p.trapAt || 0) < 900) return;
  p.trapAt = now;
  damagePlayer(p, Math.max(5, Math.round(p.maxHp * 0.07)), 'einer Stachelfalle');
  io.to(p.id).emit('trapHit');
}

// Truhen in Tresor- und Geheimraeumen
(function initRoomChests() {
  let n = 1;
  for (const zone in FEATURES) {
    for (const room of FEATURES[zone].vaults.concat(FEATURES[zone].secrets)) {
      for (const at of room.chestAt) {
        const id = 'rc' + (n++);
        chests[id] = { id, zone, kind: room.kind, room, x: at.x * TILE + TILE / 2, y: at.y * TILE + TILE / 2, looted: false, respawnAt: Infinity };
        room.chests.push(id);
      }
    }
  }
})();
let lastRoomCheck = 0;
function updateRooms() {
  const now = Date.now();
  if (now - lastRoomCheck < 1000) return;
  lastRoomCheck = now;
  for (const zone in FEATURES) {
    const map = DUNGEON_TIERS[zone].map;
    for (const room of FEATURES[zone].vaults.concat(FEATURES[zone].secrets)) {
      if (!room.lootedAt) continue;
      if (now - room.lootedAt < (room.kind === 'vault' ? VAULT_RESPAWN_MS : SECRET_RESPAWN_MS)) continue;
      let inside = false;   // Tuer erst schliessen, wenn niemand mehr drin ist
      for (const pid in players) {
        const pl = players[pid];
        if (pl.zone !== zone) continue;
        const tx = Math.floor(pl.x / TILE), ty = Math.floor(pl.y / TILE);
        if (room.cellKeys.has(tx + ',' + ty) || (tx === room.door.x && ty === room.door.y)) { inside = true; break; }
      }
      if (inside) continue;
      map.open.delete(room.door.x + ',' + room.door.y);
      room.lootedAt = 0;
      for (const cid of room.chests) chests[cid].looted = false;
    }
  }
}

// ---------------- Zweite Faehigkeit (Taste T) ----------------
const ABILITIES2 = {
  krieger: { name: 'Bollwerk', icon: '🛡️', cd: 18000 },
  magier:  { name: 'Meteor', icon: '☄️', cd: 16000 },
  schurke: { name: 'Klingentanz', icon: '🗡️', cd: 14000 },
  paladin: { name: 'Lichtwall', icon: '🔆', cd: 20000 },
  berserker: { name: 'Blutdurst', icon: '🧛', cd: 22000 }
};
function areaDamage(p, x, y, r, dmg) {
  if (!players[p.id] || p.dead) return;
  if (p.zone === 'arena') {
    for (const id in players) {
      const o = players[id];
      if (o.id === p.id || o.zone !== 'arena' || o.dead) continue;
      if (dist(x, y, o.x, o.y) < r + 12) applyPvpDamage(o, dmg, p);
    }
  } else {
    for (const id in monsters) {
      const m = monsters[id];
      if ((m.zone || DEFAULT_TIER_KEY) !== p.zone) continue;
      if (dist(x, y, m.x, m.y) < r + Math.max(12, monsterRadius(m))) hitMonster(m, dmg, p);
    }
  }
}
function useAbility2(p) {
  const ab = ABILITIES2[p.cls];
  if (!ab) return;
  const now = Date.now();
  if (now < (p.ability2ReadyAt || 0)) return;
  p.ability2ReadyAt = now + Math.round(ab.cd * (1 - 0.07 * ((p.skills && p.skills.cd) || 0)));
  const pw = 1 + 0.1 * ((p.skills && p.skills.power) || 0);
  revealSecrets(p);
  if (p.cls === 'krieger') {
    // Bollwerk: 5 s halber Schaden, sofort 15% Heilung
    p.guardUntil = now + 5000;
    p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.15));
    io.emit('abilityFx', { type: 'guard', x: p.x, y: p.y, r: 60, zone: p.zone, ms: 700 });
  } else if (p.cls === 'magier') {
    // Meteor: schlaegt nach 0,9 s an der Zielstelle ein
    let ax = p.input.aimX, ay = p.input.aimY;
    if (!ax && !ay) ax = 1;
    const len = Math.hypot(ax, ay), map = mapFor(p.zone);
    let reach = Math.max(120, Math.min(300, len)), tx = p.x, ty = p.y;
    for (; reach >= 0; reach -= 24) {
      const cx = p.x + (ax / len) * reach, cy = p.y + (ay / len) * reach;
      if (!map.isWall(Math.floor(cx / TILE), Math.floor(cy / TILE))) { tx = cx; ty = cy; break; }
    }
    const R = 95, dmg = Math.round(p.dmg * 3.2 * pw), delay = 900;
    io.emit('abilityFx', { type: 'meteor', x: tx, y: ty, r: R, zone: p.zone, ms: delay });
    setTimeout(() => { if (players[p.id]) areaDamage(p, tx, ty, R, dmg); }, delay);
  } else if (p.cls === 'schurke') {
    // Klingentanz: drei Schlaege rund um den Schurken
    const R = 78, dmg = Math.round(p.dmg * 1.1 * pw);
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        if (!players[p.id] || p.dead) return;
        io.emit('abilityFx', { type: 'blades', x: p.x, y: p.y, r: R, zone: p.zone, ms: 300 });
        areaDamage(p, p.x, p.y, R, dmg);
      }, i * 320);
    }
  } else if (p.cls === 'paladin') {
    // Lichtwall: 4 s halber Schaden, sofort 20% Heilung
    p.guardUntil = now + 4000;
    p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.2));
    io.emit('abilityFx', { type: 'guard', x: p.x, y: p.y, r: 60, zone: p.zone, ms: 700 });
  } else if (p.cls === 'berserker') {
    // Blutdurst: 6 s lang heilt jeder Nahkampftreffer 20% des Schadens
    p.lifestealUntil = now + 6000;
    p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.1));
    io.emit('abilityFx', { type: 'rage', x: p.x, y: p.y, r: 60, zone: p.zone, ms: 600 });
  }
}

// ---------------- Saison (monatlich) ----------------
const SEASON_TIERS = [
  { pts: 100,  name: 'Bronze',  gold: 500,   essence: 30,  item: 0 },
  { pts: 500,  name: 'Silber',  gold: 1500,  essence: 80,  item: 2 },
  { pts: 1500, name: 'Gold',    gold: 4000,  essence: 200, item: 3 },
  { pts: 4000, name: 'Diamant', gold: 10000, essence: 500, item: 3, extra: true }
];
function seasonId() { return new Date().toISOString().slice(0, 7); }
function seasonEndsAt() { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
// Beim Monatswechsel: Belohnung fuer die erreichte Stufe, dann Punkte auf 0
function checkSeason(p) {
  const cur = seasonId();
  if (!p.season || typeof p.season !== 'object') p.season = { id: '', points: 0 };
  if (p.season.id === cur) return false;
  const old = p.season;
  p.season = { id: cur, points: 0 };
  if (old.id && old.points >= SEASON_TIERS[0].pts) {
    let tier = SEASON_TIERS[0];
    for (const t of SEASON_TIERS) if (old.points >= t.pts) tier = t;
    p.gold += tier.gold; p.essence += tier.essence;
    if (tier.item) giveItem(p, genItem(p.level, tier.item));
    if (tier.extra) giveItem(p, genItem(p.level, 3));
    io.to(p.id).emit('seasonEnd', { id: old.id, points: old.points, tier: tier.name, gold: tier.gold, essence: tier.essence });
  }
  saveAccountProgress(p);
  return true;
}
function addSeasonPoints(p, n) {
  if (!p || !n) return;
  const pts = Math.round(n);
  checkSeason(p);
  p.season.points += pts;
  checkWeek(p);
  p.week.points += pts;
  guildGainXp(p, pts);
}
function guildGainXp(p, n) {
  if (!p.guild) return;
  const g = guildCache.get(p.guild);
  if (!g) return;
  g.xp = (g.xp || 0) + n;
  saveGuild(g);
}
function sendSeason(p) {
  io.to(p.id).emit('season', { id: p.season.id, points: p.season.points, endsAt: seasonEndsAt() });
}
setInterval(() => {
  for (const id in players) {
    const p = players[id];
    if (checkSeason(p)) sendSeason(p);
    if (checkWeek(p)) sendWeek(p);
  }
}, 5 * 60 * 1000);

// ---------------- Wochen-Challenge ----------------
function weekId() {
  const d = new Date();
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return date.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}
function weekEndsAt() {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (8 - day));
}
function checkWeek(p) {
  const cur = weekId();
  if (!p.week || typeof p.week !== 'object') p.week = { id: '', points: 0 };
  if (p.week.id === cur) return false;
  const old = p.week;
  p.week = { id: cur, points: 0 };
  if (old.id && old.points >= SEASON_TIERS[0].pts) {
    let tier = SEASON_TIERS[0];
    for (const t of SEASON_TIERS) if (old.points >= t.pts) tier = t;
    const gold = Math.round(tier.gold / 2), essence = Math.round(tier.essence / 2);
    p.gold += gold; p.essence += essence;
    if (tier.item) giveItem(p, genItem(p.level, tier.item));
    io.to(p.id).emit('weekEnd', { id: old.id, points: old.points, tier: tier.name, gold, essence });
  }
  saveAccountProgress(p);
  return true;
}
function sendWeek(p) {
  io.to(p.id).emit('week', { id: p.week.id, points: p.week.points, endsAt: weekEndsAt() });
}

// ---------------- Welt-Boss (Raid) ----------------
const raid = { active: false, bossId: null, endsAt: 0, nextAt: Date.now() + 6 * 60 * 1000, warned: false, joined: new Set(), deaths: {}, perPlayerHp: 0 };

function creditRaid(m, p, dmg) {
  if (!m.dmgBy || !p || !p.username) return;
  m.dmgBy[p.username] = (m.dmgBy[p.username] || 0) + dmg;
}
function startRaid() {
  if (raid.active) return false;
  let sum = 0, cnt = 0;
  for (const pid in players) { sum += players[pid].level; cnt++; }
  const bMult = Math.min(5, Math.max(1, 1 + ((cnt ? sum / cnt : 10) - 8) * 0.12));
  const id = 'raid' + (monsterIdCounter++), baseHp = Math.round(3000 * bMult);
  monsters[id] = {
    id, type: 'raidboss', zone: 'raid', raid: true, dmgBy: {}, mult: bMult, dmgMult: Math.pow(bMult, 0.65),
    name: 'Weltenfresser', x: RAID_CENTER.x, y: RAID_CENTER.y, hp: baseHp, maxHp: baseHp,
    lastAttack: 0, targetId: null, homeX: RAID_CENTER.x, homeY: RAID_CENTER.y
  };
  raid.active = true; raid.bossId = id; raid.endsAt = Date.now() + RAID_DURATION_MS;
  raid.joined = new Set(); raid.deaths = {}; raid.warned = false; raid.perPlayerHp = Math.round(2500 * bMult);
  io.emit('announcement', `🐉 Der Weltenfresser ist erschienen! Menü → Raid & Saison → „Raid beitreten“ (ab Level ${RAID_MIN_LEVEL}). ${RAID_DURATION_MS / 60000} Minuten Zeit!`);
  return true;
}
function evacuateRaid() {
  if (raid.active) return;
  for (const id in players) {
    const p = players[id];
    if (p.zone !== 'raid') continue;
    p.zone = tierForLevel(p.level);
    const sp = randomTierSpawn(p.zone);
    p.x = sp.x; p.y = sp.y; p.hp = p.maxHp; p.dead = false; p.fx = {};
  }
  for (const id in items) if (items[id].zone === 'raid') delete items[id];
}
function onRaidBossKilled(m, killer) {
  const entries = Object.entries(m.dmgBy || {}).filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, e) => sum + e[1], 0) || 1;
  const nameOf = (u) => { const o = findOnline(u); return o ? o.name : u; };
  entries.forEach(([username, dmg], idx) => {
    const c = findOnline(username);
    if (!c) return;
    const share = dmg / total, rank = idx + 1;
    const gold = Math.round((250 + c.level * 25) * (1 + 3 * share) * goldMult() * goldBonus(c));
    const ess = 20 + Math.round(60 * share), pts = 60 + Math.round(300 * share);
    c.gold += gold; c.essence += ess; c.potions += 2;
    c.stats.goldEarned += gold; c.stats.raidKills++; c.stats.bossKills++;
    giveKey(c, 2);
    if (rank === 1) giveItem(c, genItem(c.level, Math.random() < 0.6 ? 3 : 2));
    else if (rank <= 3) giveItem(c, genItem(c.level, Math.max(2, rollRarity(2 + luckOf(c)))));
    else if (share >= 0.05) giveItem(c, genItem(c.level, Math.max(1, rollRarity(1.5 + luckOf(c)))));
    questProgress(c, 'kill', 1, 'boss');
    questProgress(c, 'gold', gold);
    addSeasonPoints(c, pts);
    checkAchievements(c);
    saveAccountProgress(c);
    io.to(c.id).emit('raidResult', { win: true, rank, share: Math.round(share * 100), gold, essence: ess, points: pts });
  });
  const medals = ['🥇', '🥈', '🥉'];
  const top = entries.slice(0, 3).map((e, i) => `${medals[i]} ${nameOf(e[0])}`).join('  ');
  io.emit('announcement', `🏆 Der Weltenfresser ist besiegt! ${top}`);
  removeBoss(m.id);
  raid.active = false; raid.nextAt = Date.now() + RAID_INTERVAL_MS; raid.warned = false;
  setTimeout(evacuateRaid, 25000);
}
function raidFailed(m) {
  for (const [u, dmg] of Object.entries(m.dmgBy || {})) {
    const c = findOnline(u);
    if (!c || dmg <= 0) continue;
    const gold = 100 + c.level * 10;
    c.gold += gold; c.essence += 10;
    addSeasonPoints(c, 15);
    saveAccountProgress(c);
    io.to(c.id).emit('raidResult', { win: false, gold, essence: 10, points: 15 });
  }
  removeBoss(m.id);
  raid.active = false; raid.nextAt = Date.now() + RAID_INTERVAL_MS; raid.warned = false;
  io.emit('announcement', '🐉 Der Weltenfresser ist in die Tiefe zurückgekehrt ... Die Zeit war zu knapp.');
  setTimeout(evacuateRaid, 8000);
}
setInterval(() => {
  const now = Date.now();
  if (!raid.active) {
    if (now >= raid.nextAt) {
      if (Object.keys(players).length) startRaid(); else raid.nextAt = now + 60000;
    } else if (!raid.warned && raid.nextAt - now < 60000 && Object.keys(players).length) {
      raid.warned = true;
      io.emit('announcement', '🐉 In 1 Minute erscheint der Weltenfresser! Macht euch bereit (Menü → Raid & Saison).');
    }
    return;
  }
  const m = monsters[raid.bossId];
  if (!m) { raid.active = false; raid.nextAt = now + RAID_INTERVAL_MS; raid.warned = false; return; }
  if (now >= raid.endsAt) raidFailed(m);
}, 2000);

const META = {
  prestigeMin: PRESTIGE_MIN_LEVEL, prestigeMax: PRESTIGE_MAX, classChangeCost: CLASS_CHANGE_COST,
  raidMinLevel: RAID_MIN_LEVEL, raidMaxDeaths: RAID_MAX_DEATHS,
  trap: { cycle: TRAP_CYCLE, warnFrom: TRAP_WARN_FROM, activeFrom: TRAP_ACTIVE_FROM },
  seasonTiers: SEASON_TIERS
};

function applyPvpDamage(target, dmg, attacker) {
  if (target.guardUntil && target.guardUntil > Date.now()) dmg = Math.round(dmg * 0.5);
  target.hp -= dmg;
  io.emit('hit', { x: target.x, y: target.y, dmg });
  if (target.hp <= 0 && !target.dead) {
    target.dead = true;
    target.deadBy = attacker && attacker !== target ? attacker.name : 'einem Spieler';
    io.to(target.id).emit('died', { by: target.deadBy });
    setTimeout(() => respawnPlayer(target), 2000);
    if (attacker && attacker !== target) { attacker.stats.pvpKills++; addSeasonPoints(attacker, 5); questProgress(attacker, 'pvp', 1); checkAchievements(attacker); }
    if (target.duelWith) resolveDuel(target, attacker);
  }
}

function resolveDuel(loser, winner) {
  const w = winner && winner.id === loser.duelWith ? winner : players[loser.duelWith];
  loser.duelWith = null;
  if (!w) return;
  w.duelWith = null;
  const bonus = 100 + loser.level * 15;
  w.gold += bonus;
  grantXp(w, 150 + loser.level * 20);
  io.emit('announcement', `⚔️ ${w.name} hat ${loser.name} im Duell besiegt!`);
  notice(w, `🏆 Duell gewonnen! +${bonus} Gold`);
  notice(loser, '💀 Duell verloren.');
}

function respawnPlayer(p) {
  let sp;
  if (p.zone === 'arena') {
    sp = ARENA_SPAWN;
  } else if (p.zone === 'bossroom') {
    sp = BOSSROOM_ENTRY;
  } else if (p.zone === 'raid') {
    raid.deaths[p.username] = (raid.deaths[p.username] || 0) + 1;
    if (raid.active && raid.deaths[p.username] <= RAID_MAX_DEATHS) {
      sp = RAID_ENTRY;
    } else {
      notice(p, raid.active ? '💀 Zu oft gefallen: Du musst den Raid verlassen.' : 'Der Raid ist vorbei.');
      p.zone = tierForLevel(p.level);
      sp = randomTierSpawn(p.zone);
    }
  } else if (p.zone === 'town') {
    sp = TOWN_SPAWN;
  } else {
    // Beim Respawn automatisch in die zum aktuellen Level passende Stufe wechseln
    p.zone = tierForLevel(p.level);
    sp = randomTierSpawn(p.zone);
  }
  p.x = sp.x;
  p.y = sp.y;
  p.hp = isDungeonTier(p.zone) ? Math.max(1, Math.floor(p.maxHp * 0.5)) : p.maxHp;
  p.fx = {};
  p.deadBy = null;
  p.dead = false;
}

function levelUp(p) {
  p.level += 1;
  p.xp -= p.xpNext;
  p.xpNext = xpToNextLevel(p.level);
  recomputeStats(p);
  p.hp = p.maxHp;
  saveAccountProgress(p);
  checkAchievements(p);
  sendProfile(p);
}

function grantXp(p, amount) {
  p.xp += Math.round(amount * xpMult() * (1 + 0.10 * (p.prestige || 0)));
  while (p.xp >= p.xpNext) levelUp(p);
}

// ---------------- Boss-Zyklus (alle 10 Minuten) ----------------
const BOSS_INTERVAL_MS = 10 * 60 * 1000;
let bossId = null;
function spawnBoss() {
  const id = 'boss' + (monsterIdCounter++);
  // Boss-Staerke richtet sich nach dem Durchschnitts-Level aller Online-Spieler (max. 4-fach)
  let sum = 0, cnt = 0;
  for (const pid in players) { sum += players[pid].level; cnt++; }
  const avgLevel = cnt ? sum / cnt : 1;
  const bMult = Math.min(4, Math.max(1, 1 + (avgLevel - 8) * 0.12));
  monsters[id] = {
    id, type: 'boss', zone: 'bossroom', mult: bMult, dmgMult: Math.pow(bMult, 0.65), name: MONSTER_TYPES.boss.name,
    x: BOSSROOM_CENTER.x,
    y: BOSSROOM_CENTER.y,
    hp: Math.round(MONSTER_TYPES.boss.hp * bMult), maxHp: Math.round(MONSTER_TYPES.boss.hp * bMult),
    lastAttack: 0, targetId: null,
    homeX: BOSSROOM_CENTER.x, homeY: BOSSROOM_CENTER.y
  };
  bossId = id;
  io.emit('announcement', `👑 Der ${MONSTER_TYPES.boss.name} ist im Boss-Raum erschienen! Teleportiere dich über das Menü dorthin!`);
}
function bossCycle() {
  if (bossId && monsters[bossId]) removeBoss(bossId);
  spawnBoss();
}
setTimeout(() => {
  bossCycle();
  setInterval(bossCycle, BOSS_INTERVAL_MS);
}, 45000); // erster Boss 45s nach Serverstart, danach alle 10 Minuten

function onMonsterKilled(m, killer) {
  const zone = m.zone || DEFAULT_TIER_KEY;
  if (m.type === 'raidboss') { onRaidBossKilled(m, killer); return; }
  if (m.type === 'boss') {
    if (m.id === bossId) bossId = null;
    if (tierBosses[zone] === m.id) delete tierBosses[zone];
    for (const mid in monsters) if (monsters[mid].ownerId === m.id) delete monsters[mid];
    for (let i = 0; i < 4; i++) spawnItem(m.x + (Math.random() * 40 - 20), m.y + (Math.random() * 40 - 20), zone);
    if (killer) killer.potions += 2;
    if (killer && isDungeonTier(zone)) giveKey(killer, 1);
    io.emit('announcement', `🏆 ${killer ? killer.name : 'Jemand'} hat ${m.name || 'den Boss'} besiegt! Riesiger Loot-Regen!`);
    if (killer && isDungeonTier(zone) && m.spawnAt) {
      const secs = Math.max(1, Math.round((Date.now() - m.spawnAt) / 1000));
      const bb = killer.bossBest || (killer.bossBest = {});
      if (!bb[zone] || secs < bb[zone]) {
        bb[zone] = secs;
        saveAccountProgress(killer);
        notice(killer, `⏱️ Neuer Boss-Rekord in ${(DUNGEON_TIERS[zone] || {}).name || zone}: ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}!`);
      }
    }
  } else if (m.type === 'treasure') {
    for (let i = 0; i < 10; i++) {
      const it = spawnItem(m.x + (Math.random() * 60 - 30), m.y + (Math.random() * 60 - 30), zone, 'gold');
      it.amount *= 4;
    }
    io.emit('announcement', `💰 ${killer ? killer.name : 'Jemand'} hat den Schatzgoblin erwischt!`);
  } else {
    spawnItem(m.x, m.y, zone);
    if (killer && isDungeonTier(zone) && Math.random() < KEY_DROP_MONSTER) giveKey(killer, 1);
  }
  if (killer) {
    const xpAmount = Math.round(MONSTER_TYPES[m.type].xp * Math.pow(m.mult || 1, 0.8) * (1 + guildBonus(killer)));
    const essAmount = m.type === 'boss' ? 25 : Math.max(1, Math.round(Math.pow(m.mult || 1, 0.7)));
    grantXp(killer, xpAmount);
    killer.stats.kills++;
    if (m.type === 'boss') { killer.stats.bossKills++; addSeasonPoints(killer, 15); }
    killer.essence += essAmount;
    shareWithParty(killer, m, xpAmount, essAmount);
    dropGear(killer, m);
    questProgress(killer, 'kill', 1, m.type);
    checkAchievements(killer);
  }
}

// ---------------- Klassen-Faehigkeiten (Taste Q) ----------------
const ABILITIES = {
  krieger: { name: 'Wirbelschlag', icon: '🌀', cd: 8000 },
  magier:  { name: 'Feuernova', icon: '🔥', cd: 10000 },
  schurke: { name: 'Schattenschritt', icon: '👤', cd: 7000 },
  paladin: { name: 'Heiliger Ruf', icon: '✨', cd: 9000 },
  berserker: { name: 'Blutrausch', icon: '🩸', cd: 14000 }
};

function rollDamage(p, def) {
  let dmg = p.dmg;
  if (p.rageUntil && Date.now() < p.rageUntil) dmg = Math.round(dmg * 1.4);
  const cc = (def.crit || 0) + (p.critBonus || 0);
  if (cc > 0 && Math.random() < cc) dmg *= 2;
  if (p.critUntil && Date.now() < p.critUntil) { dmg *= 2; p.critUntil = 0; }
  return dmg;
}

function hitMonster(m, dmg, killer) {
  m.hp -= dmg;
  if (m.raid && killer) creditRaid(m, killer, dmg);
  io.emit('hit', { x: m.x, y: m.y, dmg });
  if (m.hp <= 0 && monsters[m.id]) {
    onMonsterKilled(m, killer);
    delete monsters[m.id];
  }
}

function useAbility(p) {
  const ab = ABILITIES[p.cls];
  if (!ab) return;
  const now = Date.now();
  if (now < (p.abilityReadyAt || 0)) return;
  p.abilityReadyAt = now + Math.round(ab.cd * (1 - 0.07 * ((p.skills && p.skills.cd) || 0)));
  const pw = 1 + 0.1 * ((p.skills && p.skills.power) || 0);

  if (p.cls === 'krieger') {
    // Wirbelschlag: Schaden an allen Gegnern im Umkreis
    const R = 100, dmg = Math.round(p.dmg * 1.6 * pw);
    if (p.zone === 'arena') {
      for (const id in players) {
        const o = players[id];
        if (o.id === p.id || o.zone !== 'arena' || o.dead) continue;
        if (dist(p.x, p.y, o.x, o.y) < R + 12) applyPvpDamage(o, dmg, p);
      }
    } else {
      for (const id in monsters) {
        const m = monsters[id];
        if ((m.zone || DEFAULT_TIER_KEY) !== p.zone) continue;
        if (dist(p.x, p.y, m.x, m.y) < R + Math.max(12, monsterRadius(m))) hitMonster(m, dmg, p);
      }
    }
    io.emit('abilityFx', { type: 'whirl', x: p.x, y: p.y, r: R, zone: p.zone });
  } else if (p.cls === 'magier') {
    // Feuernova: Ring aus 12 Geschossen
    const dmg = Math.round(p.dmg * 0.9 * pw);
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI * 2) / 12;
      const id = 'pr' + (projectileIdCounter++);
      projectiles[id] = { id, ownerId: p.id, zone: p.zone, x: p.x, y: p.y, vx: Math.cos(a) * 6, vy: Math.sin(a) * 6, dmg, life: 40 };
    }
    io.emit('abilityFx', { type: 'nova', x: p.x, y: p.y, r: 240, zone: p.zone });
  } else if (p.cls === 'schurke') {
    // Schattenschritt: Sprung in Zielrichtung, naechster Nahkampfangriff ist ein sicherer Krit
    const ang = Math.atan2(p.input.aimY, p.input.aimX);
    const sx = p.x, sy = p.y;
    for (let i = 0; i < 15; i++) tryMove(mapFor(p.zone), p, Math.cos(ang) * 10, Math.sin(ang) * 10, 12);
    p.critUntil = now + 4000;
    io.emit('abilityFx', { type: 'dash', x: sx, y: sy, x2: p.x, y2: p.y, zone: p.zone });
  } else if (p.cls === 'paladin') {
    // Heiliger Ruf: heilt sich zu 25% und trifft Gegner im Umkreis mit hellem Schlag
    p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.25));
    areaDamage(p, p.x, p.y, 100, Math.round(p.dmg * 1.2 * pw));
    io.emit('abilityFx', { type: 'nova', x: p.x, y: p.y, r: 100, zone: p.zone });
  } else if (p.cls === 'berserker') {
    // Blutrausch: opfert 20% max. LP fuer 6 s +40% Schaden
    const cost = Math.round(p.maxHp * 0.2);
    if (p.hp <= cost + 1) return notice(p, 'Dein Blut reicht nicht für den Blutrausch.');
    p.hp -= cost;
    p.rageUntil = now + 6000;
    io.emit('abilityFx', { type: 'rage', x: p.x, y: p.y, r: 70, zone: p.zone, ms: 600 });
  }
}

// ---------------- Quests ----------------
const MONSTER_NAMES_PL = { goblin: 'Goblins', ork: 'Orks', slime: 'Schleime', bat: 'Fledermäuse', skeleton: 'Skelette', troll: 'Trolle', demon: 'Dämonen', archer: 'Bogenschützen', caster: 'Hexer', spitter: 'Säurespucker', obsidianKnight: 'Obsidianritter', voidStalker: 'Nichtshetzer', doomHerald: 'Unheilboten', sensenmann: 'Sensenmänner' };
const QUEST_TYPES = ['kill', 'killType', 'chest', 'gold', 'boss', 'pvp'];
const QUEST_COUNT = 3;

function makeQuest(p, existing) {
  const tier = DUNGEON_TIERS[tierForLevel(p.level)] || DUNGEON_TIERS[DEFAULT_TIER_KEY];
  const lm = tier.lootMult, xm = Math.pow(tier.monsterMult, 0.8);
  const r = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const taken = new Set((existing || []).map(q => q.type + ':' + (q.sub || '')));
  let q;
  for (let attempt = 0; attempt < 12; attempt++) {
    const roll = Math.random();
    if (roll < 0.28) {
      const n = r(10, 20);
      q = { type: 'kill', target: n, text: `Besiege ${n} Monster`, gold: Math.round(n * 6 * lm), xp: Math.round(n * 6 * xm), potions: 0 };
    } else if (roll < 0.55) {
      const t = pickMonsterType(tier.pool), n = r(6, 12);
      q = { type: 'killType', sub: t, target: n, text: `Besiege ${n} ${MONSTER_NAMES_PL[t] || t}`, gold: Math.round(n * 9 * lm), xp: Math.round(MONSTER_TYPES[t].xp * n * xm * 0.7), potions: 0 };
    } else if (roll < 0.70) {
      const n = r(2, 4);
      q = { type: 'chest', target: n, text: `Öffne ${n} Truhen`, gold: Math.round(n * 35 * lm), xp: Math.round(n * 40 * xm), potions: 1 };
    } else if (roll < 0.85) {
      const n = Math.round(r(150, 300) * lm);
      q = { type: 'gold', target: n, text: `Sammle ${n} Gold`, gold: Math.round(n * 0.4), xp: Math.round(n * 0.8 * xm), potions: 1 };
    } else if (roll < 0.93) {
      q = { type: 'boss', target: 1, text: 'Besiege den Dungeon-Wächter', gold: Math.round(300 * lm), xp: Math.round(300 * xm), potions: 3 };
    } else {
      const n = r(2, 3);
      q = { type: 'pvp', target: n, text: `Besiege ${n} Spieler in der Arena`, gold: Math.round(n * 80 * lm), xp: Math.round(n * 60 * xm), potions: 1 };
    }
    if (!taken.has(q.type + ':' + (q.sub || ''))) break;
  }
  q.id = 'q' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
  q.progress = 0;
  return q;
}

function sanitizeQuests(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(q => q && QUEST_TYPES.includes(q.type) && Number.isFinite(q.target) && q.target > 0 && Number.isFinite(q.progress) && typeof q.text === 'string')
    .slice(0, QUEST_COUNT)
    .map(q => ({
      id: String(q.id || ''), type: q.type, sub: q.sub ? String(q.sub) : undefined, target: q.target,
      progress: Math.min(q.progress, q.target), text: q.text.slice(0, 80),
      gold: Number(q.gold) || 0, xp: Number(q.xp) || 0, potions: Number(q.potions) || 0
    }));
}

function ensureQuests(p) {
  if (!Array.isArray(p.quests)) p.quests = [];
  while (p.quests.length < QUEST_COUNT) p.quests.push(makeQuest(p, p.quests));
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function sanitizeDailyQuest(q) {
  if (!q || typeof q !== 'object') return null;
  if (q.done === true) return { done: true, day: typeof q.day === 'string' ? q.day.slice(0, 10) : '' };
  if (!QUEST_TYPES.includes(q.type) || !Number.isFinite(q.target) || q.target <= 0 || typeof q.text !== 'string') return null;
  return {
    id: String(q.id || ''), type: q.type, sub: q.sub ? String(q.sub) : undefined, target: q.target,
    progress: Math.min(Math.max(0, Number(q.progress) || 0), q.target), text: q.text.slice(0, 80),
    gold: Math.max(0, Number(q.gold) || 0), xp: Math.max(0, Number(q.xp) || 0), potions: Math.max(0, Number(q.potions) || 0),
    day: typeof q.day === 'string' ? q.day.slice(0, 10) : '', daily: true
  };
}

function makeDailyQuest(p) {
  const existing = [...(p.quests || []), ...(p.dailyQuest && p.dailyQuest.daily ? [p.dailyQuest] : [])];
  const q = makeQuest(p, existing);
  q.gold = Math.round(q.gold * 1.5);
  q.xp = Math.round(q.xp * 1.5);
  q.potions = (q.potions || 0) + 1;
  q.day = todayStr();
  q.daily = true;
  return q;
}

function ensureDailyQuest(p) {
  const today = todayStr();
  if (p.dailyQuest && p.dailyQuest.day === today) return;
  p.dailyQuest = makeDailyQuest(p);
}

function completeDailyQuest(p) {
  const q = p.dailyQuest;
  addSeasonPoints(p, 12);
  p.gold += q.gold;
  p.potions += q.potions;
  p.essence += 10;
  grantXp(p, q.xp);
  p.stats.questsDone++;
  checkAchievements(p);
  p.dailyQuest = { done: true, day: q.day };
  io.to(p.id).emit('questDone', { text: '⭐ ' + q.text, gold: q.gold, xp: q.xp, potions: q.potions });
  saveAccountProgress(p);
}

function sendQuests(p) {
  io.to(p.id).emit('quests', p.quests.concat(p.dailyQuest && p.dailyQuest.daily ? [p.dailyQuest] : []));
}

function completeQuest(p, i) {
  const q = p.quests[i];
  addSeasonPoints(p, 8);
  p.gold += q.gold;
  p.potions += q.potions;
  grantXp(p, q.xp);
  p.stats.questsDone++;
  checkAchievements(p);
  p.quests[i] = makeQuest(p, p.quests.filter((_, j) => j !== i));
  io.to(p.id).emit('questDone', { text: q.text, gold: q.gold, xp: q.xp, potions: q.potions });
  saveAccountProgress(p);
}

function questProgress(p, event, amount, sub) {
  if (!p || !Array.isArray(p.quests)) return;
  let changed = false;
  for (let i = 0; i < p.quests.length; i++) {
    const q = p.quests[i];
    let match;
    if (event === 'kill') match = q.type === 'kill' || (q.type === 'killType' && q.sub === sub) || (q.type === 'boss' && sub === 'boss');
    else match = q.type === event;
    if (!match) continue;
    q.progress = Math.min(q.target, q.progress + amount);
    changed = true;
    if (q.progress >= q.target) completeQuest(p, i);
  }
  const dq = p.dailyQuest;
  if (dq && dq.daily && dq.progress < dq.target) {
    let match;
    if (event === 'kill') match = dq.type === 'kill' || (dq.type === 'killType' && dq.sub === sub) || (dq.type === 'boss' && sub === 'boss');
    else match = dq.type === event;
    if (match) {
      dq.progress = Math.min(dq.target, dq.progress + amount);
      changed = true;
      if (dq.progress >= dq.target) completeDailyQuest(p);
    }
  }
  if (changed) sendQuests(p);
}

// ---------------- Fortschritt: Ausruestung, Fertigkeiten, Handwerk, Erfolge ----------------
const INVENTORY_MAX = 30;
const STORAGE_MAX = 60;
const UPGRADE_MAX = 5;
const SLOTS = ['weapon', 'armor', 'ring'];
const RARITIES = [
  { name: 'Gewöhnlich', mult: 1, sell: 10 },
  { name: 'Selten', mult: 1.5, sell: 30 },
  { name: 'Episch', mult: 2.2, sell: 90 },
  { name: 'Legendär', mult: 3.2, sell: 300 }
];
const ITEM_NAMES = {
  weapon: ['Schwert', 'Axt', 'Dolch', 'Stab', 'Speer'],
  armor: ['Lederharnisch', 'Kettenhemd', 'Plattenpanzer', 'Robe'],
  ring: ['Eilring', 'Jägerring', 'Siegelring']
};
const ITEM_SUFFIX = ['der Glut', 'des Frosts', 'der Nacht', 'des Bären', 'der Eile', 'des Drachen', 'der Ahnen'];
const SKILL_DEFS = {
  cd:    { name: 'Schnelle Erholung', desc: '−7% Abklingzeit der Klassenfähigkeit', max: 5 },
  power: { name: 'Kampfkunst', desc: '+10% Schaden der Klassenfähigkeit', max: 5 },
  vit:   { name: 'Zähigkeit', desc: '+4% maximale Lebenspunkte', max: 5 },
  greed: { name: 'Goldnase', desc: '+6% Gold aus Monstern und Truhen', max: 5 }
};
const RECIPES = {
  heal3:  { name: '3 Heiltränke', essence: 6, give: { potions: 3 } },
  heal5:  { name: '5 Heiltränke', essence: 10, give: { potions: 5 } },
  speed2: { name: '2 Tempo-Tränke', essence: 8, give: { speedPotions: 2 } },
  speed3: { name: '3 Tempo-Tränke', essence: 12, give: { speedPotions: 3 } }
};
const ACHIEVEMENTS = [
  { id: 'k100', name: 'Monsterjäger I', desc: '100 Monster besiegen', stat: 'kills', thr: 100, gold: 100 },
  { id: 'k1000', name: 'Monsterjäger II', desc: '1000 Monster besiegen', stat: 'kills', thr: 1000, gold: 500 },
  { id: 'k10000', name: 'Monsterjäger III', desc: '10000 Monster besiegen', stat: 'kills', thr: 10000, gold: 3000 },
  { id: 'b1', name: 'Bossbezwinger I', desc: '1 Boss besiegen', stat: 'bossKills', thr: 1, gold: 200 },
  { id: 'b10', name: 'Bossbezwinger II', desc: '10 Bosse besiegen', stat: 'bossKills', thr: 10, gold: 1000 },
  { id: 'b50', name: 'Bossbezwinger III', desc: '50 Bosse besiegen', stat: 'bossKills', thr: 50, gold: 5000 },
  { id: 'p1', name: 'Gladiator I', desc: '1 Spieler in der Arena besiegen', stat: 'pvpKills', thr: 1, gold: 100 },
  { id: 'p10', name: 'Gladiator II', desc: '10 Spieler in der Arena besiegen', stat: 'pvpKills', thr: 10, gold: 800 },
  { id: 'p50', name: 'Gladiator III', desc: '50 Spieler in der Arena besiegen', stat: 'pvpKills', thr: 50, gold: 4000 },
  { id: 'c10', name: 'Schatzsucher I', desc: '10 Truhen öffnen', stat: 'chests', thr: 10, gold: 100 },
  { id: 'c100', name: 'Schatzsucher II', desc: '100 Truhen öffnen', stat: 'chests', thr: 100, gold: 1000 },
  { id: 'q10', name: 'Auftragsheld I', desc: '10 Quests erledigen', stat: 'questsDone', thr: 10, gold: 150 },
  { id: 'q50', name: 'Auftragsheld II', desc: '50 Quests erledigen', stat: 'questsDone', thr: 50, gold: 1000 },
  { id: 'g5k', name: 'Wohlhabend', desc: '5000 Gold verdienen', stat: 'goldEarned', thr: 5000, gold: 200 },
  { id: 'g50k', name: 'Reich', desc: '50000 Gold verdienen', stat: 'goldEarned', thr: 50000, gold: 2000 },
  { id: 'l10', name: 'Level 10', desc: 'Level 10 erreichen', stat: 'level', thr: 10, gold: 100 },
  { id: 'l25', name: 'Level 25', desc: 'Level 25 erreichen', stat: 'level', thr: 25, gold: 500 },
  { id: 'l50', name: 'Level 50', desc: 'Level 50 erreichen', stat: 'level', thr: 50, gold: 3000 },
  { id: 'v3', name: 'Tresorknacker', desc: '3 Tresore öffnen', stat: 'vaults', thr: 3, gold: 500 },
  { id: 's1', name: 'Spürnase', desc: '1 Geheimraum entdecken', stat: 'secrets', thr: 1, gold: 300 },
  { id: 'r1', name: 'Weltenfresser-Jäger', desc: '1 Raid-Boss besiegen', stat: 'raidKills', thr: 1, gold: 1500 },
  { id: 'r10', name: 'Raid-Veteran', desc: '10 Raid-Bosse besiegen', stat: 'raidKills', thr: 10, gold: 8000 },
  { id: 'pr1', name: 'Wiedergeboren', desc: 'Die Wiedergeburt abschließen', stat: 'prestige', thr: 1, gold: 2000 },
  { id: 'l75', name: 'Hochburgbezwinger', desc: 'Level 75 erreichen', stat: 'level', thr: 75, gold: 6000 },
  { id: 'k25000', name: 'Vernichter', desc: '25000 Monster besiegen', stat: 'kills', thr: 25000, gold: 12000 },
  { id: 'b100', name: 'Legendärer Jäger', desc: '100 Bosse besiegen', stat: 'bossKills', thr: 100, gold: 15000 },
  { id: 'c250', name: 'Kistenkönig', desc: '250 Truhen öffnen', stat: 'chests', thr: 250, gold: 5000 },
  { id: 'g200k', name: 'Millionär', desc: '200000 Gold verdienen', stat: 'goldEarned', thr: 200000, gold: 8000 },
  { id: 's5', name: 'Geheimnisjäger', desc: '5 Geheimräume entdecken', stat: 'secrets', thr: 5, gold: 1500 },
  { id: 'v6', name: 'Bankknacker', desc: '6 Tresore öffnen', stat: 'vaults', thr: 6, gold: 1200 },
  { id: 'd50', name: 'Organisiert', desc: '50 Dinge im Depot einlagern', stat: 'deposits', thr: 50, gold: 400 }
];
const ACH_IDS = new Set(ACHIEVEMENTS.map(a => a.id));
const COSMETICS = {
  color: {
    gold:   { name: 'Gold', hex: '#ffd166', price: 150 },
    red:    { name: 'Rot', hex: '#ff5d5d', price: 150 },
    blue:   { name: 'Blau', hex: '#5da9ff', price: 150 },
    green:  { name: 'Grün', hex: '#5dff8a', price: 150 },
    violet: { name: 'Violett', hex: '#b48cff', price: 150 },
    pink:   { name: 'Pink', hex: '#ff7ad9', price: 150 },
    white:  { name: 'Weiss', hex: '#f2f2f2', price: 150 },
    orange: { name: 'Orange', hex: '#ff9f43', price: 150 },
    cyan:   { name: 'Cyan', hex: '#3fd2ff', price: 150 },
    silver: { name: 'Silber', hex: '#cfd6e6', price: 200 },
    lava:   { name: 'Lava', hex: '#ff6a00', price: 250 },
    toxic:  { name: 'Toxisch', hex: '#b6ff3c', price: 250 }
  },
  hat: {
    cap:     { name: 'Mütze', icon: '🧢', price: 200 },
    helmet:  { name: 'Helm', icon: '⛑️', price: 250 },
    tophat:  { name: 'Zylinder', icon: '🎩', price: 300 },
    grad:    { name: 'Doktorhut', icon: '🎓', price: 300 },
    devil:   { name: 'Teufel', icon: '😈', price: 400 },
    crown:   { name: 'Krone', icon: '👑', price: 600 },
    wizard:  { name: 'Zauberer', icon: '🧙', price: 350 },
    vampire: { name: 'Vampir', icon: '🧛', price: 450 },
    cowboy:  { name: 'Cowboy', icon: '🤠', price: 300 },
    pumpkin: { name: 'Kürbis', icon: '🎃', price: 300 },
    halo:    { name: 'Heiligenschein', icon: '😇', price: 250 },
    crown2:  { name: 'Goldene Krone', icon: '💛', price: 800 },
    wizard2: { name: 'Runehut', icon: '🔮', price: 500 }
  }
};
const PETS = {
  wolf: { name: 'Wolf', icon: '🐺', cost: 400, cd: 1100 },
  cat:  { name: 'Katze', icon: '🐱', cost: 900, cd: 800 }
};
const SKILL_RESET_COST = 200;
const CLIENT_DEFS = {
  rarities: RARITIES, skills: SKILL_DEFS, achievements: ACHIEVEMENTS, cosmetics: COSMETICS, recipes: RECIPES,
  inventoryMax: INVENTORY_MAX, upgradeMax: UPGRADE_MAX, pets: PETS, resetCost: SKILL_RESET_COST
};

function newItemId() { return 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
function rollRarity(boost) {
  const r = Math.pow(Math.random(), 1 + (boost || 0));
  if (r < 0.01) return 3;
  if (r < 0.08) return 2;
  if (r < 0.30) return 1;
  return 0;
}
function genItem(level, rarity, slot) {
  slot = slot || SLOTS[Math.floor(Math.random() * SLOTS.length)];
  const rm = RARITIES[rarity].mult;
  const names = ITEM_NAMES[slot];
  let name = names[Math.floor(Math.random() * names.length)];
  if (rarity > 0) name += ' ' + ITEM_SUFFIX[Math.floor(Math.random() * ITEM_SUFFIX.length)];
  const base = {};
  if (slot === 'weapon') base.dmg = Math.max(1, Math.round((2 + level * 0.45) * rm));
  else if (slot === 'armor') base.hp = Math.max(5, Math.round((10 + level * 2.6) * rm));
  else if (Math.random() < 0.5) base.speed = +(0.04 * rm + Math.random() * 0.03).toFixed(2);
  else base.crit = +(0.02 * rm).toFixed(3);
  return { id: newItemId(), slot, rarity, name, level, up: 0, base };
}
function effStats(it) {
  const f = 1 + 0.15 * it.up, e = {};
  if (it.base.dmg) e.dmg = Math.round(it.base.dmg * f);
  if (it.base.hp) e.hp = Math.round(it.base.hp * f);
  if (it.base.speed) e.speed = +(it.base.speed * f).toFixed(2);
  if (it.base.crit) e.crit = +(it.base.crit * f).toFixed(3);
  return e;
}
function sellValue(it) { return Math.round(RARITIES[it.rarity].sell * (1 + it.level * 0.05) * (1 + it.up * 0.5)); }
function upgradeCost(it) { return { essence: 5 * (it.up + 1) * (it.rarity + 1), gold: 40 * (it.up + 1) * (it.rarity + 1) }; }
function withEff(it) { return it ? { ...it, e: effStats(it), sell: sellValue(it), up$: it.up < UPGRADE_MAX ? upgradeCost(it) : null } : null; }
function equipmentBonus(p) {
  const b = { dmg: 0, hp: 0, speed: 0, crit: 0 };
  if (!p.equipment) return b;
  for (const slot of SLOTS) {
    const it = p.equipment[slot];
    if (!it) continue;
    const e = effStats(it);
    b.dmg += e.dmg || 0; b.hp += e.hp || 0; b.speed += e.speed || 0; b.crit += e.crit || 0;
  }
  return b;
}
function goldBonus(p) { return 1 + 0.06 * ((p.skills && p.skills.greed) || 0); }
function luckOf(p) { return 0.35 * ((p && p.upgLuck) || 0); }
function skillPointsFree(p) {
  let spent = 0;
  for (const k in SKILL_DEFS) spent += (p.skills && p.skills[k]) || 0;
  return Math.max(0, (p.level - 1) - spent);
}
function notice(p, text) { io.to(p.id).emit('notice', text); }

function sanitizeItem(it) {
  if (!it || typeof it !== 'object' || !SLOTS.includes(it.slot)) return null;
  const rarity = Number.isInteger(it.rarity) && it.rarity >= 0 && it.rarity < RARITIES.length ? it.rarity : 0;
  const base = {};
  for (const k of ['dmg', 'hp', 'speed', 'crit']) {
    if (it.base && Number.isFinite(it.base[k]) && it.base[k] > 0 && it.base[k] < 1e5) base[k] = it.base[k];
  }
  if (!Object.keys(base).length) return null;
  return {
    id: String(it.id || newItemId()).slice(0, 40), slot: it.slot, rarity,
    name: String(it.name || 'Gegenstand').slice(0, 40), level: Math.max(1, Number(it.level) || 1),
    up: Math.min(UPGRADE_MAX, Math.max(0, Number(it.up) || 0)), base
  };
}
function profileFromAccount(a) {
  const skills = {};
  for (const k in SKILL_DEFS) skills[k] = Math.min(SKILL_DEFS[k].max, Math.max(0, Number(a.skills && a.skills[k]) || 0));
  const equipment = {};
  for (const slot of SLOTS) {
    const it = sanitizeItem(a.equipment && a.equipment[slot]);
    equipment[slot] = it && it.slot === slot ? it : null;
  }
  const stats = { kills: 0, bossKills: 0, pvpKills: 0, chests: 0, goldEarned: 0, questsDone: 0, vaults: 0, secrets: 0, raidKills: 0, deposits: 0 };
  for (const k in stats) stats[k] = Math.max(0, Number(a.stats && a.stats[k]) || 0);
  const owned = { color: [], hat: [] };
  for (const kind of ['color', 'hat']) {
    const list = a.cosmetics && a.cosmetics.owned && a.cosmetics.owned[kind];
    if (Array.isArray(list)) owned[kind] = list.filter(id => COSMETICS[kind][id]);
  }
  const eqc = { owned, color: null, hat: null };
  for (const kind of ['color', 'hat']) {
    const id = a.cosmetics && a.cosmetics[kind];
    if (id && owned[kind].includes(id)) eqc[kind] = id;
  }
  return {
    inventory: (Array.isArray(a.inventory) ? a.inventory : []).map(sanitizeItem).filter(Boolean).slice(0, INVENTORY_MAX),
    equipment, skills, stats, cosmetics: eqc,
    essence: Math.max(0, Number(a.essence) || 0),
    pet: PETS[a.pet] ? a.pet : null,
    achievements: Array.isArray(a.achievements) ? a.achievements.filter(id => ACH_IDS.has(id)) : [],
    guild: typeof a.guild === 'string' ? a.guild.slice(0, 40) : null,
    friends: (Array.isArray(a.friends) ? a.friends : []).filter(x => typeof x === 'string' && x.length >= 3 && x.length <= 20).slice(0, 50),
    daily: { last: a.daily && typeof a.daily.last === 'string' ? a.daily.last : '', streak: Math.max(0, Number(a.daily && a.daily.streak) || 0) },
    dailyQuest: sanitizeDailyQuest(a.dailyQuest),
    keys: Math.max(0, Math.min(99, Number(a.keys) || 0)),
    prestige: Math.max(0, Math.min(PRESTIGE_MAX, Number(a.prestige) || 0)),
    season: { id: a.season && typeof a.season.id === 'string' ? a.season.id.slice(0, 10) : '', points: Math.max(0, Number(a.season && a.season.points) || 0) },
    week: { id: a.week && typeof a.week.id === 'string' ? a.week.id.slice(0, 10) : '', points: Math.max(0, Number(a.week && a.week.points) || 0) },
    bossBest: (a.bossBest && typeof a.bossBest === 'object') ? a.bossBest : {},
    storage: (() => {
      const s = a.storage && typeof a.storage === 'object' ? a.storage : {};
      return {
        items: (Array.isArray(s.items) ? s.items : []).map(sanitizeItem).filter(Boolean).slice(0, STORAGE_MAX),
        gold: Math.max(0, Number(s.gold) || 0),
        essence: Math.max(0, Number(s.essence) || 0),
        potions: Math.max(0, Number(s.potions) || 0),
        speedPotions: Math.max(0, Number(s.speedPotions) || 0)
      };
    })()
  };
}
function sendProfile(p) {
  io.to(p.id).emit('profile', {
    inventory: p.inventory.map(withEff),
    equipment: { weapon: withEff(p.equipment.weapon), armor: withEff(p.equipment.armor), ring: withEff(p.equipment.ring) },
    skills: p.skills, skillPoints: skillPointsFree(p), cosmetics: p.cosmetics, pet: p.pet,
    stats: p.stats, achievements: p.achievements, daily: p.daily, prestige: p.prestige || 0,
    storage: {
      items: (p.storage && p.storage.items ? p.storage.items : []).map(withEff),
      gold: p.storage ? p.storage.gold : 0,
      essence: p.storage ? p.storage.essence : 0,
      potions: p.storage ? p.storage.potions : 0,
      speedPotions: p.storage ? p.storage.speedPotions : 0
    }
  });
}
function giveItem(p, item) {
  if (p.inventory.length >= INVENTORY_MAX) {
    const g = sellValue(item);
    p.gold += g;
    io.to(p.id).emit('loot', { name: item.name, rarity: item.rarity, sold: g });
    return;
  }
  p.inventory.push(item);
  io.to(p.id).emit('loot', { name: item.name, rarity: item.rarity });
  sendProfile(p);
}
function dropGear(killer, m) {
  const lvl = killer.level;
  if (m.type === 'boss') {
    for (let i = 0; i < 3; i++) giveItem(killer, genItem(lvl, Math.max(i === 0 ? 2 : 1, rollRarity(2 + luckOf(killer)))));
  } else if (m.type === 'treasure') {
    giveItem(killer, genItem(lvl, rollRarity(1 + luckOf(killer))));
  } else if (Math.random() < 0.05) {
    giveItem(killer, genItem(lvl, rollRarity(0 + luckOf(killer))));
  }
}
function checkAchievements(p) {
  let changed = false;
  for (const def of ACHIEVEMENTS) {
    if (p.achievements.includes(def.id)) continue;
    const v = def.stat === 'level' ? p.level : (def.stat === 'prestige' ? (p.prestige || 0) : p.stats[def.stat]);
    if (v >= def.thr) {
      p.achievements.push(def.id);
      p.gold += def.gold;
      io.to(p.id).emit('achievement', { name: def.name, desc: def.desc, gold: def.gold });
      changed = true;
    }
  }
  if (changed) { sendProfile(p); saveAccountProgress(p); }
}
function dailyReward(p) {
  const today = new Date().toISOString().slice(0, 10);
  if (p.daily.last === today) return;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  p.daily.streak = p.daily.last === yesterday ? p.daily.streak + 1 : 1;
  p.daily.last = today;
  const s = Math.min(p.daily.streak, 7);
  const tier = DUNGEON_TIERS[tierForLevel(p.level)] || DUNGEON_TIERS[DEFAULT_TIER_KEY];
  const gold = Math.round(50 * s * tier.lootMult), potions = s >= 3 ? 1 : 0, essence = s >= 7 ? 10 : 0;
  p.gold += gold; p.potions += potions; p.essence += essence;
  io.to(p.id).emit('daily', { streak: p.daily.streak, gold, potions, essence });
  saveAccountProgress(p);
}
function updatePet(p) {
  if (!p.pet) return;
  if (!p.petPos || p.petZone !== p.zone || dist(p.petPos.x, p.petPos.y, p.x, p.y) > 500) {
    p.petPos = { x: p.x - 20, y: p.y };
    p.petZone = p.zone;
  }
  const d = dist(p.petPos.x, p.petPos.y, p.x, p.y);
  if (d > 50) {
    const a = Math.atan2(p.y - p.petPos.y, p.x - p.petPos.x);
    tryMove(mapFor(p.zone), p.petPos, Math.cos(a) * 3.4, Math.sin(a) * 3.4, 8);
  }
  const now = Date.now();
  const petCd = (PETS[p.pet] && PETS[p.pet].cd) || 1100;
  if (p.dead || now - (p.petAttackAt || 0) < petCd) return;
  if (!isDungeonTier(p.zone) && p.zone !== 'bossroom' && p.zone !== 'raid') return;
  for (const id in monsters) {
    const m = monsters[id];
    if ((m.zone || DEFAULT_TIER_KEY) !== p.zone) continue;
    if (dist(p.petPos.x, p.petPos.y, m.x, m.y) < 48 + Math.max(0, monsterRadius(m) - 12)) {
      p.petAttackAt = now;
      hitMonster(m, Math.max(1, Math.round(p.dmg * 0.3)), p);
      break;
    }
  }
}

// ---------------- Gruppen, Freunde, Handel, Missbrauchsschutz ----------------
const PARTY_MAX = 4;
const parties = {};
let partyCounter = 0;
const partyInvites = {};  // Ziel-Socket -> { fromId, expires }
const tradeOffers = {};   // Ziel-Socket -> { fromId, itemId, price, expires }
const authFails = new Map();
const regLog = new Map();

function disconnectSocket(id) {
  const s = io.sockets && io.sockets.sockets && io.sockets.sockets.get(id);
  if (s) s.disconnect(true);
}
function partyMembers(p) {
  const party = p.partyId && parties[p.partyId];
  return party ? party.members.map(id => players[id]).filter(Boolean) : [];
}
function leaveParty(p) {
  const party = p.partyId && parties[p.partyId];
  p.partyId = null;
  if (!party) return;
  party.members = party.members.filter(id => id !== p.id);
  if (party.members.length <= 1) {
    for (const id of party.members) {
      const m = players[id];
      if (m) { m.partyId = null; notice(m, '👥 Die Gruppe wurde aufgelöst.'); }
    }
    delete parties[party.id];
    return;
  }
  if (party.leader === p.id) party.leader = party.members[0];
  for (const id of party.members) {
    const m = players[id];
    if (m) notice(m, `👥 ${p.name} hat die Gruppe verlassen.`);
  }
}
function shareWithParty(killer, m, xpAmount, essAmount) {
  for (const mem of partyMembers(killer)) {
    if (mem.id === killer.id || mem.dead || mem.zone !== killer.zone) continue;
    if (dist(mem.x, mem.y, killer.x, killer.y) > 800) continue;
    grantXp(mem, Math.round(xpAmount * 0.5));
    mem.essence += Math.ceil(essAmount / 2);
    questProgress(mem, 'kill', 1, m.type);
  }
}
function findOnline(username) {
  for (const id in players) if (players[id].username === username) return players[id];
  return null;
}
function sendFriends(p) {
  const list = p.friends.map(u => {
    const o = findOnline(u);
    return o ? { username: u, online: true, name: o.name, level: o.level, zone: o.zone, id: o.id } : { username: u, online: false };
  });
  io.to(p.id).emit('friends', list);
}
function notifyFriendsOf(p, text) {
  for (const id in players) {
    const f = players[id];
    if (f.id !== p.id && f.friends.includes(p.username)) { if (text) notice(f, text); sendFriends(f); }
  }
}
function chatAllowed(p) {
  const now = Date.now();
  if (now - (p.lastChatAt || 0) < 1200) { notice(p, 'Nicht so schnell schreiben.'); return false; }
  p.lastChatAt = now;
  return true;
}
function clientKey(socket) {
  const h = socket.handshake;
  const xf = h && h.headers && h.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : (h && h.address)) || socket.id;
}
function authBlockedSeconds(key) {
  const e = authFails.get(key);
  return e && e.until > Date.now() ? Math.ceil((e.until - Date.now()) / 1000) : 0;
}
function authFail(key) {
  const e = authFails.get(key) || { count: 0, until: 0 };
  if (e.until && e.until <= Date.now()) { e.count = 0; e.until = 0; }
  e.count++;
  if (e.count >= 6) { e.until = Date.now() + 5 * 60 * 1000; e.count = 0; }
  authFails.set(key, e);
}
function authOk(key) { authFails.delete(key); }
function regAllowed(key) {
  const now = Date.now();
  const list = (regLog.get(key) || []).filter(t => now - t < 3600000);
  if (list.length >= 5) { regLog.set(key, list); return false; }
  list.push(now);
  regLog.set(key, list);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of authFails) if (e.until < now && e.count === 0) authFails.delete(k);
  for (const [k, list] of regLog) if (!list.some(t => now - t < 3600000)) regLog.delete(k);
  for (const id in partyInvites) if (partyInvites[id].expires < now) delete partyInvites[id];
  for (const id in tradeOffers) if (tradeOffers[id].expires < now) delete tradeOffers[id];
}, 600000);

// ---------------- Statuseffekte, Dungeon-Bosse, Zufallsereignisse ----------------
const EFFECT_MS = { slow: 3000, poison: 5000, burn: 4000 };
const TIER_BOSS_NAMES = { tier1: 'Moosriese', tier2: 'Minenwächter', tier3: 'Knochenfürst', tier4: 'Frostkoloss', tier5: 'Magmatitan', tier6: 'Abgrundherrscher', tier7: 'Obsidianfürst', tier8: 'Aschenfürst' };
const TIER_BOSS_INTERVAL_MS = 8 * 60 * 1000;
const tierBosses = {};
const tierBossNextAt = {};

function damagePlayer(target, dmg, src) {
  if (target.dead) return;
  if (target.guardUntil && target.guardUntil > Date.now()) dmg = Math.round(dmg * 0.5);
  target.hp -= dmg;
  io.to(target.id).emit('hit', { x: target.x, y: target.y, dmg });
  if (target.hp <= 0 && !target.dead) {
    target.dead = true;
    target.fx = {};
    target.deadBy = src || null;
    io.to(target.id).emit('died', { by: src || null });
    setTimeout(() => respawnPlayer(target), 3000);
  }
}
function applyEffect(target, kind, hitDmg) {
  if (!kind || target.dead || !EFFECT_MS[kind]) return;
  if (!target.fx) target.fx = {};
  const until = Date.now() + EFFECT_MS[kind];
  if (kind === 'slow') target.fx.slow = until;
  else target.fx[kind] = { until, dmg: Math.max(1, Math.round(hitDmg * (kind === 'burn' ? 0.25 : 0.15))) };
}
function fxFlags(p) {
  const now = Date.now(), f = p.fx || {};
  return { slow: (f.slow || 0) > now, poison: !!(f.poison && f.poison.until > now), burn: !!(f.burn && f.burn.until > now) };
}
function updateEffects(p, now) {
  if (!p.fx || p.dead) return;
  if (now - (p.dotAt || 0) < 1000) return;
  p.dotAt = now;
  for (const k of ['poison', 'burn']) {
    const e = p.fx[k];
    if (e && e.until > now) damagePlayer(p, e.dmg, k === 'poison' ? 'Gift' : 'Feuer');
  }
}

function announceTo(filter, text) {
  for (const id in players) if (filter(players[id])) io.to(id).emit('announcement', text);
}
function announceZone(zone, text) { announceTo(p => p.zone === zone, text); }

function bossSlam(m, def) {
  const now = Date.now();
  if (now < (m.nextSlam || 0)) return;
  m.nextSlam = now + (m.enraged ? 4500 : 7000);
  const cx = m.x, cy = m.y, zone = m.zone || DEFAULT_TIER_KEY, R = 120;
  const dmg = Math.round(def.dmg * (m.dmgMult || 1) * 1.8);
  io.emit('bossSlam', { x: cx, y: cy, r: R, zone, ms: 1200 });
  setTimeout(() => {
    for (const pid in players) {
      const p = players[pid];
      if (p.dead || p.zone !== zone) continue;
      if (dist(p.x, p.y, cx, cy) < R + 10) damagePlayer(p, dmg, m.name || 'dem Boss');
    }
  }, 1200);
}

function spawnTierBoss(zone) {
  const tier = DUNGEON_TIERS[zone];
  if (!tier) return;
  if (tierBosses[zone] && monsters[tierBosses[zone]]) removeBoss(tierBosses[zone]);
  const tile = randomFloorTile(zone);
  const id = 'tb_' + zone + '_' + (monsterIdCounter++);
  const hp = Math.round(MONSTER_TYPES.boss.hp * tier.monsterMult * 0.8);
  const name = TIER_BOSS_NAMES[zone] || 'Dungeon-Boss';
  const x = tile.x * TILE + TILE / 2, y = tile.y * TILE + TILE / 2;
  monsters[id] = {
    id, type: 'boss', zone, mult: tier.monsterMult, dmgMult: tier.dmgMult || Math.pow(tier.monsterMult, 0.65), name, spawnAt: Date.now(),
    hp, maxHp: hp, x, y, lastAttack: 0, targetId: null, homeX: x, homeY: y
  };
  tierBosses[zone] = id;
  tierBossNextAt[zone] = Date.now() + TIER_BOSS_INTERVAL_MS;
  announceTo(p => p.level >= tier.minLevel, `👑 ${name} ist in ${tier.name} erschienen!`);
}

function spawnTreasureGoblin(zone) {
  const tier = DUNGEON_TIERS[zone];
  if (!tier) return;
  const tile = randomFloorTile(zone);
  const id = 'm' + (monsterIdCounter++);
  const hp = Math.round(MONSTER_TYPES.treasure.hp * tier.monsterMult);
  const x = tile.x * TILE + TILE / 2, y = tile.y * TILE + TILE / 2;
  monsters[id] = {
    id, type: 'treasure', zone, mult: tier.monsterMult, dmgMult: 1, name: 'Schatzgoblin',
    hp, maxHp: hp, x, y, lastAttack: 0, homeX: x, homeY: y, expiresAt: Date.now() + 120000
  };
  announceTo(p => p.level >= tier.minLevel, `💰 Ein Schatzgoblin ist in ${tier.name} aufgetaucht! Fang ihn in 2 Minuten!`);
}
function updateTreasure(id, m, mMap) {
  const now = Date.now();
  if (now > m.expiresAt) {
    delete monsters[id];
    announceZone(m.zone, '💨 Der Schatzgoblin ist entkommen ...');
    return;
  }
  let near = null, nd = 320;
  for (const pid in players) {
    const p = players[pid];
    if (p.dead || p.zone !== m.zone) continue;
    const d = dist(m.x, m.y, p.x, p.y);
    if (d < nd) { nd = d; near = p; }
  }
  if (!near) return;
  const def = MONSTER_TYPES.treasure;
  const a = Math.atan2(m.y - near.y, m.x - near.x) + Math.sin(now / 450) * 0.7;
  tryMove(mMap, m, Math.cos(a) * def.speed, Math.sin(a) * def.speed, 10);
}
function runAmbush(zone, victim) {
  if (!victim) return;
  const map = mapFor(zone);
  let spawned = 0;
  for (let i = 0; i < 250 && spawned < 8; i++) {
    const ang = Math.random() * Math.PI * 2, r = 110 + Math.random() * 230;
    const tx = Math.floor((victim.x + Math.cos(ang) * r) / TILE), ty = Math.floor((victim.y + Math.sin(ang) * r) / TILE);
    if (!map.isFloor(tx, ty)) continue;
    spawnMonster(zone, { x: tx, y: ty }, true);
    spawned++;
  }
  announceZone(zone, '⚠️ Hinterhalt! Monster greifen aus dem Dunkeln an!');
}
function runBlessing(zone) {
  for (const id in players) {
    const p = players[id];
    if (p.zone !== zone || p.dead) continue;
    p.hp = p.maxHp;
    p.fx = {};
    p.speedBoostUntil = Date.now() + 30000;
  }
  announceZone(zone, '✨ Ein Segen liegt über dem Dungeon: volle Heilung und 30 s Tempo!');
}
function randomEvent() {
  const zones = [...new Set(Object.values(players).filter(p => isDungeonTier(p.zone) && !p.dead).map(p => p.zone))];
  if (!zones.length) return;
  const zone = zones[Math.floor(Math.random() * zones.length)];
  const r = Math.random();
  if (r < 0.45) spawnTreasureGoblin(zone);
  else if (r < 0.8) {
    const vs = Object.values(players).filter(p => p.zone === zone && !p.dead);
    runAmbush(zone, vs[Math.floor(Math.random() * vs.length)]);
  } else runBlessing(zone);
}
(function scheduleEvents() {
  setTimeout(() => { randomEvent(); scheduleEvents(); }, (4 + Math.random() * 4) * 60000);
})();
DUNGEON_TIER_DEFS.forEach((def, i) => {
  setTimeout(() => {
    tierBossNextAt[def.key] = Date.now() + TIER_BOSS_INTERVAL_MS;
    spawnTierBoss(def.key);
    setInterval(() => spawnTierBoss(def.key), TIER_BOSS_INTERVAL_MS);
  }, 60000 + i * 80000);
});

// ---------------- Trefferflaeche und Fernkampf-Gegner ----------------
function monsterRadius(m) {
  if (m.type === 'raidboss') return 46;
  if (m.type === 'boss') return 30;
  const t = MONSTER_TYPES[m.type];
  return (t && t.radius) || 12;
}
function hasLOS(map, x1, y1, x2, y2) {
  const d = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.ceil(d / 16);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (map.isWall(Math.floor((x1 + (x2 - x1) * t) / TILE), Math.floor((y1 + (y2 - y1) * t) / TILE))) return false;
  }
  return true;
}
function rangedAI(m, def, target, d, map) {
  const rad = Math.min(def.radius, 14);
  const ang = Math.atan2(target.y - m.y, target.x - m.x);
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const los = hasLOS(map, m.x, m.y, target.x, target.y);
  if (!los || d > def.range * 0.9) tryMove(map, m, cos * def.speed, sin * def.speed, rad);            // naeher heran
  else if (d < def.range * 0.45) tryMove(map, m, -cos * def.speed * 1.1, -sin * def.speed * 1.1, rad); // Abstand halten
  if (!los || d > def.range) return;
  const now = Date.now();
  if (now - m.lastAttack <= def.cooldown) return;
  m.lastAttack = now;
  const r = def.ranged, id = 'pr' + (projectileIdCounter++);
  projectiles[id] = {
    id, hostile: true, ownerId: m.id, zone: m.zone,
    x: m.x, y: m.y, vx: cos * r.speed, vy: sin * r.speed,
    dmg: Math.round(def.dmg * (m.dmgMult || 1)), effect: def.effect, color: r.color, life: r.life
  };
}

// ---------------- Boss-Faehigkeiten ----------------
const BOSS_SPECIALS = {
  tier1: ['summon', 'enrage', 'heal'],
  tier2: ['rockfall', 'enrage', 'volley'],
  tier3: ['summon', 'fan', 'volley'],
  tier4: ['fan', 'rockfall', 'heal'],
  tier5: ['rockfall', 'fan', 'enrage', 'volley'],
  tier6: ['summon', 'fan', 'rockfall', 'enrage', 'volley', 'heal'],
  tier7: ['summon', 'fan', 'rockfall', 'enrage', 'volley', 'heal'],
  tier8: ['summon', 'fan', 'rockfall', 'enrage', 'volley', 'heal'],
  bossroom: ['summon', 'fan', 'enrage', 'volley'],
  raid: ['summon', 'fan', 'rockfall', 'enrage', 'volley', 'heal']
};
const BOSS_FAN = {
  tier4: { effect: 'slow', color: '#9be8ff' },
  tier5: { effect: 'burn', color: '#ff8a3c' },
  tier6: { effect: 'poison', color: '#8fff6b' },
  tier7: { effect: 'burn', color: '#ff5d8a' },
  tier8: { effect: 'burn', color: '#ffb03c' },
  raid: { effect: 'burn', color: '#c77dff' }
};
const BOSS_ADD_MAX = 8;

function removeBoss(id) {
  for (const mid in monsters) if (monsters[mid].ownerId === id) delete monsters[mid];
  delete monsters[id];
}
function bossStatsTier(zone) {
  if (DUNGEON_TIERS[zone]) return zone;
  let sum = 0, cnt = 0;
  for (const id in players) { sum += players[id].level; cnt++; }
  return tierForLevel(cnt ? sum / cnt : 1);
}
function bossTarget(m) {
  let best = null, bd = 700;
  for (const id in players) {
    const p = players[id];
    if (p.dead || p.zone !== m.zone) continue;
    const d = dist(m.x, m.y, p.x, p.y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function bossSummon(m) {
  const zone = m.zone || DEFAULT_TIER_KEY;
  let alive = 0;
  for (const id in monsters) if (monsters[id].ownerId === m.id) alive++;
  if (alive >= BOSS_ADD_MAX) return;
  const map = mapFor(zone), statsTier = bossStatsTier(zone);
  let n = 0;
  for (let i = 0; i < 40 && n < 3 && alive + n < BOSS_ADD_MAX; i++) {
    const a = Math.random() * Math.PI * 2, r = 70 + Math.random() * 90;
    const tx = Math.floor((m.x + Math.cos(a) * r) / TILE), ty = Math.floor((m.y + Math.sin(a) * r) / TILE);
    if (!map.isFloor(tx, ty)) continue;
    const add = spawnMonster(zone, { x: tx, y: ty }, true, statsTier);
    if (add) { add.ownerId = m.id; n++; }
  }
  if (n) announceZone(zone, `📣 ${m.name || 'Der Boss'} ruft Verstärkung!`);
}
function bossFan(m, def, target) {
  const zone = m.zone || DEFAULT_TIER_KEY;
  const cfg = BOSS_FAN[zone] || { effect: null, color: '#f1e3b0' };
  const base = Math.atan2(target.y - m.y, target.x - m.x);
  const dmg = Math.round(def.dmg * (m.dmgMult || 1) * 0.8);
  io.emit('bossCast', { x: m.x, y: m.y, zone, ms: 600 });
  setTimeout(() => {
    if (!monsters[m.id]) return;
    for (let i = -3; i <= 3; i++) {
      const a = base + i * 0.2, id = 'pr' + (projectileIdCounter++);
      projectiles[id] = { id, hostile: true, ownerId: m.id, zone, x: m.x, y: m.y, vx: Math.cos(a) * 5, vy: Math.sin(a) * 5, dmg, effect: cfg.effect, color: cfg.color, life: 70 };
    }
  }, 600);
}
function bossRockfall(m, def) {
  const zone = m.zone || DEFAULT_TIER_KEY;
  const targets = Object.values(players).filter(p => !p.dead && p.zone === zone && dist(p.x, p.y, m.x, m.y) < 650);
  if (!targets.length) return;
  const count = Math.min(6, 3 + targets.length + (m.enraged ? 2 : 0)), R = 70;
  const dmg = Math.round(def.dmg * (m.dmgMult || 1) * 1.2);
  const spots = [];
  for (let i = 0; i < count; i++) {
    const t = targets[i % targets.length], a = Math.random() * Math.PI * 2, r = Math.random() * 110;
    spots.push({ x: t.x + Math.cos(a) * r, y: t.y + Math.sin(a) * r });
  }
  for (const s of spots) io.emit('bossSlam', { x: s.x, y: s.y, r: R, zone, ms: 1400 });
  setTimeout(() => {
    for (const s of spots) {
      for (const pid in players) {
        const p = players[pid];
        if (p.dead || p.zone !== zone) continue;
        if (dist(p.x, p.y, s.x, s.y) < R + 10) damagePlayer(p, dmg, m.name || 'dem Boss');
      }
    }
  }, 1400);
}
function bossVolley(m, def) {
  const zone = m.zone || DEFAULT_TIER_KEY;
  const cfg = BOSS_FAN[zone] || { effect: null, color: '#f1e3b0' };
  const dmg = Math.round(def.dmg * (m.dmgMult || 1) * 0.6);
  io.emit('bossCast', { x: m.x, y: m.y, zone, ms: 600 });
  setTimeout(() => {
    if (!monsters[m.id]) return;
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2, id = 'pr' + (projectileIdCounter++);
      projectiles[id] = { id, hostile: true, ownerId: m.id, zone, x: m.x, y: m.y, vx: Math.cos(a) * 4.2, vy: Math.sin(a) * 4.2, dmg, effect: cfg.effect, color: cfg.color, life: 85 };
    }
  }, 600);
}
function bossHeal(m) {
  if (m.hp >= m.maxHp * 0.6) return;
  m.hp = Math.min(m.maxHp, m.hp + Math.round(m.maxHp * 0.15));
  announceZone(m.zone || DEFAULT_TIER_KEY, `💚 ${m.name || 'Der Boss'} regeneriert!`);
}
function bossSpecial(m, def) {
  const zone = m.zone || DEFAULT_TIER_KEY;
  const list = BOSS_SPECIALS[zone] || ['summon'];
  const now = Date.now();
  if (!m.enraged && list.includes('enrage') && m.hp <= m.maxHp * 0.3) {
    m.enraged = true;
    m.speedMul = 1.4;
    m.dmgMult = (m.dmgMult || 1) * 1.25;
    announceZone(zone, `😡 ${m.name || 'Der Boss'} tobt vor Wut!`);
  }
  if (!m.nextSpecial) { m.nextSpecial = now + 5000; return; }
  if (now < m.nextSpecial) return;
  m.nextSpecial = now + (m.enraged ? 5500 : 9000);
  const acts = list.filter(s => s !== 'enrage');
  m.specialIdx = ((m.specialIdx || 0) + 1) % acts.length;
  const act = acts[m.specialIdx];
  const target = bossTarget(m);
  if (act === 'summon') bossSummon(m);
  else if (act === 'fan' && target) bossFan(m, def, target);
  else if (act === 'rockfall') bossRockfall(m, def);
  else if (act === 'volley') bossVolley(m, def);
  else if (act === 'heal') bossHeal(m);
}

// ---------------- Gilden ----------------
const GUILD_MAX = 20;
const GUILD_COST = 500;
function guildLevel(g) { return Math.min(10, Math.floor(Math.sqrt(Math.max(0, g.xp || 0) / 100))); }
const guildCache = new Map();    // key -> { key, name, tag, leader, members:[username] }
const guildInvites = {};         // Ziel-Socket -> { fromId, guild, expires }
const GUILD_BANK_MAX = 100;

function guildBank(g) {
  if (!g.bank || typeof g.bank !== 'object') g.bank = { items: [], gold: 0 };
  if (!Array.isArray(g.bank.items)) g.bank.items = [];
  g.bank.items = g.bank.items.map(sanitizeItem).filter(Boolean).slice(0, GUILD_BANK_MAX);
  g.bank.gold = Math.max(0, Number(g.bank.gold) || 0);
  return g.bank;
}

async function loadGuild(key) {
  if (!key) return null;
  if (guildCache.has(key)) { const c = guildCache.get(key); guildBank(c); return c; }
  if (!guildsCol) return null;
  const g = await guildsCol.findOne({ key });
  if (g) { guildBank(g); guildCache.set(key, g); }
  return g || null;
}
async function saveGuild(g) {
  const b = guildBank(g);
  if (guildsCol) await guildsCol.updateOne({ key: g.key }, { $set: { name: g.name, tag: g.tag, leader: g.leader, members: g.members, xp: g.xp || 0, level: guildLevel(g), bank: { items: b.items, gold: b.gold } } });
}
function guildOnline(g) { return g.members.map(u => findOnline(u)).filter(Boolean); }
function sendGuild(p) {
  const g = p.guild && guildCache.get(p.guild);
  io.to(p.id).emit('guild', g ? {
    name: g.name, tag: g.tag, leader: g.leader, you: p.username,
    level: guildLevel(g), xp: g.xp || 0,
    members: g.members.map(u => { const o = findOnline(u); return { username: u, online: !!o, name: o ? o.name : null, level: o ? o.level : null }; })
  } : null);
}
function refreshGuildMembers(g) { for (const o of guildOnline(g)) sendGuild(o); }
function guildBonus(p) {
  if (!p.guild) return 0;
  const g = guildCache.get(p.guild);
  const lvlBonus = g ? Math.min(0.10, guildLevel(g) * 0.01) : 0;
  let n = 0;
  for (const id in players) {
    const o = players[id];
    if (o.id !== p.id && o.guild === p.guild && o.zone === p.zone && !o.dead && dist(o.x, o.y, p.x, p.y) < 1000) n++;
  }
  return Math.min(0.25, n * 0.05 + lvlBonus);
}
function setGuild(p, g) {
  p.guild = g ? g.key : null;
  p.guildTag = g ? g.tag : null;
  p.guildName = g ? g.name : null;
}

// ---------------- Admin ----------------
const LB_CATEGORIES = { level: 'level', kills: 'stats.kills', boss: 'stats.bossKills', pvp: 'stats.pvpKills' };
const lbCache = {};
const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
const OWNER_USERNAMES = new Set(
  (process.env.OWNER_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
const MOD_USERNAMES = new Set(
  (process.env.MOD_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
const ROLE_TAGS = { owner: '👑 Owner', admin: '🛡 Admin', mod: '⭐ Mod', supporter: '☕ Supporter' };
function roleFor(username, account) {
  const u = String(username || '').toLowerCase();
  if (OWNER_USERNAMES.has(u)) return 'owner';
  if (ADMIN_USERNAMES.has(u)) return 'admin';
  if (MOD_USERNAMES.has(u)) return 'mod';
  if (account && account.supporter) return 'supporter';
  return null;
}

// ---------------- Socket-Handling ----------------
io.on('connection', (socket) => {
  // Schutz vor Paket-Fluten: max. ca. 90 Ereignisse/s pro Verbindung, Rest wird verworfen
  let tokens = 120, lastRefill = Date.now(), violations = 0;
  if (typeof socket.use === 'function') {
    socket.use((packet, next) => {
      const now = Date.now();
      tokens = Math.min(120, tokens + (now - lastRefill) * 0.09);
      lastRefill = now;
      if (tokens < 1) { if (++violations > 500) socket.disconnect(true); return; }
      tokens -= 1;
      next();
    });
  }
  socket.on('auth', async (data) => {
    try {
      const mode = data && data.mode === 'register' ? 'register' : 'login';
      const username = (data && data.username ? String(data.username) : '').trim().toLowerCase().slice(0, 20);
      const password = data && data.password ? String(data.password) : '';
      const name = (data && data.name ? String(data.name) : username).trim().slice(0, 16) || 'Held';
      const sessionToken = data && data.token ? String(data.token).slice(0, 64) : null;
      const key = clientKey(socket);
      const blocked = authBlockedSeconds(key);
      if (blocked) return socket.emit('authError', `Zu viele Fehlversuche. Bitte warte ${blocked} Sekunden.`);

      if (!username || username.length < 3) {
        return socket.emit('authError', 'Benutzername muss mind. 3 Zeichen haben.');
      }
      if (!sessionToken && (!password || password.length < 4)) {
        return socket.emit('authError', 'Passwort muss mind. 4 Zeichen haben.');
      }
      if (!accountsCol) {
        return socket.emit('authError', 'Datenbank nicht verbunden - Accounts sind aktuell deaktiviert. (MONGO_URI fehlt auf dem Server)');
      }

      let account = await loadAccount(username);

      if (mode === 'register') {
        if (account) return socket.emit('authError', 'Dieser Benutzername ist bereits vergeben.');
        if (!regAllowed(key)) return socket.emit('authError', 'Zu viele Registrierungen von dieser Adresse. Bitte später erneut versuchen.');
        const classKey = CLASSES[data && data.cls] ? data.cls : 'krieger';
        const hash = await bcrypt.hash(password, 10);
        account = await createAccount(username, hash, classKey);
      } else {
        if (!account) { authFail(key); return socket.emit('authError', 'Diesen Account gibt es nicht. Bitte zuerst registrieren.'); }
        if (sessionToken) {
          if (account.sessionToken !== sessionToken) { authFail(key); return socket.emit('authError', 'Deine Sitzung ist abgelaufen. Bitte neu einloggen.'); }
        } else {
          const ok = await bcrypt.compare(password, account.passwordHash);
          if (!ok) { authFail(key); return socket.emit('authError', 'Falsches Passwort.'); }
        }
        authOk(key);
        if (account.banned) return socket.emit('authError', 'Dieser Account ist gesperrt.');
        // Nur eine Sitzung pro Account: die alte wird gespeichert und beendet (verhindert Item-Duplikate)
        const existing = findOnline(username);
        if (existing) {
          await saveAccountProgress(existing);
          delete players[existing.id];
          leaveParty(existing);
          io.to(existing.id).emit('kicked', 'Du hast dich an einem anderen Ort angemeldet.');
          disconnectSocket(existing.id);
          account = await loadAccount(username);
        }
      }

      // Session-Token fuer "angemeldet bleiben" (Client speichert ihn lokal)
      const newSessionToken = crypto.randomBytes(24).toString('hex');
      const chosenName = (data && data.name && String(data.name).trim()) ? name : (account.displayName || username);
      await accountsCol.updateOne({ username }, { $set: { sessionToken: newSessionToken, displayName: chosenName } });

      const stats = statsForLevel(account.cls, account.level);
      const loginTier = tierForLevel(account.level);
      const loginSpawn = randomTierSpawn(loginTier);
      players[socket.id] = {
        id: socket.id,
        username,
        name: chosenName,
        cls: account.cls,
        zone: loginTier,
        x: loginSpawn.x,
        y: loginSpawn.y,
        hp: stats.maxHp,
        maxHp: stats.maxHp,
        dmg: stats.dmg,
        speed: CLASSES[account.cls].speed,
        level: account.level,
        xp: account.xp,
        xpNext: xpToNextLevel(account.level),
        gold: account.gold,
        potions: account.potions,
        speedPotions: account.speedPotions || 0,
        speedBoostUntil: 0,
        upgDmg: account.upgDmg || 0,
        upgHp: account.upgHp || 0,
        upgSpeed: account.upgSpeed || 0,
        upgLuck: account.upgLuck || 0,
        isAdmin: ADMIN_USERNAMES.has(username),
        role: roleFor(username, account),
        abilityReadyAt: 0,
        critUntil: 0,
        quests: sanitizeQuests(account.quests),
        lastAttack: 0,
        dead: false,
        input: { up: false, down: false, left: false, right: false, aimX: 0, aimY: 0 }
      };
      Object.assign(players[socket.id], profileFromAccount(account));
      recomputeStats(players[socket.id]);
      players[socket.id].hp = players[socket.id].maxHp;
      ensureQuests(players[socket.id]);
      ensureDailyQuest(players[socket.id]);
      {
        const me0 = players[socket.id];
        const g0 = me0.guild ? await loadGuild(me0.guild) : null;
        if (g0 && g0.members.includes(username)) { me0.guildTag = g0.tag; me0.guildName = g0.name; }
        else { me0.guild = null; me0.guildTag = null; me0.guildName = null; }
      }

      const dungeonTiersPayload = {};
      for (const key in DUNGEON_TIERS) {
        const t = DUNGEON_TIERS[key];
        dungeonTiersPayload[key] = { name: t.name, minLevel: t.minLevel, rows: t.rows, theme: t.theme, traps: t.traps,
          monsters: [...new Set((t.pool || []).map(([ty]) => MONSTER_TYPES[ty] ? MONSTER_TYPES[ty].name : ty))] };
      }
      socket.emit('init', {
        you: socket.id,
        session: newSessionToken,
        dungeonTiers: dungeonTiersPayload,
        abilities: ABILITIES,
        abilities2: ABILITIES2,
        town: { rows: TOWN_ROWS, npcs: TOWN_NPCS, spawn: TOWN_SPAWN },
        raidMap: RAID_ROWS,
        meta: META,
        defs: CLIENT_DEFS,
        monsterDefs: Object.fromEntries(Object.entries(MONSTER_TYPES).map(([k, v]) => [k, { name: v.name, color: v.color, radius: v.radius, ranged: !!v.ranged }])),
        arenaMap: ARENA_ROWS,
        bossRoomMap: BOSSROOM_ROWS,
        tile: TILE,
        classes: CLASSES,
        shop: SHOP_ITEMS,
        deal: dailyDealKey(),
        donate: DONATE_LINKS,
        discord: DISCORD_INVITE,
        isAdmin: players[socket.id].isAdmin
      });
      sendQuests(players[socket.id]);
      checkSeason(players[socket.id]);
      sendProfile(players[socket.id]);
      sendSeason(players[socket.id]);
      checkWeek(players[socket.id]);
      sendWeek(players[socket.id]);
      dailyReward(players[socket.id]);
      checkAchievements(players[socket.id]);
      sendGuild(players[socket.id]);
      if (players[socket.id].guild) refreshGuildMembers(guildCache.get(players[socket.id].guild));
      sendFriends(players[socket.id]);
      notifyFriendsOf(players[socket.id], `👋 ${players[socket.id].name} ist jetzt online.`);
    } catch (err) {
      console.error('Auth-Fehler:', err.message);
      socket.emit('authError', 'Es ist ein Fehler aufgetreten. Bitte versuch es erneut.');
    }
  });

  socket.on('input', (inp) => {
    const p = players[socket.id];
    if (!p || !inp) return;
    p.input = {
      up: !!inp.up, down: !!inp.down, left: !!inp.left, right: !!inp.right,
      aimX: Number(inp.aimX) || 0, aimY: Number(inp.aimY) || 0
    };
  });

  socket.on('attack', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    const now = Date.now();
    const def = CLASSES[p.cls];
    if (now - p.lastAttack < def.cooldown) return;
    p.lastAttack = now;
    io.emit('swing', { id: p.id, zone: p.zone });
    revealSecrets(p);

    if (p.zone === 'arena') {
      // PvP: Gegner sind andere Spieler in der Arena
      if (def.kind === 'melee') {
        let closest = null, closestDist = Infinity;
        for (const id in players) {
          const other = players[id];
          if (id === p.id || other.zone !== 'arena' || other.dead) continue;
          const d = dist(p.x, p.y, other.x, other.y);
          if (d < def.range && d < closestDist) { closest = other; closestDist = d; }
        }
        if (closest) {
          let dmg = rollDamage(p, def);
          applyPvpDamage(closest, dmg, p);
        }
      } else {
        const id = 'pr' + (projectileIdCounter++);
        const angle = Math.atan2(p.input.aimY, p.input.aimX) || 0;
        projectiles[id] = {
          id, ownerId: p.id, zone: 'arena',
          x: p.x, y: p.y,
          vx: Math.cos(angle) * 6, vy: Math.sin(angle) * 6,
          dmg: p.dmg, life: 60
        };
      }
      return;
    }

    if (def.kind === 'melee') {
      let closest = null, closestDist = Infinity;
      for (const id in monsters) {
        const m = monsters[id];
        if ((m.zone || DEFAULT_TIER_KEY) !== p.zone) continue;
        const d = dist(p.x, p.y, m.x, m.y);
        if (d < def.range + Math.max(0, monsterRadius(m) - 12) && d < closestDist) { closest = m; closestDist = d; }
      }
      if (closest) {
        let dmg = rollDamage(p, def);
        closest.hp -= dmg;
        if (closest.raid) creditRaid(closest, p, dmg);
        if (p.lifestealUntil && Date.now() < p.lifestealUntil) p.hp = Math.min(p.maxHp, p.hp + Math.round(dmg * 0.2));
        io.emit('hit', { x: closest.x, y: closest.y, dmg });
        if (closest.hp <= 0) {
          onMonsterKilled(closest, p);
          delete monsters[closest.id];
        }
      }
    } else {
      const id = 'pr' + (projectileIdCounter++);
      const angle = Math.atan2(p.input.aimY, p.input.aimX) || 0;
      projectiles[id] = {
        id, ownerId: p.id, zone: p.zone,
        x: p.x, y: p.y,
        vx: Math.cos(angle) * 6, vy: Math.sin(angle) * 6,
        dmg: p.dmg, life: 60
      };
    }
  });

  socket.on('joinArena', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    p.zone = 'arena';
    p.x = ARENA_SPAWN.x; p.y = ARENA_SPAWN.y;
    p.hp = p.maxHp;
  });

  socket.on('leaveArena', () => {
    const p = players[socket.id];
    if (!p) return;
    p.zone = tierForLevel(p.level);
    const sp = randomTierSpawn(p.zone);
    p.x = sp.x; p.y = sp.y;
    p.hp = p.maxHp;
    p.dead = false;
  });

  socket.on('joinBossRoom', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    if (!bossId || !monsters[bossId]) return socket.emit('shopError', 'Aktuell ist kein Boss aktiv.');
    p.zone = 'bossroom';
    p.x = BOSSROOM_ENTRY.x; p.y = BOSSROOM_ENTRY.y;
    p.hp = p.maxHp;
  });

  socket.on('leaveBossRoom', () => {
    const p = players[socket.id];
    if (!p) return;
    p.zone = tierForLevel(p.level);
    const sp = randomTierSpawn(p.zone);
    p.x = sp.x; p.y = sp.y;
    p.hp = p.maxHp;
    p.dead = false;
  });

  socket.on('teleportRequest', (data) => {
    const p = players[socket.id];
    const target = players[data && data.targetId];
    if (!p || !target || p.dead || target.id === p.id) return;
    tpaRequests[target.id] = { fromId: p.id, expiresAt: Date.now() + 30000 };
    io.to(target.id).emit('tpaIncoming', { fromId: p.id, fromName: p.name });
    socket.emit('tpaSent', { targetName: target.name });
  });

  socket.on('tpaAccept', (data) => {
    const p = players[socket.id]; // derjenige, der die Anfrage annimmt (Ziel)
    const req = tpaRequests[socket.id];
    if (!p || !req) return;
    if (data && data.fromId && data.fromId !== req.fromId) return;
    if (Date.now() > req.expiresAt) { delete tpaRequests[socket.id]; return; }
    const requester = players[req.fromId];
    delete tpaRequests[socket.id];
    if (!requester || requester.dead) return;

    requester.zone = p.zone;
    requester.x = p.x + (Math.random() * 30 - 15);
    requester.y = p.y + (Math.random() * 30 - 15);
    if (circleHitsWall(mapFor(requester.zone), requester.x, requester.y, 12)) {
      requester.x = p.x; requester.y = p.y;
    }
    io.to(requester.id).emit('tpaResult', { accepted: true, otherName: p.name });
    socket.emit('tpaResult', { accepted: true, otherName: requester.name, asTarget: true });
  });

  socket.on('tpaDeny', (data) => {
    const req = tpaRequests[socket.id];
    if (!req) return;
    delete tpaRequests[socket.id];
    const requester = players[req.fromId];
    const me = players[socket.id];
    if (requester) io.to(requester.id).emit('tpaResult', { accepted: false, otherName: me ? me.name : '' });
  });

  socket.on('duelRequest', (data) => {
    const p = players[socket.id];
    const target = players[data && data.targetId];
    if (!p || !target || p.dead || target.dead || target.id === p.id) return;
    if (p.zone === 'raid' || target.zone === 'raid' || p.zone === 'bossroom' || target.zone === 'bossroom') return notice(p, 'In diesem Bereich ist kein Duell möglich.');
    duelRequests[target.id] = { fromId: p.id, expiresAt: Date.now() + 30000 };
    io.to(target.id).emit('duelIncoming', { fromId: p.id, fromName: p.name });
    notice(p, `⚔️ Duell-Anfrage an ${target.name} gesendet.`);
  });

  socket.on('duelRespond', (data) => {
    const p = players[socket.id];
    const req = duelRequests[socket.id];
    if (!p || !req) return;
    if (data && data.fromId && data.fromId !== req.fromId) return;
    delete duelRequests[socket.id];
    const challenger = players[req.fromId];
    if (Date.now() > req.expiresAt || !challenger || challenger.dead || p.dead) return;
    if (!(data && data.accept)) { notice(challenger, `⚔️ ${p.name} hat das Duell abgelehnt.`); return; }
    p.duelWith = challenger.id; challenger.duelWith = p.id;
    p.zone = 'arena'; challenger.zone = 'arena';
    p.x = ARENA_SPAWN.x - 40; p.y = ARENA_SPAWN.y;
    challenger.x = ARENA_SPAWN.x + 40; challenger.y = ARENA_SPAWN.y;
    p.hp = p.maxHp; challenger.hp = challenger.maxHp;
    io.emit('announcement', `⚔️ ${challenger.name} und ${p.name} kämpfen ein Duell in der Arena!`);
  });

  socket.on('ability', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    useAbility(p);
  });

  socket.on('questReroll', (data) => {
    const p = players[socket.id];
    if (!p) return;
    const i = Number(data && data.idx);
    if (!Number.isInteger(i) || i < 0 || i >= p.quests.length) return;
    p.quests[i] = makeQuest(p, p.quests.filter((_, j) => j !== i));
    sendQuests(p);
    saveAccountProgress(p);
  });

  socket.on('equipItem', (d) => {
    const p = players[socket.id];
    if (!p) return;
    const idx = p.inventory.findIndex(it => it.id === (d && d.id));
    if (idx < 0) return;
    const it = p.inventory.splice(idx, 1)[0];
    const old = p.equipment[it.slot];
    p.equipment[it.slot] = it;
    if (old) p.inventory.push(old);
    recomputeStats(p); sendProfile(p); saveAccountProgress(p);
  });

  socket.on('unequipItem', (d) => {
    const p = players[socket.id];
    const slot = d && d.slot;
    if (!p || !SLOTS.includes(slot) || !p.equipment[slot]) return;
    if (p.inventory.length >= INVENTORY_MAX) return notice(p, 'Inventar voll.');
    p.inventory.push(p.equipment[slot]);
    p.equipment[slot] = null;
    recomputeStats(p); sendProfile(p); saveAccountProgress(p);
  });

  socket.on('sellItem', (d) => {
    const p = players[socket.id];
    if (!p) return;
    const idx = p.inventory.findIndex(it => it.id === (d && d.id));
    if (idx < 0) return;
    const it = p.inventory.splice(idx, 1)[0];
    p.gold += sellValue(it);
    sendProfile(p); saveAccountProgress(p);
    notice(p, `💰 ${it.name} verkauft: +${sellValue(it)} Gold`);
  });

  socket.on('upgradeItem', (d) => {
    const p = players[socket.id];
    if (!p) return;
    const id = d && d.id;
    const it = p.inventory.find(x => x.id === id) || SLOTS.map(s => p.equipment[s]).find(x => x && x.id === id);
    if (!it) return;
    if (it.up >= UPGRADE_MAX) return notice(p, 'Maximale Verbesserung erreicht.');
    const cost = upgradeCost(it);
    if (p.essence < cost.essence) return notice(p, `Du brauchst ${cost.essence} Essenz.`);
    if (p.gold < cost.gold) return notice(p, `Du brauchst ${cost.gold} Gold.`);
    p.essence -= cost.essence; p.gold -= cost.gold; it.up++;
    recomputeStats(p); sendProfile(p); saveAccountProgress(p);
    notice(p, `✨ ${it.name} ist jetzt +${it.up}`);
  });

  socket.on('craft', (d) => {
    const p = players[socket.id];
    const r = RECIPES[d && d.recipe];
    if (!p || !r) return;
    if (p.essence < r.essence) return notice(p, `Du brauchst ${r.essence} Essenz.`);
    p.essence -= r.essence;
    for (const k in (r.give || {})) p[k] = (p[k] || 0) + r.give[k];
    saveAccountProgress(p);
    notice(p, `🔨 Hergestellt: ${r.name}`);
  });

  socket.on('storageMove', (d) => {
    const p = players[socket.id];
    if (!p || p.zone !== 'town') return notice(p, 'Das Depot ist nur in der Stadt.');
    if (!p.storage) p.storage = { items: [], gold: 0, essence: 0, potions: 0, speedPotions: 0 };
    const dir = d && d.dir;
    if (dir !== 'in' && dir !== 'out') return;
    if (d.all) {
      const from = dir === 'in' ? p.inventory : p.storage.items;
      const to = dir === 'in' ? p.storage.items : p.inventory;
      const cap = dir === 'in' ? STORAGE_MAX : INVENTORY_MAX;
      let moved = 0;
      while (from.length && to.length < cap) { to.push(from.shift()); moved++; }
      if (!moved) return notice(p, dir === 'in' ? 'Depot ist voll.' : 'Inventar ist voll.');
      if (dir === 'in') { p.stats.deposits = (p.stats.deposits || 0) + moved; checkAchievements(p); }
      sendProfile(p); saveAccountProgress(p);
      notice(p, `📦 ${moved} Gegenstand${moved === 1 ? '' : 'e'} ${dir === 'in' ? 'eingelagert' : 'entnommen'}.`);
      return;
    }
    const id = d && d.itemId;
    const from = dir === 'in' ? p.inventory : p.storage.items;
    const to = dir === 'in' ? p.storage.items : p.inventory;
    const cap = dir === 'in' ? STORAGE_MAX : INVENTORY_MAX;
    const idx = from.findIndex(it => it.id === id);
    if (idx < 0) return;
    if (to.length >= cap) return notice(p, dir === 'in' ? 'Depot ist voll.' : 'Inventar ist voll.');
    to.push(from.splice(idx, 1)[0]);
    if (dir === 'in') { p.stats.deposits = (p.stats.deposits || 0) + 1; checkAchievements(p); }
    sendProfile(p); saveAccountProgress(p);
  });

  socket.on('storageRes', (d) => {
    const p = players[socket.id];
    if (!p || p.zone !== 'town') return notice(p, 'Das Depot ist nur in der Stadt.');
    if (!p.storage) p.storage = { items: [], gold: 0, essence: 0, potions: 0, speedPotions: 0 };
    const dir = d && d.dir;
    const mat = d && d.mat;
    if ((dir !== 'in' && dir !== 'out') || !['gold', 'essence', 'potions', 'speedPotions'].includes(mat)) return;
    const amount = d.all ? Infinity : Math.max(1, Math.min(1000000, Number(d.amount) || 0));
    if (!isFinite(amount)) {
      if (dir === 'in') { p.storage[mat] += p[mat] || 0; p[mat] = 0; }
      else { p[mat] = (p[mat] || 0) + p.storage[mat]; p.storage[mat] = 0; }
    } else {
      const moved = Math.min(amount, dir === 'in' ? (p[mat] || 0) : p.storage[mat]);
      if (moved <= 0) return;
      if (dir === 'in') { p[mat] -= moved; p.storage[mat] += moved; p.stats.deposits = (p.stats.deposits || 0) + 1; checkAchievements(p); }
      else { p.storage[mat] -= moved; p[mat] = (p[mat] || 0) + moved; }
    }
    sendProfile(p); saveAccountProgress(p);
  });

  socket.on('storageSell', (d) => {
    const p = players[socket.id];
    if (!p || p.zone !== 'town') return notice(p, 'Das Depot ist nur in der Stadt.');
    if (!p.storage || !p.storage.items) return;
    const idx = p.storage.items.findIndex(it => it.id === (d && d.id));
    if (idx < 0) return;
    const it = p.storage.items.splice(idx, 1)[0];
    const g = sellValue(it);
    p.gold += g;
    sendProfile(p); saveAccountProgress(p);
    notice(p, `💰 ${it.name} verkauft: +${g} Gold`);
  });

  socket.on('skillUp', (d) => {
    const p = players[socket.id];
    const key = d && d.skill;
    const def = SKILL_DEFS[key];
    if (!p || !def) return;
    if (skillPointsFree(p) <= 0) return notice(p, 'Keine freien Fähigkeitspunkte.');
    if (p.skills[key] >= def.max) return notice(p, 'Diese Fähigkeit ist bereits maximal.');
    p.skills[key]++;
    recomputeStats(p); sendProfile(p); saveAccountProgress(p);
  });

  socket.on('skillReset', () => {
    const p = players[socket.id];
    if (!p) return;
    if (p.gold < SKILL_RESET_COST) return notice(p, `Zurücksetzen kostet ${SKILL_RESET_COST} Gold.`);
    p.gold -= SKILL_RESET_COST;
    for (const k in SKILL_DEFS) p.skills[k] = 0;
    recomputeStats(p); sendProfile(p); saveAccountProgress(p);
  });

  socket.on('buyCosmetic', (d) => {
    const p = players[socket.id];
    const kind = d && d.kind, id = d && d.id;
    if (!p || !COSMETICS[kind] || !COSMETICS[kind][id]) return;
    if (p.cosmetics.owned[kind].includes(id)) return;
    const price = COSMETICS[kind][id].price;
    if (p.gold < price) return notice(p, `Du brauchst ${price} Gold.`);
    p.gold -= price;
    p.cosmetics.owned[kind].push(id);
    p.cosmetics[kind] = id;
    sendProfile(p); saveAccountProgress(p);
  });

  socket.on('setCosmetic', (d) => {
    const p = players[socket.id];
    const kind = d && d.kind, id = d && d.id;
    if (!p || !COSMETICS[kind]) return;
    if (id && !p.cosmetics.owned[kind].includes(id)) return;
    p.cosmetics[kind] = id || null;
    sendProfile(p); saveAccountProgress(p);
  });

  socket.on('buyPet', (data) => {
    const p = players[socket.id];
    if (!p || p.pet) return;
    const key = data && PETS[data.pet] ? data.pet : 'wolf';
    const def = PETS[key];
    if (p.gold < def.cost) return notice(p, `Du brauchst ${def.cost} Gold.`);
    p.gold -= def.cost;
    p.pet = key;
    sendProfile(p); saveAccountProgress(p);
    notice(p, `${def.icon} Dein ${def.name} begleitet dich jetzt!`);
  });

  socket.on('leaderboard', async (d) => {
    const cat = LB_CATEGORIES[d && d.cat] ? d.cat : 'level';
    const cached = lbCache[cat];
    if (!cached || Date.now() - cached.at > 20000) {
      let rows = [];
      if (accountsCol) {
        try {
          const field = LB_CATEGORIES[cat];
          const sort = cat === 'level' ? { level: -1, xp: -1 } : { [field]: -1 };
          const docs = await accountsCol.find({ banned: { $ne: true } }, { projection: { username: 1, level: 1, stats: 1 } }).sort(sort).limit(10).toArray();
          rows = docs.map(x => ({
            name: x.username, level: x.level,
            value: cat === 'level' ? x.level : (x.stats && x.stats[field.split('.')[1]]) || 0
          }));
        } catch (err) { console.error('Rangliste fehlgeschlagen:', err.message); }
      }
      lbCache[cat] = { at: Date.now(), rows };
    }
    socket.emit('leaderboard', { cat, rows: lbCache[cat].rows });
  });

  socket.on('partyInvite', (d) => {
    const p = players[socket.id], t = players[d && d.targetId];
    if (!p || !t || t.id === p.id) return;
    if (t.partyId) return notice(p, `${t.name} ist schon in einer Gruppe.`);
    const party = p.partyId && parties[p.partyId];
    if (party && party.leader !== p.id) return notice(p, 'Nur der Gruppenleiter kann einladen.');
    if (party && party.members.length >= PARTY_MAX) return notice(p, 'Die Gruppe ist voll.');
    partyInvites[t.id] = { fromId: p.id, expires: Date.now() + 30000 };
    io.to(t.id).emit('partyInvited', { fromName: p.name });
    notice(p, `👥 Einladung an ${t.name} gesendet.`);
  });

  socket.on('partyAccept', () => {
    const p = players[socket.id], inv = partyInvites[socket.id];
    if (!p || !inv) return;
    delete partyInvites[socket.id];
    if (Date.now() > inv.expires) return notice(p, 'Die Einladung ist abgelaufen.');
    const from = players[inv.fromId];
    if (!from) return notice(p, 'Der Einladende ist nicht mehr online.');
    if (p.partyId) return;
    let party = from.partyId && parties[from.partyId];
    if (!party) {
      party = { id: 'pt' + (++partyCounter), leader: from.id, members: [from.id] };
      parties[party.id] = party;
      from.partyId = party.id;
    }
    if (party.members.length >= PARTY_MAX) return notice(p, 'Die Gruppe ist voll.');
    party.members.push(p.id);
    p.partyId = party.id;
    for (const m of partyMembers(p)) notice(m, `👥 ${p.name} ist der Gruppe beigetreten.`);
  });

  socket.on('partyDecline', () => {
    const inv = partyInvites[socket.id];
    if (!inv) return;
    delete partyInvites[socket.id];
    const from = players[inv.fromId], me = players[socket.id];
    if (from && me) notice(from, `${me.name} hat die Gruppeneinladung abgelehnt.`);
  });

  socket.on('partyLeave', () => {
    const p = players[socket.id];
    if (!p || !p.partyId) return;
    leaveParty(p);
    notice(p, '👥 Du hast die Gruppe verlassen.');
  });

  socket.on('partyKick', (d) => {
    const p = players[socket.id], t = players[d && d.targetId];
    const party = p && p.partyId && parties[p.partyId];
    if (!party || party.leader !== p.id || !t || t.id === p.id || t.partyId !== p.partyId) return;
    leaveParty(t);
    notice(t, '👥 Du wurdest aus der Gruppe entfernt.');
  });

  socket.on('partyChat', (msg) => {
    const p = players[socket.id];
    if (!p || !msg || !p.partyId) return;
    if (!chatAllowed(p)) return;
    const text = String(msg).slice(0, 80);
    for (const m of partyMembers(p)) io.to(m.id).emit('chat', { name: '[Gruppe] ' + p.name, text });
  });

  socket.on('friendsList', () => { const p = players[socket.id]; if (p) sendFriends(p); });

  socket.on('friendAdd', async (d) => {
    const p = players[socket.id];
    if (!p) return;
    const name = (d && d.username ? String(d.username) : '').trim().toLowerCase().slice(0, 20);
    if (name.length < 3 || name === p.username) return notice(p, 'Ungültiger Name.');
    if (p.friends.includes(name)) return notice(p, 'Schon in deiner Freundesliste.');
    if (p.friends.length >= 50) return notice(p, 'Deine Freundesliste ist voll.');
    const acc = await loadAccount(name);
    if (!acc) return notice(p, 'Diesen Spieler gibt es nicht.');
    p.friends.push(name);
    sendFriends(p);
    saveAccountProgress(p);
  });

  socket.on('friendRemove', (d) => {
    const p = players[socket.id];
    if (!p) return;
    p.friends = p.friends.filter(u => u !== (d && d.username));
    sendFriends(p);
    saveAccountProgress(p);
  });

  socket.on('tradeOffer', (d) => {
    const p = players[socket.id], t = players[d && d.targetId];
    if (!p || !t || t.id === p.id) return;
    const item = p.inventory.find(i => i.id === (d && d.itemId));
    if (!item) return;
    const price = Math.floor(Number(d.price));
    if (!Number.isFinite(price) || price < 0 || price > 1000000) return notice(p, 'Ungültiger Preis.');
    tradeOffers[t.id] = { fromId: p.id, itemId: item.id, price, expires: Date.now() + 45000 };
    io.to(t.id).emit('tradeIncoming', { fromName: p.name, item: withEff(item), price });
    notice(p, `🤝 Angebot an ${t.name} gesendet.`);
  });

  socket.on('tradeAccept', () => {
    const buyer = players[socket.id], off = tradeOffers[socket.id];
    if (!buyer || !off) return;
    delete tradeOffers[socket.id];
    if (Date.now() > off.expires) return notice(buyer, 'Das Angebot ist abgelaufen.');
    const seller = players[off.fromId];
    if (!seller) return notice(buyer, 'Der Verkäufer ist nicht mehr online.');
    const idx = seller.inventory.findIndex(i => i.id === off.itemId);
    if (idx < 0) return notice(buyer, 'Der Gegenstand ist nicht mehr verfügbar.');
    if (buyer.gold < off.price) return notice(buyer, `Du brauchst ${off.price} Gold.`);
    if (buyer.inventory.length >= INVENTORY_MAX) return notice(buyer, 'Dein Inventar ist voll.');
    const item = seller.inventory.splice(idx, 1)[0];
    buyer.inventory.push(item);
    buyer.gold -= off.price;
    seller.gold += off.price;
    sendProfile(buyer); sendProfile(seller);
    saveAccountProgress(buyer); saveAccountProgress(seller);
    notice(buyer, `🤝 ${item.name} gekauft für ${off.price} Gold.`);
    notice(seller, `🤝 ${item.name} verkauft an ${buyer.name}: +${off.price} Gold.`);
  });

  socket.on('tradeDeny', () => {
    const off = tradeOffers[socket.id];
    if (!off) return;
    delete tradeOffers[socket.id];
    const seller = players[off.fromId], me = players[socket.id];
    if (seller && me) notice(seller, `${me.name} hat dein Angebot abgelehnt.`);
  });

  socket.on('adminKick', (d) => {
    const p = players[socket.id], t = players[d && d.targetId];
    if (!p || !p.isAdmin || !t || t.id === p.id || t.isAdmin) return;
    io.to(t.id).emit('kicked', 'Du wurdest von einem Admin entfernt.');
    disconnectSocket(t.id);
    notice(p, `${t.name} wurde entfernt.`);
  });

  socket.on('adminBan', async (d) => {
    const p = players[socket.id], t = players[d && d.targetId];
    if (!p || !p.isAdmin || !t || t.id === p.id || t.isAdmin) return;
    if (accountsCol) await accountsCol.updateOne({ username: t.username }, { $set: { banned: true } });
    io.to(t.id).emit('kicked', 'Dein Account wurde gesperrt.');
    disconnectSocket(t.id);
    notice(p, `${t.name} wurde gesperrt.`);
  });

  socket.on('adminUnban', async (d) => {
    const p = players[socket.id];
    if (!p || !p.isAdmin || !accountsCol) return;
    const name = (d && d.username ? String(d.username) : '').trim().toLowerCase().slice(0, 20);
    if (name.length < 3) return;
    await accountsCol.updateOne({ username: name }, { $set: { banned: false } });
    notice(p, `${name} wurde entsperrt.`);
  });

  socket.on('adminSupporter', async (d) => {
    const p = players[socket.id];
    if (!p || !p.isAdmin || !accountsCol) return;
    const name = (d && d.username ? String(d.username) : '').trim().toLowerCase().slice(0, 20);
    const on = !!(d && d.on);
    if (name.length < 3) return;
    await accountsCol.updateOne({ username: name }, { $set: { supporter: on } });
    const t = findOnline(name);
    if (t) { t.role = roleFor(t.username, { supporter: on }); notice(t, on ? '☕ Du bist jetzt Supporter! Danke für deine Unterstützung!' : 'Dein Supporter-Status wurde entfernt.'); }
    notice(p, `${name}: Supporter ${on ? 'verliehen' : 'entfernt'}.`);
  });

  socket.on('adminAction', (d) => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    const kind = d && d.kind;
    const zone = isDungeonTier(p.zone) ? p.zone : tierForLevel(p.level);
    if (kind === 'treasure') spawnTreasureGoblin(zone);
    else if (kind === 'ambush') runAmbush(zone, p);
    else if (kind === 'blessing') runBlessing(zone);
    else if (kind === 'tierboss') spawnTierBoss(zone);
    else if (kind === 'raid') { if (!startRaid()) notice(p, 'Es läuft schon ein Raid.'); }
    else if (kind === 'goldevent') { goldEventUntil = Date.now() + 5 * 60000; io.emit('announcement', `💰 ${p.name} startet ein Doppel-Gold-Event! (5 Minuten)`); }
    else if (kind === 'xpevent') { xpEventUntil = Date.now() + 5 * 60000; io.emit('announcement', `✨ ${p.name} startet ein Doppel-XP-Event! (5 Minuten)`); }
    else if (kind === 'wave') { for (let i = 0; i < 10; i++) spawnMonster(isDungeonTier(p.zone) ? p.zone : DEFAULT_TIER_KEY); io.emit('announcement', `👹 ${p.name} hat eine Monsterwelle beschworen!`); }
    else if (kind === 'boss') { bossCycle(); io.emit('announcement', `👑 ${p.name} hat den Boss sofort herbeigerufen!`); }
    else if (kind === 'heal') { for (const id in players) { const pl = players[id]; pl.hp = pl.maxHp; pl.dead = false; } io.emit('announcement', `💚 ${p.name} hat alle vollständig geheilt!`); }
    else if (kind === 'announce') { const text = String((d && d.text) || '').slice(0, 140).trim(); if (text) io.emit('announcement', `📢 ${text}`); }
  });

  socket.on('logout', async () => {
    const p = players[socket.id];
    if (!p) return;
    if (accountsCol) await accountsCol.updateOne({ username: p.username }, { $unset: { sessionToken: '' } });
    await saveAccountProgress(p);
    delete players[socket.id];
    leaveParty(p);
    disconnectSocket(socket.id);
  });

  socket.on('guildInfo', () => { const p = players[socket.id]; if (p) sendGuild(p); });

  socket.on('guildCreate', async (d) => {
    const p = players[socket.id];
    if (!p) return;
    if (p.guild) return notice(p, 'Du bist schon in einer Gilde.');
    if (!guildsCol) return notice(p, 'Gilden sind ohne Datenbank nicht verfügbar.');
    const name = String((d && d.name) || '').trim().replace(/\s+/g, ' ');
    const tag = String((d && d.tag) || '').trim().toUpperCase();
    if (!/^[A-Za-z0-9ÄÖÜäöüß][A-Za-z0-9ÄÖÜäöüß \-]{2,15}$/.test(name)) return notice(p, 'Gildenname: 3 bis 16 Zeichen (Buchstaben, Zahlen, Leerzeichen, Bindestrich).');
    if (!/^[A-Z0-9]{2,4}$/.test(tag)) return notice(p, 'Kürzel: 2 bis 4 Buchstaben oder Zahlen.');
    if (p.gold < GUILD_COST) return notice(p, `Eine Gilde zu gründen kostet ${GUILD_COST} Gold.`);
    const key = name.toLowerCase();
    if (await guildsCol.findOne({ key })) return notice(p, 'Diesen Gildennamen gibt es schon.');
    if (await guildsCol.findOne({ tag })) return notice(p, 'Dieses Kürzel ist schon vergeben.');
    if (p.guild || !players[socket.id]) return;
    const g = { key, name, tag, leader: p.username, members: [p.username], createdAt: new Date() };
    try { await guildsCol.insertOne(g); } catch (err) { return notice(p, 'Die Gilde konnte nicht gegründet werden.'); }
    guildCache.set(key, g);
    p.gold -= GUILD_COST;
    setGuild(p, g);
    saveAccountProgress(p);
    sendGuild(p);
    notice(p, `🏰 Gilde „${name}“ [${tag}] gegründet!`);
  });

  socket.on('guildInvite', (d) => {
    const p = players[socket.id], t = players[d && d.targetId];
    if (!p || !t || t.id === p.id || !p.guild) return;
    const g = guildCache.get(p.guild);
    if (!g) return;
    if (t.guild) return notice(p, `${t.name} ist schon in einer Gilde.`);
    if (g.members.length >= GUILD_MAX) return notice(p, 'Die Gilde ist voll.');
    guildInvites[t.id] = { fromId: p.id, guild: g.key, expires: Date.now() + 45000 };
    io.to(t.id).emit('guildInvited', { fromName: p.name, guildName: g.name, tag: g.tag });
    notice(p, `🏰 Einladung an ${t.name} gesendet.`);
  });

  socket.on('guildAccept', async () => {
    const p = players[socket.id], inv = guildInvites[socket.id];
    if (!p || !inv) return;
    delete guildInvites[socket.id];
    if (Date.now() > inv.expires) return notice(p, 'Die Einladung ist abgelaufen.');
    if (p.guild) return;
    const g = await loadGuild(inv.guild);
    if (!g) return notice(p, 'Diese Gilde gibt es nicht mehr.');
    if (g.members.length >= GUILD_MAX) return notice(p, 'Die Gilde ist voll.');
    if (p.guild || !players[socket.id] || g.members.includes(p.username)) return;
    g.members.push(p.username);
    await saveGuild(g);
    setGuild(p, g);
    saveAccountProgress(p);
    for (const o of guildOnline(g)) notice(o, `🏰 ${p.name} ist der Gilde beigetreten.`);
    refreshGuildMembers(g);
  });

  socket.on('guildDecline', () => {
    const inv = guildInvites[socket.id];
    if (!inv) return;
    delete guildInvites[socket.id];
    const from = players[inv.fromId], me = players[socket.id];
    if (from && me) notice(from, `${me.name} hat die Gildeneinladung abgelehnt.`);
  });

  async function removeFromGuild(g, username) {
    g.members = g.members.filter(u => u !== username);
    const o = findOnline(username);
    if (o) { setGuild(o, null); saveAccountProgress(o); io.to(o.id).emit('guild', null); }
    if (!g.members.length) {
      guildCache.delete(g.key);
      if (guildsCol) await guildsCol.deleteOne({ key: g.key });
      return;
    }
    if (g.leader === username) g.leader = g.members[0];
    await saveGuild(g);
    refreshGuildMembers(g);
  }

  socket.on('guildLeave', async () => {
    const p = players[socket.id];
    const g = p && p.guild && guildCache.get(p.guild);
    if (!g) return;
    const name = p.name;
    await removeFromGuild(g, p.username);
    notice(p, '🏰 Du hast die Gilde verlassen.');
    for (const o of guildOnline(g)) notice(o, `🏰 ${name} hat die Gilde verlassen.`);
  });

  socket.on('guildKick', async (d) => {
    const p = players[socket.id];
    const g = p && p.guild && guildCache.get(p.guild);
    const target = String((d && d.username) || '');
    if (!g || g.leader !== p.username || target === p.username || !g.members.includes(target)) return;
    const o = findOnline(target);
    await removeFromGuild(g, target);
    if (o) notice(o, '🏰 Du wurdest aus der Gilde entfernt.');
    notice(p, `${target} wurde aus der Gilde entfernt.`);
  });

  socket.on('guildDisband', async () => {
    const p = players[socket.id];
    const g = p && p.guild && guildCache.get(p.guild);
    if (!g || g.leader !== p.username) return;
    const members = guildOnline(g);
    guildCache.delete(g.key);
    if (guildsCol) await guildsCol.deleteOne({ key: g.key });
    for (const o of members) { setGuild(o, null); saveAccountProgress(o); io.to(o.id).emit('guild', null); notice(o, '🏰 Die Gilde wurde aufgelöst.'); }
  });

  socket.on('guildChat', (msg) => {
    const p = players[socket.id];
    const g = p && p.guild && guildCache.get(p.guild);
    if (!g || !msg || !chatAllowed(p)) return;
    const text = String(msg).slice(0, 80);
    for (const o of guildOnline(g)) io.to(o.id).emit('chat', { name: '[Gilde] ' + p.name, text });
  });

  socket.on('travelToTier', (data) => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    const key = data && data.tier;
    const tierDef = DUNGEON_TIERS[key];
    if (!tierDef) return;
    if (p.level < tierDef.minLevel && p.role !== 'owner') {
      return socket.emit('shopError', `Benötigt Level ${tierDef.minLevel} (du bist Level ${p.level}).`);
    }
    p.zone = key;
    const sp = randomTierSpawn(key);
    p.x = sp.x; p.y = sp.y;
    p.hp = p.maxHp;
    p.dead = false;
  });

  socket.on('openChest', (data) => {
    const p = players[socket.id];
    if (!p || p.dead || !isDungeonTier(p.zone)) return;
    const chest = chests[data && data.chestId];
    if (!chest || chest.looted || chest.zone !== p.zone) return;
    if (dist(p.x, p.y, chest.x, chest.y) > 44) return;

    chest.looted = true;
    chest.respawnAt = chest.room ? Infinity : Date.now() + CHEST_RESPAWN_MS;
    if (chest.room) chest.room.lootedAt = Date.now();
    const lootMult = (DUNGEON_TIERS[p.zone] && DUNGEON_TIERS[p.zone].lootMult) || 1;
    const roomMult = chest.kind === 'vault' ? 5 : (chest.kind === 'secret' ? 2.5 : 1);
    const gold = Math.round((20 + Math.floor(Math.random() * 40)) * roomMult * goldMult() * lootMult * goldBonus(p));
    const gotPotion = chest.kind === 'vault' ? true : Math.random() < 0.35;
    p.gold += gold;
    if (gotPotion) p.potions += 1;
    p.stats.chests++; p.stats.goldEarned += gold;
    questProgress(p, 'chest', 1);
    questProgress(p, 'gold', gold);
    if (chest.kind === 'vault') {
      giveItem(p, genItem(p.level, Math.max(2, rollRarity(2 + luckOf(p)))));
      giveItem(p, genItem(p.level, rollRarity(1.5 + luckOf(p))));
      p.essence += 10 + Math.round(lootMult * 4);
      p.stats.vaults++; addSeasonPoints(p, 6);
    } else if (chest.kind === 'secret') {
      if (Math.random() < 0.5) giveItem(p, genItem(p.level, Math.max(1, rollRarity(1.2 + luckOf(p)))));
      if (Math.random() < 0.4) giveKey(p, 1);
      addSeasonPoints(p, 3);
    } else {
      if (Math.random() < 0.25) giveItem(p, genItem(p.level, rollRarity(0.5 + luckOf(p))));
      if (Math.random() < 0.10) giveKey(p, 1);
    }
    checkAchievements(p);
    socket.emit('lootResult', { gold, potion: gotPotion });
    saveAccountProgress(p);
  });

  socket.on('useItem', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    if (p.potions > 0 && p.hp < p.maxHp) {
      p.potions -= 1;
      p.hp = Math.min(p.maxHp, p.hp + Math.floor(p.maxHp * 0.4));
      p.fx = {};
    }
  });

  socket.on('buyItem', (data) => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    if (p.zone !== 'town') return socket.emit('shopError', 'Der Shop ist nur in der Stadt verfügbar.');
    const type = data && data.type;
    const def = SHOP_ITEMS[type];
    if (!def) return;

    if (type === 'potion') {
      const cost = shopCost('potion', 0);
      if (p.gold < cost) return socket.emit('shopError', 'Nicht genug Gold.');
      p.gold -= cost;
      p.potions += 1;
    } else if (type === 'speedpotion') {
      const cost = shopCost('speedpotion', 0);
      if (p.gold < cost) return socket.emit('shopError', 'Nicht genug Gold.');
      p.gold -= cost;
      p.speedPotions += 1;
    } else {
      const countKey = UPG_KEYS[type];
      const current = p[countKey];
      if (def.maxCount !== null && current >= def.maxCount) {
        return socket.emit('shopError', 'Maximum für dieses Upgrade erreicht.');
      }
      const cost = shopCost(type, current);
      if (p.gold < cost) return socket.emit('shopError', 'Nicht genug Gold.');
      p.gold -= cost;
      p[countKey] += 1;
      recomputeStats(p);
    }
    saveAccountProgress(p);
  });

  socket.on('jokerBuff', () => {
    const p = players[socket.id];
    if (!p || p.dead || p.zone !== 'town') return;
    const now = Date.now();
    if (now < (p.jokerAt || 0)) return notice(p, `🤡 Finn macht erst in ${Math.ceil((p.jokerAt - now) / 60000)} Min. wieder einen Spruch.`);
    p.jokerAt = now + 5 * 60000;
    const roll = Math.random();
    if (roll < 0.3) {
      p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.4));
      notice(p, '🤡 „Heilkraut!" — du bist wieder fit!');
    } else if (roll < 0.6) {
      p.speedBoostUntil = now + 60000;
      notice(p, '🤡 „Spring in den Sack!" — 60 s Turbo-Tempo!');
    } else if (roll < 0.85) {
      p.gold += 60;
      notice(p, '🤡 „Zaubermünze!" — 60 Gold für dich!');
    } else {
      p.essence += 8;
      notice(p, '🤡 „Glitzerpulver!" — 8 Essenz für dich!');
    }
    io.to(p.id).emit('abilityFx', { type: 'nova', x: p.x, y: p.y, r: 60, zone: p.zone });
  });

  socket.on('emote', (e) => {
    const p = players[socket.id];
    const txt = EMOTES[e];
    if (!p || !txt) return;
    io.emit('emote', { name: p.name, text: txt });
  });

  socket.on('setMagnet', (on) => {
    const p = players[socket.id];
    if (p) p.magnet = !!on;
  });

  socket.on('useSpeedPotion', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    if (p.speedPotions > 0) {
      p.speedPotions -= 1;
      p.speedBoostUntil = Date.now() + 15000;
      saveAccountProgress(p);
    }
  });

  socket.on('chat', (msg) => {
    const p = players[socket.id];
    if (!p || !msg) return;
    if (!chatAllowed(p)) return;
    const text = String(msg).slice(0, 80);
    if (text.startsWith('/nick')) {
      const nn = text.slice(5).trim().replace(/\s+/g, ' ');
      if (nn.length < 3 || nn.length > 16) return notice(p, 'Name: 3 bis 16 Zeichen.');
      p.name = nn;
      saveAccountProgress(p);
      return notice(p, `Dein Name ist jetzt ${nn}.`);
    }
    if (text === '/roll') { io.emit('chat', { name: p.name, text: 'würfelt ' + (1 + Math.floor(Math.random() * 100)) + '!' }); return; }
    if (text === '/flip') { io.emit('chat', { name: p.name, text: 'wirft eine Münze: ' + (Math.random() < 0.5 ? 'Kopf!' : 'Zahl!') }); return; }
    io.emit('chat', { name: p.name, text });
  });

  // ---- Gildenbank: gemeinsames Lager fuer alle Gildenmitglieder ----
  socket.on('guildBankOpen', async () => {
    const p = players[socket.id];
    if (!p || !p.guild) return;
    const g = await loadGuild(p.guild);
    if (!g) return;
    const b = guildBank(g);
    socket.emit('guildBank', { items: b.items.map(withEff), gold: b.gold, max: GUILD_BANK_MAX });
  });

  socket.on('guildBankMove', async (d) => {
    const p = players[socket.id];
    if (!p || !p.guild) return;
    const dir = d && d.dir;
    if (dir !== 'in' && dir !== 'out') return;
    const g = await loadGuild(p.guild);
    if (!g) return;
    const b = guildBank(g);
    if (d.all) {
      const from = dir === 'in' ? p.inventory : b.items;
      const to = dir === 'in' ? b.items : p.inventory;
      const cap = dir === 'in' ? GUILD_BANK_MAX : INVENTORY_MAX;
      let moved = 0;
      while (from.length && to.length < cap) { to.push(from.shift()); moved++; }
      if (!moved) return notice(p, dir === 'in' ? 'Gildenbank ist voll.' : 'Inventar ist voll.');
      sendProfile(p);
      socket.emit('guildBank', { items: b.items.map(withEff), gold: b.gold, max: GUILD_BANK_MAX });
      saveGuild(g);
      notice(p, `🏦 ${moved} Gegenstand${moved === 1 ? '' : 'e'} ${dir === 'in' ? 'eingelagert' : 'entnommen'}.`);
      return;
    }
    const from = dir === 'in' ? p.inventory : b.items;
    const to = dir === 'in' ? b.items : p.inventory;
    const cap = dir === 'in' ? GUILD_BANK_MAX : INVENTORY_MAX;
    const idx = from.findIndex(it => it.id === (d && d.itemId));
    if (idx < 0) return;
    if (to.length >= cap) return notice(p, dir === 'in' ? 'Gildenbank ist voll.' : 'Inventar ist voll.');
    to.push(from.splice(idx, 1)[0]);
    sendProfile(p);
    socket.emit('guildBank', { items: b.items.map(withEff), gold: b.gold, max: GUILD_BANK_MAX });
    saveGuild(g);
  });

  socket.on('guildBankGold', async (d) => {
    const p = players[socket.id];
    if (!p || !p.guild) return;
    const dir = d && d.dir;
    if (dir !== 'in' && dir !== 'out') return;
    const g = await loadGuild(p.guild);
    if (!g) return;
    const b = guildBank(g);
    const amount = d.all ? Infinity : Math.max(1, Math.min(1000000, Number(d.amount) || 0));
    if (!isFinite(amount)) {
      if (dir === 'in') { b.gold += p.gold; p.gold = 0; }
      else { p.gold += b.gold; b.gold = 0; }
    } else {
      const moved = Math.min(amount, dir === 'in' ? p.gold : b.gold);
      if (moved <= 0) return;
      if (dir === 'in') { p.gold -= moved; b.gold += moved; }
      else { b.gold -= moved; p.gold += moved; }
    }
    sendProfile(p);
    socket.emit('guildBank', { items: b.items.map(withEff), gold: b.gold, max: GUILD_BANK_MAX });
    saveGuild(g);
  });

  // ---- Admin-Aktionen: serverseitig IMMER erneut gegen isAdmin geprueft ----
  socket.on('adminGiveGold', (data) => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    const amount = Math.max(1, Math.min(9999, parseInt(data && data.amount, 10) || 50));
    if (data && data.target === 'self') {
      p.gold += amount;
      saveAccountProgress(p);
    } else {
      for (const id in players) {
        players[id].gold += amount;
        saveAccountProgress(players[id]);
      }
      io.emit('announcement', `🎉 ${p.name} lässt Gold regnen: +${amount} Gold für alle!`);
    }
  });

  socket.on('adminGivePotions', (data) => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    const amount = Math.max(1, Math.min(20, parseInt(data && data.amount, 10) || 3));
    if (data && data.target === 'self') {
      p.potions += amount;
      saveAccountProgress(p);
    } else {
      for (const id in players) {
        players[id].potions += amount;
        saveAccountProgress(players[id]);
      }
      io.emit('announcement', `🧪 ${p.name} verteilt ${amount} Heiltränke an alle!`);
    }
  });

  // ---------------- Stadt, 2. Faehigkeit, Tresore, Raid, Wiedergeburt, Saison ----------------
  socket.on('joinTown', () => {
    const p = players[socket.id];
    if (!p || p.dead || p.zone === 'town') return;
    if (p.zone === 'raid' || p.zone === 'bossroom') return notice(p, 'In diesem Bereich geht das nicht.');
    p.zone = 'town'; p.x = TOWN_SPAWN.x; p.y = TOWN_SPAWN.y; p.hp = p.maxHp; p.fx = {};
  });
  socket.on('leaveTown', () => {
    const p = players[socket.id];
    if (!p || p.zone !== 'town') return;
    p.zone = tierForLevel(p.level);
    const sp = randomTierSpawn(p.zone);
    p.x = sp.x; p.y = sp.y; p.hp = p.maxHp;
  });

  socket.on('ability2', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    useAbility2(p);
  });

  socket.on('openDoor', () => {
    const p = players[socket.id];
    if (!p || p.dead || !isDungeonTier(p.zone)) return;
    const feat = FEATURES[p.zone], map = DUNGEON_TIERS[p.zone].map;
    for (const room of feat.vaults) {
      const k = room.door.x + ',' + room.door.y;
      if (map.open.has(k)) continue;
      if (dist(p.x, p.y, room.door.x * TILE + TILE / 2, room.door.y * TILE + TILE / 2) > 56) continue;
      if (!p.keys) return notice(p, '🔒 Du brauchst einen Schlüssel. Monster, Truhen und Bosse lassen welche fallen.');
      p.keys -= 1;
      map.open.add(k);
      notice(p, '🔓 Tresortür geöffnet!');
      saveAccountProgress(p);
      return;
    }
  });

  socket.on('joinRaid', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    if (!raid.active || !monsters[raid.bossId]) return notice(p, '🐉 Aktuell läuft kein Raid.');
    if (p.level < RAID_MIN_LEVEL) return notice(p, `Der Raid ist ab Level ${RAID_MIN_LEVEL}.`);
    if ((raid.deaths[p.username] || 0) > RAID_MAX_DEATHS) return notice(p, 'Du bist in diesem Raid zu oft gefallen.');
    if (p.zone !== 'raid') { p.zone = 'raid'; p.x = RAID_ENTRY.x; p.y = RAID_ENTRY.y; p.hp = p.maxHp; p.fx = {}; }
    if (!raid.joined.has(p.username)) {
      raid.joined.add(p.username);
      const m = monsters[raid.bossId];
      m.maxHp += raid.perPlayerHp; m.hp += raid.perPlayerHp;   // mehr Spieler, mehr Leben
      announceTo(q => q.zone === 'raid', `⚔️ ${p.name} ist dem Raid beigetreten!`);
    }
  });
  socket.on('leaveRaid', () => {
    const p = players[socket.id];
    if (!p || p.zone !== 'raid') return;
    p.zone = tierForLevel(p.level);
    const sp = randomTierSpawn(p.zone);
    p.x = sp.x; p.y = sp.y; p.hp = p.maxHp; p.dead = false;
  });

  socket.on('prestige', () => {
    const p = players[socket.id];
    if (!p || p.dead || !(p.zone === 'town' || isDungeonTier(p.zone))) return;
    if (p.level < PRESTIGE_MIN_LEVEL) return notice(p, `Die Wiedergeburt ist ab Level ${PRESTIGE_MIN_LEVEL} möglich.`);
    if ((p.prestige || 0) >= PRESTIGE_MAX) return notice(p, 'Du hast die höchste Wiedergeburtsstufe erreicht.');
    p.prestige = (p.prestige || 0) + 1;
    p.level = 1; p.xp = 0; p.xpNext = xpToNextLevel(1);
    p.skills = {};
    p.gold += 500 * p.prestige; p.essence += 100;
    recomputeStats(p);
    p.hp = p.maxHp; p.fx = {};
    if (p.zone !== 'town') {
      p.zone = tierForLevel(p.level);
      const sp = randomTierSpawn(p.zone);
      p.x = sp.x; p.y = sp.y;
    }
    giveItem(p, genItem(40, 3));
    checkAchievements(p);
    saveAccountProgress(p);
    sendProfile(p);
    io.emit('announcement', `⭐ ${p.name} ist wiedergeboren (Stufe ${p.prestige})!`);
  });

  socket.on('changeClass', (d) => {
    const p = players[socket.id];
    const cls = d && d.cls;
    if (!p || p.dead || !CLASSES[cls] || cls === p.cls) return;
    if (!(p.zone === 'town' || isDungeonTier(p.zone))) return notice(p, 'Klassenwechsel geht nur in der Stadt oder im Dungeon.');
    if (p.gold < CLASS_CHANGE_COST) return notice(p, `Ein Klassenwechsel kostet ${CLASS_CHANGE_COST} Gold.`);
    p.gold -= CLASS_CHANGE_COST;
    p.cls = cls; p.abilityReadyAt = 0; p.ability2ReadyAt = 0; p.critUntil = 0; p.guardUntil = 0; p.rageUntil = 0; p.lifestealUntil = 0;
    recomputeStats(p);
    p.hp = p.maxHp;
    notice(p, `🔄 Du bist jetzt ${CLASSES[cls].name}!`);
    saveAccountProgress(p);
    sendProfile(p);
  });

  socket.on('seasonInfo', () => {
    const p = players[socket.id];
    if (!p) return;
    checkSeason(p);
    sendSeason(p);
    checkWeek(p);
    sendWeek(p);
  });
  let seasonLb = { at: 0, id: '', rows: [] };
  socket.on('seasonBoard', async () => {
    const id = seasonId();
    if (Date.now() - seasonLb.at > 20000 || seasonLb.id !== id) {
      let rows = [];
      if (accountsCol) {
        try {
          const docs = await accountsCol.find({ 'season.id': id, banned: { $ne: true } }, { projection: { username: 1, level: 1, prestige: 1, season: 1 } }).sort({ 'season.points': -1 }).limit(10).toArray();
          rows = docs.map(x => ({ name: x.username, level: x.level, prestige: x.prestige || 0, value: (x.season && x.season.points) || 0 }));
        } catch (err) { console.error('Saison-Rangliste fehlgeschlagen:', err.message); }
      }
      seasonLb = { at: Date.now(), id, rows };
    }
    socket.emit('seasonBoard', { id, rows: seasonLb.rows });
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) saveAccountProgress(p);
    if (p) leaveParty(p);
    delete players[socket.id];
    if (p) notifyFriendsOf(p, null);
    if (p && p.guild && guildCache.get(p.guild)) refreshGuildMembers(guildCache.get(p.guild));
    delete partyInvites[socket.id];
    delete tradeOffers[socket.id];
    delete tpaRequests[socket.id];
    for (const targetId in tpaRequests) {
      if (tpaRequests[targetId].fromId === socket.id) delete tpaRequests[targetId];
    }
    delete duelRequests[socket.id];
    for (const targetId in duelRequests) {
      if (duelRequests[targetId].fromId === socket.id) delete duelRequests[targetId];
    }
    if (p && p.duelWith) { const o = players[p.duelWith]; if (o) o.duelWith = null; }
  });
});

// Autosave alle 30 Sekunden, falls der Server mal ohne "disconnect" beendet wird
setInterval(() => {
  for (const id in players) saveAccountProgress(players[id]);
}, 30000);

// ---------------- Game-Loop ----------------
function tick() {
  const dtScale = 1;

  // Spieler bewegen
  for (const id in players) {
    const p = players[id];
    if (p.dead) continue;
    const inp = p.input;
    let dx = 0, dy = 0;
    if (inp.up) dy -= 1;
    if (inp.down) dy += 1;
    if (inp.left) dx -= 1;
    if (inp.right) dx += 1;
    if (dx !== 0 || dy !== 0) {
      const boosted = Date.now() < p.speedBoostUntil;
      const slowed = p.fx && p.fx.slow > Date.now();
      const effSpeed = p.speed * (boosted ? 1.6 : 1) * (slowed ? 0.6 : 1);
      const len = Math.hypot(dx, dy);
      dx = (dx / len) * effSpeed * dtScale;
      dy = (dy / len) * effSpeed * dtScale;
      tryMove(mapFor(p.zone), p, dx, dy, 12);
    }
    updateEffects(p, Date.now());
    updatePet(p);
    if (p.zone === 'town' && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.004);   // Brunnen: Heilung in der Stadt
    if (isDungeonTier(p.zone)) checkTraps(p, Date.now());
    if (!isDungeonTier(p.zone) && p.zone !== 'bossroom' && p.zone !== 'raid') continue;
    // Items einsammeln (nur passend zur eigenen Zone)
    for (const iid in items) {
      const it = items[iid];
      if ((it.zone || DEFAULT_TIER_KEY) !== p.zone) continue;
      if (dist(p.x, p.y, it.x, it.y) < (p.magnet ? 70 : 20)) {
        if (it.type === 'gold') { const g = Math.round(it.amount * goldBonus(p)); p.gold += g; p.stats.goldEarned += g; questProgress(p, 'gold', g); checkAchievements(p); }
        else if (it.type === 'potion') p.potions += 1;
        delete items[iid];
      }
    }
  }

  updateRooms();

  // Truhen: respawnen nach Cooldown
  for (const cid in chests) {
    const c = chests[cid];
    if (c.looted && Date.now() > c.respawnAt) c.looted = false;
  }

  // Monster-KI
  for (const id in monsters) {
    const m = monsters[id];
    const mZone = m.zone || DEFAULT_TIER_KEY;
    const mMap = mapFor(mZone);
    if (m.type === 'treasure') { updateTreasure(id, m, mMap); continue; }
    let target = null, targetDist = Infinity;
    for (const pid in players) {
      const p = players[pid];
      if (p.dead || p.zone !== mZone) continue;
      const d = dist(m.x, m.y, p.x, p.y);
      const aggro = m.type === 'raidboss' ? 1800 : (MONSTER_TYPES[m.type].ranged ? MONSTER_TYPES[m.type].range + 80 : 180);
      if (d < aggro && d < targetDist) { target = p; targetDist = d; }
    }
    if (target) {
      const def = MONSTER_TYPES[m.type];
      if (m.type === 'boss' || m.type === 'raidboss') { bossSlam(m, def); bossSpecial(m, def); }
      if (def.ranged) {
        rangedAI(m, def, target, targetDist, mMap);
      } else if (targetDist > def.range) {
        const angle = Math.atan2(target.y - m.y, target.x - m.x);
        tryMove(mMap, m, Math.cos(angle) * def.speed * (m.speedMul || 1), Math.sin(angle) * def.speed * (m.speedMul || 1), Math.min(def.radius, 14));
      } else {
        const now = Date.now();
        if (now - m.lastAttack > def.cooldown) {
          m.lastAttack = now;
          if (def.dmg > 0) {
            const dmg = Math.round(def.dmg * (m.dmgMult || 1));
            damagePlayer(target, dmg, m.name || MONSTER_TYPES[m.type].name || 'einem Monster');
            if (def.effect) applyEffect(target, def.effect, dmg);
          }
        }
      }
    } else {
      // zurueck zum Ausgangspunkt schlendern
      const d = dist(m.x, m.y, m.homeX, m.homeY);
      if (d > 10) {
        const angle = Math.atan2(m.homeY - m.y, m.homeX - m.x);
        tryMove(mMap, m, Math.cos(angle) * 0.6, Math.sin(angle) * 0.6, Math.min(MONSTER_TYPES[m.type].radius, 14));
      }
    }
  }

  // Projektile
  for (const id in projectiles) {
    const pr = projectiles[id];
    pr.x += pr.vx;
    pr.y += pr.vy;
    pr.life -= 1;
    let hitSomething = false;
    const pMap = mapFor(pr.zone);
    if (pMap.isWall(Math.floor(pr.x / TILE), Math.floor(pr.y / TILE))) hitSomething = true;

    if (pr.hostile) {
      if (!hitSomething) {
        for (const pid in players) {
          const pl = players[pid];
          if (pl.dead || pl.zone !== pr.zone) continue;
          if (dist(pr.x, pr.y, pl.x, pl.y) < 20) {
            const srcM = monsters[pr.ownerId];
            damagePlayer(pl, pr.dmg, srcM ? (srcM.name || (MONSTER_TYPES[srcM.type] && MONSTER_TYPES[srcM.type].name) || 'einem Monster') : 'einem Monster');
            if (pr.effect) applyEffect(pl, pr.effect, pr.dmg);
            hitSomething = true;
            break;
          }
        }
      }
    } else if (!hitSomething && pr.zone === 'arena') {
      for (const pid in players) {
        const other = players[pid];
        if (pid === pr.ownerId || other.zone !== 'arena' || other.dead) continue;
        if (dist(pr.x, pr.y, other.x, other.y) < 16) {
          const owner = players[pr.ownerId];
          applyPvpDamage(other, pr.dmg, owner);
          hitSomething = true;
          break;
        }
      }
    } else if (!hitSomething) {
      for (const mid in monsters) {
        const m = monsters[mid];
        if ((m.zone || DEFAULT_TIER_KEY) !== pr.zone) continue;
        if (dist(pr.x, pr.y, m.x, m.y) < Math.max(16, monsterRadius(m) + 6)) {
          m.hp -= pr.dmg;
          if (m.raid && players[pr.ownerId]) creditRaid(m, players[pr.ownerId], pr.dmg);
          io.emit('hit', { x: m.x, y: m.y, dmg: pr.dmg });
          if (m.hp <= 0) {
            onMonsterKilled(m, players[pr.ownerId]);
            delete monsters[mid];
          }
          hitSomething = true;
          break;
        }
      }
    }
    if (hitSomething || pr.life <= 0) delete projectiles[id];
  }

  broadcastState();
}

const NEAR = 1500;           // Sichtweite in Pixeln: nur was in der Naehe ist, wird mit 20 Hz gesendet
let lastRosterAt = 0;
function leanOf(p) {
  return {
    id: p.id, name: p.name, cls: p.cls, x: Math.round(p.x), y: Math.round(p.y), zone: p.zone,
    hp: Math.round(p.hp), maxHp: p.maxHp, level: p.level, dead: p.dead,
    color: p.cosmetics && p.cosmetics.color ? COSMETICS.color[p.cosmetics.color].hex : null,
    hat: p.cosmetics && p.cosmetics.hat ? COSMETICS.hat[p.cosmetics.hat].icon : null,
    pet: p.pet, px: p.petPos ? Math.round(p.petPos.x) : null, py: p.petPos ? Math.round(p.petPos.y) : null,
    fx: fxFlags(p),
    tag: p.guildTag || null,
    role: p.role || null,
    prestige: p.prestige || 0,
    party: p.partyId || null,
    partyLeader: !!(p.partyId && parties[p.partyId] && parties[p.partyId].leader === p.id)
  };
}
function fullOf(p) {
  return Object.assign(leanOf(p), {
    xp: p.xp, xpNext: p.xpNext, gold: p.gold, potions: p.potions, speedPotions: p.speedPotions,
    speedBoostUntil: p.speedBoostUntil, abilityReadyAt: p.abilityReadyAt || 0, essence: p.essence, critUntil: p.critUntil || 0,
    upgDmg: p.upgDmg, upgHp: p.upgHp, upgSpeed: p.upgSpeed, upgLuck: p.upgLuck || 0,
    keys: p.keys || 0, ability2ReadyAt: p.ability2ReadyAt || 0, guardUntil: p.guardUntil || 0, seasonPts: p.season ? p.season.points : 0,
    bossBest: p.bossBest || {}
  });
}

function broadcastState() {
  const now = Date.now();
  const leans = Object.values(players).map(leanOf);
  const sendRoster = now - lastRosterAt >= 1000;
  if (sendRoster) lastRosterAt = now;
  // Roster: alle Online-Spieler in knapper Form, 1x pro Sekunde (fuer Listen, Minimap, Gruppen-/Freundes-Fenster)
  const roster = sendRoster ? leans.map(q => ({ id: q.id, name: q.name, cls: q.cls, level: q.level, zone: q.zone, x: q.x, y: q.y, hp: q.hp, maxHp: q.maxHp, dead: q.dead, party: q.party, partyLeader: q.partyLeader, roster: true })) : undefined;

  // Monster, Items, Truhen und Projektile pro Zone sammeln
  const byZone = {};
  const bucket = (z) => byZone[z] || (byZone[z] = { monsters: [], items: [], chests: [], projectiles: [] });
  for (const id in monsters) {
    const m = monsters[id];
    const z = m.zone || DEFAULT_TIER_KEY;
    bucket(z).monsters.push({ id: m.id, type: m.type, zone: z, name: m.name, enraged: !!m.enraged, x: Math.round(m.x), y: Math.round(m.y), hp: Math.round(m.hp), maxHp: m.maxHp });
  }
  for (const id in items) { const it = items[id]; bucket(it.zone || DEFAULT_TIER_KEY).items.push({ id: it.id, type: it.type, x: Math.round(it.x), y: Math.round(it.y), amount: it.amount, zone: it.zone }); }
  for (const id in chests) { const ch = chests[id]; bucket(ch.zone).chests.push({ id: ch.id, zone: ch.zone, x: Math.round(ch.x), y: Math.round(ch.y), looted: ch.looted, kind: ch.kind || 'normal' }); }
  for (const id in projectiles) { const pr = projectiles[id]; bucket(pr.zone).projectiles.push({ id: pr.id, x: Math.round(pr.x), y: Math.round(pr.y), zone: pr.zone, hostile: !!pr.hostile, color: pr.hostile ? pr.color : undefined }); }
  const events = {
    goldRemaining: Math.max(0, goldEventUntil - now),
    xpRemaining: Math.max(0, xpEventUntil - now),
    bossAlive: !!(bossId && monsters[bossId]),
    raid: raid.active && monsters[raid.bossId] ? { hp: Math.round(monsters[raid.bossId].hp), maxHp: monsters[raid.bossId].maxHp, endsAt: raid.endsAt, joined: raid.joined.size } : null,
    raidNextAt: raid.nextAt,
    tierBossNext: Object.fromEntries(Object.keys(tierBossNextAt).map(z => [z, { nextAt: tierBossNextAt[z], alive: !!(tierBosses[z] && monsters[tierBosses[z]]) }]))
  };
  const empty = { monsters: [], items: [], chests: [], projectiles: [] };
  for (const id in players) {
    const me = players[id];
    const b = byZone[me.zone] || empty;
    const near = (o) => Math.abs(o.x - me.x) < NEAR && Math.abs(o.y - me.y) < NEAR;
    const others = leans.filter(q => q.id !== id && ((q.zone === me.zone && near(q)) || (me.partyId && q.party === me.partyId)));
    io.to(id).emit('state', {
      players: [fullOf(me)].concat(others),
      monsters: b.monsters.filter(m => m.type === 'boss' || m.type === 'raidboss' || m.type === 'treasure' || near(m)),
      items: b.items.filter(near),
      chests: b.chests.filter(near),
      projectiles: b.projectiles.filter(near),
      events,
      roster,
      now,
      doors: Array.from(mapFor(me.zone).open || [])
    });
  }
}

setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Leo Dungeon RPG Server laeuft auf Port ${PORT}`);
});
