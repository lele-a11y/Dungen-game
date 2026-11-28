require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const ORDER = ['🧙 Spieler', '☕ Supporter', '⭐ Mod', '🛡 Admin', '👑 Owner']; // unten -> oben
client.once('clientReady', async () => {
  for (const g of client.guilds.cache.values()) {
    const botTop = g.members.me.roles.highest.position;
    console.log('Bot-Rolle ganz oben bei Position', botTop);
    for (let i = 0; i < ORDER.length; i++) {
      const r = g.roles.cache.find(x => x.name === ORDER[i]);
      if (!r) { console.log('fehlt:', ORDER[i]); continue; }
      try {
        await r.setPosition(i + 1, { reason: 'Reihenfolge fixen' });
        console.log('OK', r.name, '-> Pos', i + 1);
      } catch (e) { console.log('FEHLER', r.name, e.message); }
    }
    g.roles.cache.sort((a, b) => b.position - a.position).forEach(r => { if (r.name !== '@everyone') console.log(' -', r.name, r.position); });
  }
  process.exit(0);
});
client.login(process.env.DISCORD_TOKEN);
