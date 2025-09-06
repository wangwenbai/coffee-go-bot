require('dotenv').config();
const { Bot } = require('grammy');
const { Low, JSONFile } = require('lowdb');
const { nanoid } = require('nanoid');

// 数据库初始化
const adapter = new JSONFile('db.json');
const db = new Low(adapter);
await db.read();
db.data ||= { users: {}, messages: [] };

// 初始化 Bot
const bot = new Bot(process.env.BOT_TOKEN);
const TARGET_GROUP = process.env.GROUP_ID;

// /start 命令
bot.command('start', ctx => {
  ctx.reply('欢迎来到 COFFEE·GO 匿名群消息转发机器人！✅');
});

// 所有消息处理
bot.on('message', async ctx => {
  const userId = ctx.from.id;
  
  // 为用户分配临时编号
  if (!db.data.users[userId]) {
    db.data.users[userId] = { id: userId, code: nanoid(6) };
    await db.write();
  }
  const userCode = db.data.users[userId].code;

  // 只处理群消息
  if (ctx.chat.type.endsWith('group')) {
    // 删除原消息
    try { await ctx.deleteMessage(); } catch(e) {}

    // 转发匿名消息
    const text = ctx.message.text || '📄 发送了非文本消息';
    await bot.api.sendMessage(TARGET_GROUP, `用户 #${userCode}:\n${text}`);
    
    // 记录消息
    db.data.messages.push({ code: userCode, text, date: new Date().toISOString() });
    await db.write();
  }
});

bot.start();
