'use strict';

// A stand-in for a discord.js bot, used by the integration test.
const { EventEmitter } = require('events');
const link = require('../../../bot-link');

const client = new EventEmitter();
client.readyAt = new Date();
client.uptime = 1234;
client.ws = { ping: 42 };
client.guilds = { cache: new Map([['1', { memberCount: 5 }], ['2', { memberCount: 7 }]]) };
client.user = {
  id: '1',
  username: process.env.BOT_NAME || 'fake',
  presence: { status: 'online', activities: [] },
  setPresence(p) {
    this.presence = { status: p.status, activities: p.activities };
  },
  async setUsername(n) {
    this.username = n;
  },
  async setAvatar() {},
  displayAvatarURL() {
    return 'https://cdn.example/avatar.png';
  },
};

link.attach(client, { interval: 300, extra: () => ({ players: 2 }) });

console.log(`fake bot ${client.user.username} ready, token ${process.env.DISCORD_TOKEN}`);
console.error('fake error line for the report');
setInterval(() => console.log('tick'), 400);
