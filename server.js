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
    upgDmg: 0, upgHp: 0, upgSpeed: 0, quests: [],
    inventory: [], equipment: {}, skills: {}, essence: 0, cosmetics: {}, pet: null,
    stats: {}, achievements: [], daily: {}, friends: [],
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
        upgDmg: p.upgDmg, upgHp: p.upgHp, upgSpeed: p.upgSpeed, quests: p.quests || [],
        inventory: p.inventory || [], equipment: p.equipment || {}, skills: p.skills || {}, essence: p.essence || 0,
        cosmetics: p.cosmetics || {}, pet: p.pet || null, stats: p.stats || {}, achievements: p.achievements || [], daily: p.daily || {}, friends: p.friends || []
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

function buildMapInfo(rows, w, h) {
  function isWall(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return true;
    return rows[ty][tx] === '1';
  }
  function isFloor(tx, ty) { return !isWall(tx, ty); }
  const floor = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isFloor(x, y)) floor.push({ x, y });
    }
  }
  return { rows, w, h, isWall, isFloor, floor };
}

// ---------------- Dungeon-Stufen (abhaengig vom Spieler-Level) ----------------
const DUNGEON_TIER_DEFS = [
  { key: 'tier1', name: 'Moosige Höhle', minLevel: 1, gen: { type: 'cave', w: 200, h: 50 }, monsterMult: 1, lootMult: 1,
    pool: [['goblin', 5], ['slime', 4], ['bat', 2], ['archer', 2]],
    theme: { wall: '#2f3b2c', wallTop: '#1f2a1d', floorA: '#161d14', floorB: '#1a2218' } },
  { key: 'tier2', name: 'Verlassene Mine', minLevel: 8, gen: { type: 'rooms', gridW: 25, gridH: 5, cellSize: 10 }, monsterMult: 2, lootMult: 1.4,
    pool: [['goblin', 4], ['ork', 3], ['bat', 3], ['archer', 3]],
    theme: { wall: '#3a3226', wallTop: '#272016', floorA: '#1d1913', floorB: '#221e17' } },
  { key: 'tier3', name: 'Katakomben', minLevel: 15, gen: { type: 'maze', cols: 100, rows: 22 }, monsterMult: 3.2, lootMult: 1.8,
    pool: [['skeleton', 5], ['bat', 3], ['ork', 2], ['archer', 2], ['caster', 2]],
    theme: { wall: '#3b3b42', wallTop: '#26262c', floorA: '#17171c', floorB: '#1b1b21' } },
  { key: 'tier4', name: 'Eishöhlen', minLevel: 25, gen: { type: 'cave', w: 220, h: 55 }, monsterMult: 5, lootMult: 2.4,
    pool: [['troll', 3], ['slime', 3], ['skeleton', 3], ['caster', 2], ['spitter', 2]],
    theme: { wall: '#2c4a5e', wallTop: '#1c3342', floorA: '#12202b', floorB: '#16283a' } },
  { key: 'tier5', name: 'Vulkan-Festung', minLevel: 35, gen: { type: 'rooms', gridW: 18, gridH: 4, cellSize: 14 }, monsterMult: 8, lootMult: 3.2,
    pool: [['troll', 4], ['demon', 3], ['skeleton', 2], ['caster', 3]],
    theme: { wall: '#5a2a22', wallTop: '#3a1a15', floorA: '#2a1410', floorB: '#32180f' } },
  { key: 'tier6', name: 'Der Abgrund', minLevel: 50, gen: { type: 'maze', cols: 90, rows: 20 }, monsterMult: 14, lootMult: 4.5,
    pool: [['demon', 5], ['troll', 3], ['caster', 3], ['spitter', 2]],
    theme: { wall: '#3a2350', wallTop: '#251538', floorA: '#150d20', floorB: '#1a1128' } }
];
const DUNGEON_TIERS = {};
for (const def of DUNGEON_TIER_DEFS) {
  const rows = buildTierRows(def.gen);
  DUNGEON_TIERS[def.key] = { ...def, rows, map: buildMapInfo(rows, rows[0].length, rows.length) };
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

function mapFor(zone) {
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
  magier:  { name: 'Magier',  maxHp: 80,  speed: 2.1, dmg: 24, range: 240, cooldown: 750, kind: 'ranged', color: '#3498db' },
  schurke: { name: 'Schurke', maxHp: 100, speed: 3.0, dmg: 13, range: 36, cooldown: 320, kind: 'melee', color: '#2ecc71', crit: 0.25 }
};

function statsForLevel(clsKey, level) {
  const def = CLASSES[clsKey] || CLASSES.krieger;
  const lvlBonus = Math.max(0, level - 1);
  return {
    maxHp: def.maxHp + lvlBonus * 18,
    dmg: def.dmg + lvlBonus * 3
  };
}

function recomputeStats(p) {
  const base = statsForLevel(p.cls, p.level);
  const eq = equipmentBonus(p);
  const vit = 1 + 0.04 * ((p.skills && p.skills.vit) || 0);
  p.maxHp = Math.round((base.maxHp + p.upgHp * 15 + eq.hp) * vit);
  p.dmg = base.dmg + p.upgDmg * 2 + eq.dmg;
  p.speed = CLASSES[p.cls].speed + p.upgSpeed * 0.12 + eq.speed;
  p.critBonus = Math.min(0.5, eq.crit);
  p.hp = Math.min(p.hp, p.maxHp);
}

const SHOP_ITEMS = {
  potion: { label: 'Heiltrank', baseCost: 12, scale: 0, maxCount: null },
  speedpotion: { label: 'Tempo-Trank (15s +60% Tempo)', baseCost: 15, scale: 0, maxCount: null },
  dmg: { label: 'Waffe schärfen (+2 Schaden)', baseCost: 25, scale: 20, maxCount: 10 },
  hp: { label: 'Rüstung verstärken (+15 max. HP)', baseCost: 25, scale: 20, maxCount: 10 },
  speed: { label: 'Leichtere Stiefel (+Tempo)', baseCost: 30, scale: 25, maxCount: 5 }
};
function shopCost(itemKey, currentCount) {
  const def = SHOP_ITEMS[itemKey];
  return def.baseCost + def.scale * currentCount;
}

// ---------------- Game-State ----------------
const players = {};     // id -> player
const monsters = {};    // id -> monster
const tpaRequests = {}; // targetSocketId -> { fromId, expiresAt }
const items = {};       // id -> ground item
const projectiles = {}; // id -> projectile

let monsterIdCounter = 0;
let itemIdCounter = 0;
let projectileIdCounter = 0;

const MONSTER_TYPES = {
  goblin: { hp: 40, dmg: 8, speed: 1.3, xp: 15, range: 30, cooldown: 900, color: '#8e7c4d', radius: 12 },
  ork:    { hp: 95, dmg: 16, speed: 0.9, xp: 40, range: 34, cooldown: 1200, color: '#5b4636', radius: 16 },
  slime:    { hp: 30, dmg: 6, speed: 0.8, xp: 10, range: 28, cooldown: 1000, color: '#55c26b', radius: 11, effect: 'slow' },
  bat:      { hp: 25, dmg: 7, speed: 2.0, xp: 12, range: 26, cooldown: 700, color: '#7a5aa0', radius: 9, effect: 'poison' },
  skeleton: { hp: 70, dmg: 14, speed: 1.1, xp: 30, range: 32, cooldown: 1000, color: '#d8d8c8', radius: 13 },
  troll:    { hp: 180, dmg: 24, speed: 0.8, xp: 70, range: 40, cooldown: 1300, color: '#4f7a4a', radius: 18, effect: 'slow' },
  demon:    { hp: 260, dmg: 34, speed: 1.2, xp: 110, range: 38, cooldown: 1000, color: '#c03a3a', radius: 16, effect: 'burn' },
  treasure: { hp: 150, dmg: 0, speed: 2.3, xp: 40, range: 20, cooldown: 99999, color: '#ffd700', radius: 10 },
  archer:  { hp: 45, dmg: 11, speed: 0.95, xp: 22, range: 260, cooldown: 1700, color: '#c9a66b', radius: 11, ranged: { speed: 6, life: 60, color: '#f1e3b0' } },
  caster:  { hp: 60, dmg: 17, speed: 0.8, xp: 38, range: 300, cooldown: 2300, color: '#9b4dca', radius: 12, effect: 'burn', ranged: { speed: 4.5, life: 80, color: '#ff8a3c' } },
  spitter: { hp: 70, dmg: 13, speed: 0.7, xp: 30, range: 240, cooldown: 2000, color: '#7bd05a', radius: 13, effect: 'poison', ranged: { speed: 4, life: 75, color: '#8fff6b' } },
  boss:   { hp: 900, dmg: 32, speed: 1.0, xp: 400, range: 48, cooldown: 900, color: '#c0392b', radius: 26, name: 'Dungeon-Wächter' }
};
const MAX_MONSTERS_PER_TIER = 60;

function pickMonsterType(pool) {
  let total = 0;
  for (const [, w] of pool) total += w;
  let r = Math.random() * total;
  for (const [type, w] of pool) { r -= w; if (r <= 0) return type; }
  return pool[0][0];
}

function spawnMonster(zone, at, force) {
  zone = zone || DEFAULT_TIER_KEY;
  const tierDef = DUNGEON_TIERS[zone];
  if (!tierDef) return;
  const countInZone = Object.values(monsters).reduce((n, m) => n + ((m.zone || DEFAULT_TIER_KEY) === zone ? 1 : 0), 0);
  if (!force && countInZone >= MAX_MONSTERS_PER_TIER) return;
  const type = pickMonsterType(tierDef.pool);
  const def = MONSTER_TYPES[type];
  const tile = at || randomFloorTile(zone);
  const id = 'm' + (monsterIdCounter++);
  const mult = tierDef.monsterMult;
  monsters[id] = {
    id, type, zone, mult, dmgMult: Math.pow(mult, 0.65),
    x: tile.x * TILE + TILE / 2,
    y: tile.y * TILE + TILE / 2,
    hp: Math.round(def.hp * mult), maxHp: Math.round(def.hp * mult),
    lastAttack: 0,
    targetId: null,
    homeX: tile.x * TILE + TILE / 2,
    homeY: tile.y * TILE + TILE / 2
  };
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

// Langsam durch die Zone wandern, wenn kein Ziel in Reichweite ist
function wanderIdle(m, mMap) {
  const now = Date.now();
  if (!m.wanderUntil || now > m.wanderUntil) {
    m.wanderUntil = now + 3000 + Math.random() * 6000;
    m.wanderAngle = Math.random() * Math.PI * 2;
  }
  if (m.wanderAngle !== null) {
    const r = Math.min(MONSTER_TYPES[m.type].radius, 14);
    const ox = m.x, oy = m.y;
    tryMove(mMap, m, Math.cos(m.wanderAngle) * 0.45, Math.sin(m.wanderAngle) * 0.45, r);
    if (m.x === ox && m.y === oy) m.wanderUntil = 0;
  }
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

function applyPvpDamage(target, dmg, attacker) {
  target.hp -= dmg;
  io.emit('hit', { x: target.x, y: target.y, dmg });
  if (target.hp <= 0 && !target.dead) {
    target.dead = true;
    setTimeout(() => respawnPlayer(target), 2000);
    if (attacker && attacker !== target) { attacker.stats.pvpKills++; questProgress(attacker, 'pvp', 1); checkAchievements(attacker); }
  }
}

function respawnPlayer(p) {
  let sp;
  if (p.zone === 'arena') {
    sp = ARENA_SPAWN;
  } else if (p.zone === 'bossroom') {
    sp = BOSSROOM_ENTRY;
  } else {
    // Beim Respawn automatisch in die zum aktuellen Level passende Stufe wechseln
    p.zone = tierForLevel(p.level);
    sp = randomTierSpawn(p.zone);
  }
  p.x = sp.x;
  p.y = sp.y;
  p.hp = isDungeonTier(p.zone) ? Math.max(1, Math.floor(p.maxHp * 0.5)) : p.maxHp;
  p.fx = {};
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
  p.xp += Math.round(amount * xpMult());
  while (p.xp >= p.xpNext) levelUp(p);
}

// ---------------- Boss-Zyklus (alle 10 Minuten) ----------------
const BOSS_INTERVAL_MS = 10 * 60 * 1000;
let bossId = null;
function spawnBoss() {
  const id = 'boss' + Date.now();
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
  if (bossId && monsters[bossId]) delete monsters[bossId];
  spawnBoss();
}
setTimeout(() => {
  bossCycle();
  setInterval(bossCycle, BOSS_INTERVAL_MS);
}, 45000); // erster Boss 45s nach Serverstart, danach alle 10 Minuten

function onMonsterKilled(m, killer) {
  const zone = m.zone || DEFAULT_TIER_KEY;
  if (m.type === 'boss') {
    if (m.id === bossId) bossId = null;
    if (tierBosses[zone] === m.id) delete tierBosses[zone];
    for (let i = 0; i < 4; i++) spawnItem(m.x + (Math.random() * 40 - 20), m.y + (Math.random() * 40 - 20), zone);
    if (killer) killer.potions += 2;
    io.emit('announcement', `🏆 ${killer ? killer.name : 'Jemand'} hat ${m.name || 'den Boss'} besiegt! Riesiger Loot-Regen!`);
  } else if (m.type === 'treasure') {
    for (let i = 0; i < 10; i++) {
      const it = spawnItem(m.x + (Math.random() * 60 - 30), m.y + (Math.random() * 60 - 30), zone, 'gold');
      it.amount *= 4;
    }
    io.emit('announcement', `💰 ${killer ? killer.name : 'Jemand'} hat den Schatzgoblin erwischt!`);
  } else {
    spawnItem(m.x, m.y, zone);
  }
  if (killer) {
    const xpAmount = Math.round(MONSTER_TYPES[m.type].xp * Math.pow(m.mult || 1, 0.8));
    const essAmount = m.type === 'boss' ? 25 : Math.max(1, Math.round(Math.pow(m.mult || 1, 0.7)));
    grantXp(killer, xpAmount);
    killer.stats.kills++;
    if (m.type === 'boss') killer.stats.bossKills++;
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
  schurke: { name: 'Schattenschritt', icon: '👤', cd: 7000 }
};

function rollDamage(p, def) {
  let dmg = p.dmg;
  const cc = (def.crit || 0) + (p.critBonus || 0);
  if (cc > 0 && Math.random() < cc) dmg *= 2;
  if (p.critUntil && Date.now() < p.critUntil) { dmg *= 2; p.critUntil = 0; }
  return dmg;
}

function hitMonster(m, dmg, killer) {
  m.hp -= dmg;
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
  }
}

// ---------------- Quests ----------------
const MONSTER_NAMES_PL = { goblin: 'Goblins', ork: 'Orks', slime: 'Schleime', bat: 'Fledermäuse', skeleton: 'Skelette', troll: 'Trolle', demon: 'Dämonen', archer: 'Bogenschützen', caster: 'Hexer', spitter: 'Säurespucker' };
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

function sendQuests(p) {
  io.to(p.id).emit('quests', p.quests);
}

function completeQuest(p, i) {
  const q = p.quests[i];
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
  if (changed) sendQuests(p);
}

// ---------------- Fortschritt: Ausruestung, Fertigkeiten, Handwerk, Erfolge ----------------
const INVENTORY_MAX = 30;
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
  heal3:  { name: '3 Heiltränke', essence: 6 },
  speed2: { name: '2 Tempo-Tränke', essence: 8 }
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
  { id: 'l50', name: 'Level 50', desc: 'Level 50 erreichen', stat: 'level', thr: 50, gold: 3000 }
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
    white:  { name: 'Weiss', hex: '#f2f2f2', price: 150 }
  },
  hat: {
    cap:     { name: 'Mütze', icon: '🧢', price: 200 },
    helmet:  { name: 'Helm', icon: '⛑️', price: 250 },
    tophat:  { name: 'Zylinder', icon: '🎩', price: 300 },
    grad:    { name: 'Doktorhut', icon: '🎓', price: 300 },
    devil:   { name: 'Teufel', icon: '😈', price: 400 },
    crown:   { name: 'Krone', icon: '👑', price: 600 }
  }
};
const PET_COST = 400;
const SKILL_RESET_COST = 200;
const CLIENT_DEFS = {
  rarities: RARITIES, skills: SKILL_DEFS, achievements: ACHIEVEMENTS, cosmetics: COSMETICS, recipes: RECIPES,
  inventoryMax: INVENTORY_MAX, upgradeMax: UPGRADE_MAX, petCost: PET_COST, resetCost: SKILL_RESET_COST
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
  const stats = { kills: 0, bossKills: 0, pvpKills: 0, chests: 0, goldEarned: 0, questsDone: 0 };
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
    pet: a.pet === 'wolf' ? 'wolf' : null,
    achievements: Array.isArray(a.achievements) ? a.achievements.filter(id => ACH_IDS.has(id)) : [],
    friends: (Array.isArray(a.friends) ? a.friends : []).filter(x => typeof x === 'string' && x.length >= 3 && x.length <= 20).slice(0, 50),
    daily: { last: a.daily && typeof a.daily.last === 'string' ? a.daily.last : '', streak: Math.max(0, Number(a.daily && a.daily.streak) || 0) }
  };
}
function sendProfile(p) {
  io.to(p.id).emit('profile', {
    inventory: p.inventory.map(withEff),
    equipment: { weapon: withEff(p.equipment.weapon), armor: withEff(p.equipment.armor), ring: withEff(p.equipment.ring) },
    skills: p.skills, skillPoints: skillPointsFree(p), cosmetics: p.cosmetics, pet: p.pet,
    stats: p.stats, achievements: p.achievements, daily: p.daily
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
    for (let i = 0; i < 3; i++) giveItem(killer, genItem(lvl, Math.max(i === 0 ? 2 : 1, rollRarity(2))));
  } else if (m.type === 'treasure') {
    giveItem(killer, genItem(lvl, rollRarity(1)));
  } else if (Math.random() < 0.05) {
    giveItem(killer, genItem(lvl, rollRarity(0)));
  }
}
function checkAchievements(p) {
  let changed = false;
  for (const def of ACHIEVEMENTS) {
    if (p.achievements.includes(def.id)) continue;
    const v = def.stat === 'level' ? p.level : p.stats[def.stat];
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
  if (p.dead || now - (p.petAttackAt || 0) < 1100) return;
  if (!isDungeonTier(p.zone) && p.zone !== 'bossroom') return;
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
const TIER_BOSS_NAMES = { tier1: 'Moosriese', tier2: 'Minenwächter', tier3: 'Knochenfürst', tier4: 'Frostkoloss', tier5: 'Magmatitan', tier6: 'Abgrundherrscher' };
const TIER_BOSS_INTERVAL_MS = 8 * 60 * 1000;
const tierBosses = {};

function damagePlayer(target, dmg) {
  if (target.dead) return;
  target.hp -= dmg;
  io.to(target.id).emit('hit', { x: target.x, y: target.y, dmg });
  if (target.hp <= 0 && !target.dead) {
    target.dead = true;
    target.fx = {};
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
    if (e && e.until > now) damagePlayer(p, e.dmg);
  }
}

function announceTo(filter, text) {
  for (const id in players) if (filter(players[id])) io.to(id).emit('announcement', text);
}
function announceZone(zone, text) { announceTo(p => p.zone === zone, text); }

function bossSlam(m, def) {
  const now = Date.now();
  if (now < (m.nextSlam || 0)) return;
  m.nextSlam = now + 7000;
  const cx = m.x, cy = m.y, zone = m.zone || DEFAULT_TIER_KEY, R = 120;
  const dmg = Math.round(def.dmg * (m.dmgMult || 1) * 1.8);
  io.emit('bossSlam', { x: cx, y: cy, r: R, zone, ms: 1200 });
  setTimeout(() => {
    for (const pid in players) {
      const p = players[pid];
      if (p.dead || p.zone !== zone) continue;
      if (dist(p.x, p.y, cx, cy) < R + 10) damagePlayer(p, dmg);
    }
  }, 1200);
}

function spawnTierBoss(zone) {
  const tier = DUNGEON_TIERS[zone];
  if (!tier) return;
  if (tierBosses[zone] && monsters[tierBosses[zone]]) delete monsters[tierBosses[zone]];
  const tile = randomFloorTile(zone);
  const id = 'tb_' + zone + '_' + Date.now();
  const hp = Math.round(MONSTER_TYPES.boss.hp * tier.monsterMult * 0.8);
  const name = TIER_BOSS_NAMES[zone] || 'Dungeon-Boss';
  const x = tile.x * TILE + TILE / 2, y = tile.y * TILE + TILE / 2;
  monsters[id] = {
    id, type: 'boss', zone, mult: tier.monsterMult, dmgMult: Math.pow(tier.monsterMult, 0.65), name,
    hp, maxHp: hp, x, y, lastAttack: 0, targetId: null, homeX: x, homeY: y
  };
  tierBosses[zone] = id;
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
  if (!near) { wanderIdle(m, mMap); return; }
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
    spawnTierBoss(def.key);
    setInterval(() => spawnTierBoss(def.key), TIER_BOSS_INTERVAL_MS);
  }, 60000 + i * 80000);
});

