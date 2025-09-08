import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";

dotenv.config();

// ---------------------
// 环境变量
// ---------------------
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim()).filter(Boolean); // 多机器人
const chatId = process.env.GROUP_ID;
const prefix = process.env.NICK_PREFIX || "User";

// ---------------------
// 全局存储
// ---------------------
const userMap = new Map();          // telegramId => 匿名编号
const userHistory = new Map();      // 匿名编号 => 历史消息
const messageMap = new Map();       // 原始消息ID => 转发消息ID
const pendingMessages = new Map();  // `${origMsgId}:${adminId}` => { ctx, userId, notifMsgId, chatId }
const usedNicknames = new Set();
const adCountMap = new Map();       // 违规计数
const notifiedUsers = new Set();    // 已通知管理员的用户

let robotIndex = 0; // 用于轮询机器人处理

// ---------------------
// 屏蔽词逻辑
// ---------------------
let blockedKeywords = [];
function loadBlockedKeywords() {
  try {
    const data = fs.readFileSync('./blocked.txt', 'utf8');
    blockedKeywords = data.split('\n').map(w => w.trim()).filter(Boolean);
    console.log(`Blocked keywords loaded: ${blockedKeywords.length}`);
  } catch (err) {
    console.log("Failed to load blocked keywords:", err.message);
  }
}
loadBlockedKeywords();
fs.watchFile('./blocked.txt', () => loadBlockedKeywords());

// ---------------------
// 工具函数
// ---------------------
function generateRandomNickname() {
  let nickname;
  do {
    const letters = String.fromCharCode(65 + Math.floor(Math.random() * 26)) +
                    String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const numbers = Math.floor(Math.random() * 10).toString() +
                    Math.floor(Math.random() * 10).toString();
    nickname = `${prefix}${letters}${numbers}`;
  } while (usedNicknames.has(nickname));
  usedNicknames.add(nickname);
  return nickname;
}

function getUserId(userId) {
  if (!userMap.has(userId)) userMap.set(userId, generateRandomNickname());
  return userMap.get(userId);
}

function saveUserMessage(userId, msg) {
  if (!userHistory.has(userId)) userHistory.set(userId, []);
  userHistory.get(userId).push(msg);
}

function containsBlockedKeyword(text) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return blockedKeywords.some(word => lowerText.includes(word.toLowerCase()));
}

function containsLinkOrMention(text) {
  if (!text) return false;
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
  const mentionRegex = /@[a-zA-Z0-9_]+/;
  return urlRegex.test(text) || mentionRegex.test(text);
}

