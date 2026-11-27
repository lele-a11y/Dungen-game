// ============================================================
// Leo Dungeon RPG - Discord Bot
// Legt per !setup die Server-Struktur an und vergibt Rollen.
// ============================================================
require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('DISCORD_TOKEN fehlt in .env'); process.exit(1); }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent // HINWEIS: im Developer Portal aktivieren!
  ]
});

const PREFIX = '!';

// Rollen (key = Befehl-Name, z.B. !tag @user supporter)
const ROLES = [
  { key: 'owner',     name: '👑 Owner',     color: 0xFFD24D, pos: 10 },
  { key: 'admin',     name: '🛡 Admin',     color: 0xFF6B6B, pos: 9 },
  { key: 'mod',       name: '⭐ Mod',       color: 0xC678DD, pos: 8 },
  { key: 'supporter', name: '☕ Supporter', color: 0x4FC3F7, pos: 7 },
  { key: 'spieler',   name: '🧙 Spieler',   color: 0x3BA55D, pos: 6 }
];
const ROLE_BY_KEY = Object.fromEntries(ROLES.map(r => [r.key, r]));
const ROLE_BY_NAME = Object.fromEntries(ROLES.map(r => [r.name.toLowerCase(), r]));

// Server-Struktur fuer !setup
const STRUCTURE = [
  {
    cat: '📜 Information',
    channels: [
      { name: 'willkommen', topic: 'Regeln, Spiel-Link und News', readonly: true },
      { name: 'regeln', topic: 'Server-Regeln', readonly: true }
    ]
  },
  {
    cat: '💬 Community',
    channels: [
      { name: 'allgemein', topic: 'Der allgemeine Chat' },
      { name: 'dungeon-talk', topic: 'Strategien, Builds, Farm-Routen' },
      { name: 'clips-und-momente', topic: 'Screenshots undclips' },
      { name: 'spenden', topic: 'Trinkgeld via Ko-fi (Link folgt)' }
    ]
  },
  {
    cat: '🛠 Support',
    channels: [
      { name: 'bug-meldungen', topic: 'Bugs melden' },
      { name: 'vorschlaege', topic: 'Feature-Wuensche' }
    ]
  }
];

const REGELN_TEXT = [
  '## 📜 Regeln',
  '1. Seid respektvoll — kein toxisches Verhalten.',
  '2. Keine Spam oder Werbung.',
  '3. Spoiler nur in #clips-und-momente oder mit ||spoiler||.',
  '4. Betrug/Real-Life-Handel ist verboten.',
  '5. Bei Problemen: Team ansprache oder Ticket im Support.'
].join('\n');

async function setupServer(guild) {
  const me = guild.members.me;
  const admin = PermissionFlagsBits.Administrator;

  // Rollen anlegen (falls nicht vorhanden)
  const everyone = guild.roles.everyone;
  for (const r of ROLES) {
    let role = guild.roles.cache.find(x => x.name === r.name);
    if (!role) {
      role = await guild.roles.create({ name: r.name, color: r.color, reason: 'Dungeon Bot setup' });
    }
    try { await role.setPosition(r.pos, { reason: 'Dungeon Bot setup' }); } catch (e) { /* Positionen sind begrenzt */ }
  }
  const supporterRole = guild.roles.cache.find(x => x.name === ROLES[3].name);

  // Channels anlegen
  for (const section of STRUCTURE) {
    let cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === section.cat);
    if (!cat) cat = await guild.channels.create({ name: section.cat, type: ChannelType.GuildCategory });
    for (const ch of section.channels) {
      if (guild.channels.cache.find(c => c.parentId === cat.id && c.name === ch.name)) continue;
      const overwrites = [
        { id: everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
      ];
      if (ch.readonly) {
        overwrites[0].deny = [PermissionFlagsBits.SendMessages];
        overwrites.push({ id: me.id, allow: [admin] });
      }
      await guild.channels.create({
        name: ch.name,
        type: ChannelType.GuildText,
        parent: cat.id,
        topic: ch.topic || null,
        permissionOverwrites: overwrites
      });
    }
  }

  // Startnachrichten in die Info-Channels
  const willkommens = guild.channels.cache.find(c => c.name === 'willkommen');
  const regeln = guild.channels.cache.find(c => c.name === 'regeln');
  if (willkommens) {
    const ex = await willkommens.messages.fetch({ limit: 1 });
    if (!ex.size) await willkommens.send('👋 Willkommen auf dem **Leo Dungeon RPG** Discord!\nSpiele hier: *Link folgt*\nTipp: Mit `!tag @user supporter` vergeben Admins die ☕ Supporter-Rolle.');
  }
  if (regeln) {
    const ex = await regeln.messages.fetch({ limit: 1 });
    if (!ex.size) await regeln.send(REGELN_TEXT);
  }
  if (supporterRole) {
    // Supporter-Rolle soll sichtbar sein (hoistet sie ueber normale Rollen)
    try { await supporterRole.setHoist(true); } catch (e) {}
  }
}

client.once('ready', () => {
  console.log(`Bot eingeloggt als ${client.user.tag}`);
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  if (!msg.content.startsWith(PREFIX)) return;
  const [cmdRaw, ...args] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase();

  if (cmd === 'ping') return msg.reply('🏓 Pong!');

  if (cmd === 'setup') {
    if (!msg.member.permissions.has(PermissionFlagsBits.ManageGuild)) return msg.reply('❌ Du brauchst die Berechtigung „Server verwalten".');
    try {
      await msg.reply('🏗️ Baue den Server auf...');
      await setupServer(msg.guild);
      await msg.reply('✅ Fertig! Rollen und Channels wurden angelegt.');
    } catch (e) {
      console.error(e);
      await msg.reply(`❌ Fehler: ${e.message}`);
    }
    return;
  }

  if (cmd === 'tag' || cmd === 'untag') {
    if (!msg.member.permissions.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.Administrator])) {
      return msg.reply('❌ Du brauchst die Berechtigung „Rollen verwalten".');
    }
    const target = msg.mentions.members.first();
    const roleArg = args.find(a => !a.startsWith('<@'));
    if (!target) return msg.reply(`❌ Syntax: \`${PREFIX}tag @user ${Object.keys(ROLE_BY_KEY).join('|')}\``);
    const roleDef = ROLE_BY_KEY[(roleArg || '').toLowerCase()] || ROLE_BY_NAME[(roleArg || '').toLowerCase()];
    if (!roleDef) return msg.reply(`❌ Rolle nicht gefunden. Verfügbar: ${ROLES.map(r => r.key).join(', ')}`);
    const role = msg.guild.roles.cache.find(r => r.name === roleDef.name);
    if (!role) return msg.reply('❌ Rolle existiert nicht — zuerst `!setup` ausführen.');
    try {
      if (cmd === 'tag') {
        await target.roles.add(role);
        await msg.reply(`✅ ${target.user.tag} hat jetzt die Rolle **${role.name}**.`);
      } else {
        await target.roles.remove(role);
        await msg.reply(`✅ Rolle **${role.name}** von ${target.user.tag} entfernt.`);
      }
    } catch (e) {
      await msg.reply(`❌ Fehler: ${e.message} (Bot-Rolle muss höher positioniert sein als die zu vergebende Rolle)`);
    }
    return;
  }

  if (cmd === 'rollen') {
    return msg.reply('Verfügbare Rollen: ' + ROLES.map(r => `\`${r.key}\` (${r.name})`).join(', '));
  }
});

client.login(TOKEN);