// ---------------- Trefferflaeche und Fernkampf-Gegner ----------------
function monsterRadius(m) {
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

// ---------------- Admin ----------------
const LB_CATEGORIES = { level: 'level', kills: 'stats.kills', boss: 'stats.bossKills', pvp: 'stats.pvpKills' };
const lbCache = {};
const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

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
      const key = clientKey(socket);
      const blocked = authBlockedSeconds(key);
      if (blocked) return socket.emit('authError', `Zu viele Fehlversuche. Bitte warte ${blocked} Sekunden.`);

      if (!username || username.length < 3) {
        return socket.emit('authError', 'Benutzername muss mind. 3 Zeichen haben.');
      }
      if (!password || password.length < 4) {
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
        const ok = await bcrypt.compare(password, account.passwordHash);
        if (!ok) { authFail(key); return socket.emit('authError', 'Falsches Passwort.'); }
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

      const stats = statsForLevel(account.cls, account.level);
      const loginTier = tierForLevel(account.level);
      const loginSpawn = randomTierSpawn(loginTier);
      players[socket.id] = {
        id: socket.id,
        username,
        name: name || username,
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
        isAdmin: ADMIN_USERNAMES.has(username),
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

      const dungeonTiersPayload = {};
      for (const key in DUNGEON_TIERS) {
        const t = DUNGEON_TIERS[key];
        dungeonTiersPayload[key] = { name: t.name, minLevel: t.minLevel, rows: t.rows, theme: t.theme };
      }
      socket.emit('init', {
        you: socket.id,
        dungeonTiers: dungeonTiersPayload,
        abilities: ABILITIES,
        defs: CLIENT_DEFS,
        monsterDefs: Object.fromEntries(Object.entries(MONSTER_TYPES).map(([k, v]) => [k, { color: v.color, radius: v.radius, ranged: !!v.ranged }])),
        arenaMap: ARENA_ROWS,
        bossRoomMap: BOSSROOM_ROWS,
        tile: TILE,
        classes: CLASSES,
        isAdmin: players[socket.id].isAdmin
      });
      sendQuests(players[socket.id]);
      sendProfile(players[socket.id]);
      dailyReward(players[socket.id]);
      checkAchievements(players[socket.id]);
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
    if (d.recipe === 'heal3') p.potions += 3;
    if (d.recipe === 'speed2') p.speedPotions += 2;
    saveAccountProgress(p);
    notice(p, `🔨 Hergestellt: ${r.name}`);
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

  socket.on('buyPet', () => {
    const p = players[socket.id];
    if (!p || p.pet) return;
    if (p.gold < PET_COST) return notice(p, `Du brauchst ${PET_COST} Gold.`);
    p.gold -= PET_COST;
    p.pet = 'wolf';
    sendProfile(p); saveAccountProgress(p);
    notice(p, '🐺 Dein Wolf begleitet dich jetzt!');
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

  socket.on('adminEvent', (d) => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    const zone = isDungeonTier(p.zone) ? p.zone : tierForLevel(p.level);
    const kind = d && d.kind;
    if (kind === 'treasure') spawnTreasureGoblin(zone);
    else if (kind === 'ambush') runAmbush(zone, p);
    else if (kind === 'blessing') runBlessing(zone);
    else if (kind === 'tierboss') spawnTierBoss(zone);
  });

  socket.on('travelToTier', (data) => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    const key = data && data.tier;
    const tierDef = DUNGEON_TIERS[key];
    if (!tierDef) return;
    if (p.level < tierDef.minLevel) {
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
    chest.respawnAt = Date.now() + CHEST_RESPAWN_MS;
    const lootMult = (DUNGEON_TIERS[p.zone] && DUNGEON_TIERS[p.zone].lootMult) || 1;
    const gold = Math.round((20 + Math.floor(Math.random() * 40)) * goldMult() * lootMult * goldBonus(p));
    const gotPotion = Math.random() < 0.35;
    p.gold += gold;
    if (gotPotion) p.potions += 1;
    p.stats.chests++; p.stats.goldEarned += gold;
    questProgress(p, 'chest', 1);
    questProgress(p, 'gold', gold);
    if (Math.random() < 0.25) giveItem(p, genItem(p.level, rollRarity(0.5)));
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
      const countKey = type === 'dmg' ? 'upgDmg' : (type === 'hp' ? 'upgHp' : 'upgSpeed');
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
    io.emit('chat', { name: p.name, text });
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

  socket.on('adminAnnounce', (data) => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    const text = String((data && data.text) || '').slice(0, 140).trim();
    if (!text) return;
    io.emit('announcement', `📢 ${text}`);
  });

  socket.on('adminSpawnWave', () => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    for (let i = 0; i < 10; i++) spawnMonster(isDungeonTier(p.zone) ? p.zone : DEFAULT_TIER_KEY);
    io.emit('announcement', `👹 ${p.name} hat eine Monsterwelle beschworen!`);
  });

  socket.on('adminHealAll', () => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    for (const id in players) {
      const pl = players[id];
      pl.hp = pl.maxHp;
      pl.dead = false;
    }
    io.emit('announcement', `💚 ${p.name} hat alle vollständig geheilt!`);
  });

  socket.on('adminEventGold', () => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    goldEventUntil = Date.now() + 5 * 60000;
    io.emit('announcement', `💰 ${p.name} startet ein Doppel-Gold-Event! (5 Minuten)`);
  });

  socket.on('adminEventXp', () => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    xpEventUntil = Date.now() + 5 * 60000;
    io.emit('announcement', `✨ ${p.name} startet ein Doppel-XP-Event! (5 Minuten)`);
  });

  socket.on('adminSpawnBoss', () => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    bossCycle();
    io.emit('announcement', `👑 ${p.name} hat den Boss sofort herbeigerufen!`);
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) saveAccountProgress(p);
    if (p) leaveParty(p);
    delete players[socket.id];
    if (p) notifyFriendsOf(p, null);
    delete partyInvites[socket.id];
    delete tradeOffers[socket.id];
    delete tpaRequests[socket.id];
    for (const targetId in tpaRequests) {
      if (tpaRequests[targetId].fromId === socket.id) delete tpaRequests[targetId];
    }
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
    if (!isDungeonTier(p.zone) && p.zone !== 'bossroom') continue;
    // Items einsammeln (nur passend zur eigenen Zone)
    for (const iid in items) {
      const it = items[iid];
      if ((it.zone || DEFAULT_TIER_KEY) !== p.zone) continue;
      if (dist(p.x, p.y, it.x, it.y) < 20) {
        if (it.type === 'gold') { const g = Math.round(it.amount * goldBonus(p)); p.gold += g; p.stats.goldEarned += g; questProgress(p, 'gold', g); checkAchievements(p); }
        else if (it.type === 'potion') p.potions += 1;
        delete items[iid];
      }
    }
  }

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
      const aggro = MONSTER_TYPES[m.type].ranged ? MONSTER_TYPES[m.type].range + 80 : 180;
      if (d < aggro && d < targetDist) { target = p; targetDist = d; }
    }
    if (target) {
      const def = MONSTER_TYPES[m.type];
      if (m.type === 'boss') bossSlam(m, def);
      if (def.ranged) {
        rangedAI(m, def, target, targetDist, mMap);
      } else if (targetDist > def.range) {
        const angle = Math.atan2(target.y - m.y, target.x - m.x);
        tryMove(mMap, m, Math.cos(angle) * def.speed, Math.sin(angle) * def.speed, Math.min(def.radius, 14));
      } else {
        const now = Date.now();
        if (now - m.lastAttack > def.cooldown) {
          m.lastAttack = now;
          if (def.dmg > 0) {
            const dmg = Math.round(def.dmg * (m.dmgMult || 1));
            damagePlayer(target, dmg);
            if (def.effect) applyEffect(target, def.effect, dmg);
          }
        }
      }
    } else {
      wanderIdle(m, mMap);
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
            damagePlayer(pl, pr.dmg);
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
    party: p.partyId || null,
    partyLeader: !!(p.partyId && parties[p.partyId] && parties[p.partyId].leader === p.id)
  };
}
function fullOf(p) {
  return Object.assign(leanOf(p), {
    xp: p.xp, xpNext: p.xpNext, gold: p.gold, potions: p.potions, speedPotions: p.speedPotions,
    speedBoostUntil: p.speedBoostUntil, abilityReadyAt: p.abilityReadyAt || 0, essence: p.essence,
    upgDmg: p.upgDmg, upgHp: p.upgHp, upgSpeed: p.upgSpeed
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
    bucket(z).monsters.push({ id: m.id, type: m.type, zone: z, name: m.name, x: Math.round(m.x), y: Math.round(m.y), hp: Math.round(m.hp), maxHp: m.maxHp });
  }
  for (const id in items) { const it = items[id]; bucket(it.zone || DEFAULT_TIER_KEY).items.push({ id: it.id, type: it.type, x: Math.round(it.x), y: Math.round(it.y), amount: it.amount, zone: it.zone }); }
  for (const id in chests) { const ch = chests[id]; bucket(ch.zone).chests.push({ id: ch.id, zone: ch.zone, x: Math.round(ch.x), y: Math.round(ch.y), looted: ch.looted }); }
  for (const id in projectiles) { const pr = projectiles[id]; bucket(pr.zone).projectiles.push({ id: pr.id, x: Math.round(pr.x), y: Math.round(pr.y), zone: pr.zone, hostile: !!pr.hostile, color: pr.hostile ? pr.color : undefined }); }
  const events = {
    goldRemaining: Math.max(0, goldEventUntil - now),
    xpRemaining: Math.max(0, xpEventUntil - now),
    bossAlive: !!(bossId && monsters[bossId])
  };
  const empty = { monsters: [], items: [], chests: [], projectiles: [] };
  for (const id in players) {
    const me = players[id];
    const b = byZone[me.zone] || empty;
    const near = (o) => Math.abs(o.x - me.x) < NEAR && Math.abs(o.y - me.y) < NEAR;
    const others = leans.filter(q => q.id !== id && ((q.zone === me.zone && near(q)) || (me.partyId && q.party === me.partyId)));
    io.to(id).emit('state', {
      players: [fullOf(me)].concat(others),
      monsters: b.monsters.filter(m => m.type === 'boss' || m.type === 'treasure' || near(m)),
      items: b.items.filter(near),
      chests: b.chests.filter(near),
      projectiles: b.projectiles.filter(near),
      events,
      roster
    });
  }
}

setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Leo Dungeon RPG Server laeuft auf Port ${PORT}`);
});
