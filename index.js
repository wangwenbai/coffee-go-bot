import { Bot } from "grammy";
import dotenv from "dotenv";

dotenv.config();

const bot = new Bot(process.env.BOT_TOKEN);

const chatId = process.env.GROUP_ID;
const prefix = process.env.NICK_PREFIX || "User-";

// 用户编号映射
const userMap = new Map();
let userCounter = 1;

// 用户消息历史记录
const userHistory = new Map();

// 获取用户编号
function getUserId(userId) {
  if (!userMap.has(userId)) {
    userMap.set(userId, `${prefix}${userCounter}`);
    userCounter++;
  }
  return userMap.get(userId);
}

// 记录用户消息
function saveUserMessage(userId, messageSummary) {
  if (!userHistory.has(userId)) {
    userHistory.set(userId, []);
  }
  userHistory.get(userId).push(messageSummary);
}

// 处理所有消息类型
bot.on("message", async ctx => {
  const message = ctx.message;

  if (ctx.from.is_bot) return; // 忽略机器人自己

  const userId = getUserId(ctx.from.id);

  try {
    // 删除原消息
    await ctx.deleteMessage();
  } catch (err) {
    console.log("删除消息失败:", err.message);
  }

  try {
    if (message.text) {
      await ctx.api.sendMessage(chatId, `【${userId}】: ${message.text}`);
      saveUserMessage(userId, message.text);
    } else if (message.photo) {
      const photo = message.photo[message.photo.length - 1].file_id;
      await ctx.api.sendPhoto(chatId, photo, { caption: `【${userId}】` });
      saveUserMessage(userId, "[照片]");
    } else if (message.sticker) {
      await ctx.api.sendSticker(chatId, message.sticker.file_id);
      saveUserMessage(userId, "[贴纸]");
    } else if (message.video) {
      await ctx.api.sendVideo(chatId, message.video.file_id, { caption: `【${userId}】` });
      saveUserMessage(userId, "[视频]");
    } else if (message.document) {
      await ctx.api.sendDocument(chatId, message.document.file_id, { caption: `【${userId}】` });
      saveUserMessage(userId, "[文件]");
    } else if (message.audio) {
      await ctx.api.sendAudio(chatId, message.audio.file_id, { caption: `【${userId}】` });
      saveUserMessage(userId, "[音频]");
    } else if (message.voice) {
      await ctx.api.sendVoice(chatId, message.voice.file_id, { caption: `【${userId}】` });
      saveUserMessage(userId, "[语音]");
    } else if (message.animation) {
      await ctx.api.sendAnimation(chatId, message.animation.file_id, { caption: `【${userId}】` });
      saveUserMessage(userId, "[动画]");
    } else if (message.location) {
      await ctx.api.sendMessage(chatId, `【${userId}】发送了位置: [${message.location.latitude}, ${message.location.longitude}]`);
      saveUserMessage(userId, "[位置]");
    } else if (message.poll) {
      const poll = message.poll;
      await ctx.api.sendPoll(chatId, poll.question, poll.options.map(o => o.text), {
        type: poll.type,
        is_anonymous: true
      });
      saveUserMessage(userId, "[投票]");
    } else {
      await ctx.api.sendMessage(chatId, `【${userId}】发送了未支持的消息类型`);
      saveUserMessage(userId, "[未知消息类型]");
    }
  } catch (err) {
    console.log("转发消息失败:", err.message);
  }
});

// 命令查看自己历史消息
bot.command("history", async ctx => {
  const userId = getUserId(ctx.from.id);
  const history = userHistory.get(ctx.from.id) || [];
  if (history.length === 0) {
    await ctx.reply("你还没有发送过消息。");
  } else {
    await ctx.reply("你的消息历史:\n" + history.join("\n"));
  }
});

// Render 部署监听端口
const port = process.env.PORT || 3000;
bot.start({
  onStart: () => console.log(`Bot started on port ${port}`),
  webhook: {
    domain: "https://你的render域名.onrender.com",
    port: parseInt(port)
  }
});
