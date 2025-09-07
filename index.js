import { Bot, webhookCallback } from "grammy";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";

dotenv.config();

const bot = new Bot(process.env.BOT_TOKEN);

const chatId = process.env.GROUP_ID;
const prefix = process.env.NICK_PREFIX || "User-";

// 用户编号映射
const userMap = new Map();
const userHistory = new Map();

// 消息映射：原始消息 ID → 群里机器人消息 ID
const messageMap = new Map();

// 屏蔽关键词数组
let blockedKeywords = [];

// 加载屏蔽词
function loadBlockedKeywords() {
  try {
    const data = fs.readFileSync('./blocked.txt', 'utf8');
    blockedKeywords = data.split(',').map(word => word.trim()).filter(Boolean);
    console.log(`屏蔽词已加载: ${blockedKeywords.length} 个`);
  } catch (err) {
    console.log("加载屏蔽词失败:", err.message);
  }
}

// 初始加载
loadBlockedKeywords();

// 热更新 blocked.txt
fs.watchFile('./blocked.txt', () => {
  console.log('blocked.txt 文件变化，重新加载...');
  loadBlockedKeywords();
});

// 生成 5 位编号
function generateRandomId() {
  return Math.floor(10000 + Math.random() * 90000);
}

// 获取用户编号
function getUserId(userId) {
  if (!userMap.has(userId)) {
    const randomId = generateRandomId();
    userMap.set(userId, `${prefix}${randomId}`);
  }
  return userMap.get(userId);
}

// 保存用户历史消息
function saveUserMessage(userId, msg) {
  if (!userHistory.has(userId)) userHistory.set(userId, []);
  userHistory.get(userId).push(msg);
}

// 判断屏蔽关键词
function containsBlockedKeyword(text) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return blockedKeywords.some(word => lowerText.includes(word.toLowerCase()));
}

// 判断用户是否群管理员
async function isAdminInGroup(userId) {
  try {
    const member = await bot.api.getChatMember(chatId, userId);
    return member.status === "administrator" || member.status === "creator";
  } catch {
    return false;
  }
}

