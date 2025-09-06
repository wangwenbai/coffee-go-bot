require('dotenv').config();
const { Bot } = require('grammy');

// 从环境变量读取 Bot Token
const bot = new Bot(process.env.BOT_TOKEN);

// 示例：收到 /start 命令回复消息
bot.command('start', ctx => {
  ctx.reply('欢迎来到 COFFEE·GO 智能收益平台！☕');
});

// 示例：私聊回复
bot.on('message', ctx => {
  ctx.reply('感谢您的消息，我们会尽快回复您！✅');
});

// 启动机器人
bot.start();
