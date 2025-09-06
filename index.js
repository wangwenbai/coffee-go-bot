require('dotenv').config();
const { Bot } = require('grammy');
const { Low, JSONFile } = require('lowdb');
const { nanoid } = require('nanoid');

// 初始化数据库
const adapter = new JSONFile('db.json');
const db = new Low(adapter);
db.data = db.data || { users: {}, messages: {} };

// 读取环境变量
const bot = new Bot(process.env.BOT_TOKEN);
const GROUP_ID = process.env.GROUP_ID;

// 临时编号映射
const tempIds = {};

// 用户发送消息时处理
bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  let tempId = tempIds[userId];
  if (!tempId) {
    tempId = nanoid(6);
    tempIds[userId] = tempId;
    db.data.users[tempId] = { userId };
    await db.write();
  }

  const msgText = ctx.message.text || '📎 文件/媒体';
  await ctx.deleteMessage(); // 删除用户原消息

  // 转发到群组
  await ctx.api.sendMessage(
    GROUP_ID,
    `编号 ${tempId} 的匿名消息：\n${msgText}`
  );
});

bot.start();
console.log('Bot started...');