// 处理群消息
bot.on("message", async ctx => {
  const msg = ctx.message;

  if (ctx.chat.type === "private") return; // 私聊消息跳过

  if (ctx.from.is_bot) return; // 机器人消息不处理

  const userId = getUserId(ctx.from.id);

  try { await ctx.deleteMessage(); } catch (err) { console.log("删除消息失败:", err.message); }

  if ((msg.text && containsBlockedKeyword(msg.text))) {
    saveUserMessage(userId, "[屏蔽消息]");
    return;
  }

  let replyTargetId = null;
  if (msg.reply_to_message) {
    const repliedMsgId = msg.reply_to_message.message_id;
    replyTargetId = messageMap.get(repliedMsgId) || null;
  }

  try {
    let sent;

    if (msg.text) {
      sent = await ctx.api.sendMessage(chatId, `【${userId}】: ${msg.text}`, { reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, msg.text);
    } else if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1].file_id;
      sent = await ctx.api.sendPhoto(chatId, photo, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[照片]");
    } else if (msg.sticker) {
      sent = await ctx.api.sendSticker(chatId, msg.sticker.file_id, { reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[贴纸]");
    } else if (msg.video) {
      sent = await ctx.api.sendVideo(chatId, msg.video.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[视频]");
    } else if (msg.document) {
      sent = await ctx.api.sendDocument(chatId, msg.document.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[文件]");
    } else if (msg.audio) {
      sent = await ctx.api.sendAudio(chatId, msg.audio.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[音频]");
    } else if (msg.voice) {
      sent = await ctx.api.sendVoice(chatId, msg.voice.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[语音]");
    } else if (msg.animation) {
      sent = await ctx.api.sendAnimation(chatId, msg.animation.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[动画]");
    } else if (msg.location) {
      sent = await ctx.api.sendMessage(chatId, `【${userId}】发送了位置: [${msg.location.latitude}, ${msg.location.longitude}]`, { reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[位置]");
    } else if (msg.poll) {
      const poll = msg.poll;
      sent = await ctx.api.sendPoll(chatId, poll.question, poll.options.map(o => o.text), { type: poll.type, is_anonymous: true, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[投票]");
    } else {
      sent = await ctx.api.sendMessage(chatId, `【${userId}】发送了未支持的消息类型`, { reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[未知消息类型]");
    }

    if (sent) messageMap.set(msg.message_id, sent.message_id);
  } catch (err) {
    console.log("转发消息失败:", err.message);
  }
});

// 私聊 /start
bot.command("start", async ctx => {
  if (ctx.chat.type !== "private") return;
  ctx.reply("欢迎使用匿名管理机器人，你可以私聊我管理屏蔽词、查看历史消息等功能。");
});

// 私聊查看历史
bot.command("history", async ctx => {
  if (ctx.chat.type !== "private") return;
  const history = userHistory.get(ctx.from.id) || [];
  if (!history.length) return ctx.reply("你还没有发送过消息。");
  ctx.reply("你的消息历史:\n" + history.join("\n"));
});

// 私聊添加屏蔽词
bot.command("block", async ctx => {
  if (ctx.chat.type !== "private") return; 
  if (!(await isAdminInGroup(ctx.from.id))) return ctx.reply("只有群管理员可以添加屏蔽词。");

  const text = ctx.message.text.slice(6).trim();
  if (!text) return ctx.reply("请指定要屏蔽的词。");
  const words = text.split(",").map(w => w.trim()).filter(Boolean);
  if (!words.length) return ctx.reply("没有有效屏蔽词。");

  const added = [];
  for (const word of words) {
    if (!blockedKeywords.includes(word)) {
      blockedKeywords.push(word);
      added.push(word);
    }
  }

  if (added.length) {
    fs.writeFileSync('./blocked.txt', blockedKeywords.join(","), "utf8");
    ctx.reply(`屏蔽词已添加: ${added.join(", ")}`);
  } else ctx.reply("这些词已在屏蔽列表中。");
});

// 私聊移除屏蔽词
bot.command("unblock", async ctx => {
  if (ctx.chat.type !== "private") return;
  if (!(await isAdminInGroup(ctx.from.id))) return ctx.reply("只有群管理员可以移除屏蔽词。");

  const text = ctx.message.text.slice(8).trim();
  if (!text) return ctx.reply("请指定要移除的词。");
  const words = text.split(",").map(w => w.trim()).filter(Boolean);
  if (!words.length) return ctx.reply("没有有效屏蔽词。");

  const removed = [];
  blockedKeywords = blockedKeywords.filter(word => {
    if (words.includes(word)) { removed.push(word); return false; }
    return true;
  });

  if (removed.length) {
    fs.writeFileSync('./blocked.txt', blockedKeywords.join(","), "utf8");
    ctx.reply(`屏蔽词已移除: ${removed.join(", ")}`);
  } else ctx.reply("这些词不在屏蔽列表中。");
});

// 私聊查看屏蔽词
bot.command("blocked", async ctx => {
  if (ctx.chat.type !== "private") return;
  if (!blockedKeywords.length) return ctx.reply("当前没有屏蔽词。");
  ctx.reply(`当前屏蔽词: ${blockedKeywords.join(", ")}`);
});

// 用户退群清理
bot.on("chat_member", async ctx => {
  const status = ctx.chatMember.new_chat_member.status;
  const userId = ctx.chatMember.new_chat_member.user.id;
  if (status === "left" || status === "kicked") {
    userMap.delete(userId);
    userHistory.delete(userId);
    console.log(`已移除用户 ${userId} 的匿名编号`);
  }
});

// Express 绑定端口
const app = express();
const port = process.env.PORT || 3000;
const webhookPath = `/bot${process.env.BOT_TOKEN}`;
app.use(express.json());
app.post(webhookPath, webhookCallback(bot, "express"));
app.get("/", (req, res) => res.send("Bot is running"));

// 启动
app.listen(port, async () => {
  console.log(`Server listening on port ${port}`);
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}${webhookPath}`;
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.api.setWebhook(webhookUrl);
    console.log(`Webhook set to ${webhookUrl}`);
  } catch (err) {
    console.log("设置 webhook 失败:", err.message);
  }
});
