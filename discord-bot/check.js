require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
client.once('clientReady', async () => {
  for (const g of client.guilds.cache.values()) {
    console.log('=== SERVER:', g.name, '===');
    console.log('\nROLLEN:');
    g.roles.cache.sort((a, b) => b.position - a.position).forEach(r => { if (r.name !== '@everyone') console.log(' -', r.name, '(Pos', r.position + ')'); });
    console.log('\nCHANNELS:');
    g.channels.cache.filter(c => c.type !== ChannelType.GuildCategory).sort((a, b) => (a.parentId || '').localeCompare(b.parentId || '') || a.rawPosition - b.rawPosition).forEach(c => {
      const parent = c.parent ? c.parent.name : '-';
      console.log(' [' + parent + '] #' + c.name);
    });
    try {
      const rules = await g.autoModerationRules.fetch();
      console.log('\nAUTOMOD (' + rules.size + '):');
      rules.forEach(r => console.log(' -', r.name, '| Trigger:', r.triggerType, '| Aktiv:', r.enabled));
    } catch (e) { console.log('\nAUTOMOD: Fehler -', e.message); }
    const bots = g.members.cache.filter(m => m.user.bot);
    console.log('\nBOTS:', [...bots.values()].map(b => b.user.tag).join(', '));
  }
  process.exit(0);
});
client.login(process.env.DISCORD_TOKEN);
