import { Bot } from "grammy";

const bot = new Bot(process.env.BOT_TOKEN); // 从环境变量读取 Bot Token
const GROUP_ID = Number(process.env.GROUP_ID); // 群组 ID

// 用户映射表：真实用户ID → 匿名编号
const userMap = new Map();
let counter = 1;

// 获取用户匿名编号
function getAnonId(userId) {
  if (!userMap.has(userId)) {
    userMap.set(userId, counter++);
  }
  return userMap.get(userId);
}

bot.on("message", async (ctx) => {
  if (ctx.chat.id === GROUP_ID) {
    const msg = ctx.message;
    const userId = msg.from.id;
    const anonId = getAnonId(userId);

    try {
      // 删除原消息
      await ctx.api.deleteMessage(GROUP_ID, msg.message_id);

      // 转发文字消息
      if (msg.text) {
        await ctx.api.sendMessage(GROUP_ID, `匿名#${anonId}: ${msg.text}`);
      }

      // 转发图片
      if (msg.photo) {
        const fileId = msg.photo.pop().file_id;
        await ctx.api.sendPhoto(GROUP_ID, fileId, {
          caption: `匿名#${anonId} 📷 发送了图片`,
        });
      }

      // 转发语音
      if (msg.voice) {
        await ctx.api.sendVoice(GROUP_ID, msg.voice.file_id, {
          caption: `匿名#${anonId} 🎤 语音消息`,