function formatUserIdentity(user) {
  if (user.username) return `@${user.username}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return `${name || "Unknown User"} (no username)`;
}

// ---------------------
// 通知管理员
// ---------------------
async function notifyAdminsOfSpammer(bot, user, text) {
  try {
    const admins = await bot.api.getChatAdministrators(chatId);
    const adminUsers = admins.filter(a => !a.user.is_bot);
    const userIdentity = formatUserIdentity(user);
    for (const admin of adminUsers) {
      try {
        await bot.api.sendMessage(
          admin.user.id,
          `🚨 User ${userIdentity} sent a message containing a link or mention.\nContent: ${text || "[Non-text]"}`
        );
      } catch (err) {
        if (err.response?.description?.includes("bot can't initiate conversation")) {
          // 管理员未私聊机器人，跳过
        } else console.log("Failed to notify admin:", err.message);
      }
    }
  } catch (err) {
    console.log("Failed to notify admins:", err.message);
  }
}

// ---------------------
// 消息转发
// ---------------------
async function forwardMessage(ctx, userId, targetChatId = chatId, replyTargetId = null) {
  const msg = ctx.message;
  let sent;
  try {
    const caption = msg.caption ? `【${userId}】 ${msg.caption}` : msg.text ? `【${userId}】 ${msg.text}` : `【${userId}】`;
    if (msg.photo) sent = await ctx.api.sendPhoto(targetChatId, msg.photo[msg.photo.length - 1].file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.video) sent = await ctx.api.sendVideo(targetChatId, msg.video.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.document) sent = await ctx.api.sendDocument(targetChatId, msg.document.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.audio) sent = await ctx.api.sendAudio(targetChatId, msg.audio.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.voice) sent = await ctx.api.sendVoice(targetChatId, msg.voice.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.animation) sent = await ctx.api.sendAnimation(targetChatId, msg.animation.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.sticker) sent = await ctx.api.sendSticker(targetChatId, msg.sticker.file_id, { reply_to_message_id: replyTargetId || undefined });
    else if (msg.location) sent = await ctx.api.sendMessage(targetChatId, `【${userId}】 sent location: [${msg.location.latitude}, ${msg.location.longitude}]`, { reply_to_message_id: replyTargetId || undefined });
    else if (msg.poll) sent = await ctx.api.sendPoll(targetChatId, msg.poll.question, msg.poll.options.map(o => o.text), { type: msg.poll.type, is_anonymous: true, reply_to_message_id: replyTargetId || undefined });
    else sent = await ctx.api.sendMessage(targetChatId, caption, { reply_to_message_id: replyTargetId || undefined });

    if (sent) messageMap.set(msg.message_id, sent.message_id);
    saveUserMessage(userId, msg.text || msg.caption || "[Non-text]");
  } catch (err) {
    console.log("Forward message error:", err.message);
  }
}

// ---------------------
// 创建机器人实例
// ---------------------
const bots = BOT_TOKENS.map(token => new Bot(token));
await Promise.all(bots.map(b => b.init()));

// ---------------------
// 群消息处理
// ---------------------
bots.forEach(bot => {
  bot.on("message", async ctx => {
    const msg = ctx.message;
    if (ctx.chat.type === "private" || ctx.from.is_bot) return;

    const member = await bot.api.getChatMember(chatId, ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    const userId = getUserId(ctx.from.id);

    // 管理员消息不匿名转发，不删除
    if (isAdmin) return;

    const textToCheck = msg.text || msg.caption;

    // ----------------- 违规通知 -----------------
    if (containsLinkOrMention(textToCheck)) {
      const currentCount = (adCountMap.get(ctx.from.id) || 0) + 1;
      adCountMap.set(ctx.from.id, currentCount);
      if (!notifiedUsers.has(ctx.from.id)) {
        notifiedUsers.add(ctx.from.id);
        await notifyAdminsOfSpammer(bot, ctx.from, textToCheck);
      }
    }

    // ----------------- 屏蔽词检查 -----------------
    if (containsBlockedKeyword(textToCheck)) return;

    // ----------------- 轮询删除与转发 -----------------
    const currentBot = bots[robotIndex];
    if (bot.token !== currentBot.token) return; // 轮到其他机器人处理

    // 删除原消息
    try { await ctx.deleteMessage(); } catch {}

    // 匿名转发
    await forwardMessage(ctx, userId);

    robotIndex = (robotIndex + 1) % bots.length; // 轮询下一个机器人
  });
});

// ---------------------
// Express Webhook
// ---------------------
const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

bots.forEach(bot => {
  const webhookPath = `/bot${bot.token}`;
  app.post(webhookPath, (req, res) => { bot.handleUpdate(req.body).catch(console.error); res.sendStatus(200); });
});

app.get("/", (req, res) => res.send("Bot running"));

app.listen(port, async () => {
  console.log(`Listening on port ${port}`);
  if (!process.env.RENDER_EXTERNAL_URL) return;

  await Promise.all(bots.map(async bot => {
    const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/bot${bot.token}`;
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
      await bot.api.setWebhook(webhookUrl);
      console.log(`Webhook set for bot ${bot.token}: ${webhookUrl}`);
    } catch (err) {
      console.log(`Webhook setup failed for bot ${bot.token}:`, err.message);
    }
  }));
});
