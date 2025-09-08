import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";

dotenv.config();

// ---------------------
// 环境变量
// ---------------------
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim()).filter(Boolean);
const GROUP_ID = process.env.GROUP_ID;
const NICK_PREFIX = process.env.NICK_PREFIX || "User";

// ---------------------
// 全局存储
// ---------------------
const userMap = new Map();          // telegramId => 匿名编号
const userHistory = new Map();      // 匿名编号 => 历史消息
const messageMap = new Map();       // 原始消息ID => 转发消息ID
const pendingMessages = new Map();  // `${origMsgId}:${adminId}` => { ctx, userId, notifMsgId, chatId }
const processedMessages = new Set(); // 已处理的违规消息ID
const usedNicknames = new Set();    
const notifiedUsers = new Set();    
const adminsSet = new Set();        // 存放已私聊的管理员ID

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
    nickname = `${NICK_PREFIX}${letters}${numbers}`;
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
// 创建机器人实例
// ---------------------
const bots = BOT_TOKENS.map(token => new Bot(token));
let nextBotIndex = 0;
function getNextBot() {
  const bot = bots[nextBotIndex];
  nextBotIndex = (nextBotIndex + 1) % bots.length;
  return bot;
}

// ---------------------
// 消息转发
// ---------------------
async function forwardMessage(bot, ctx, userId, targetChatId = GROUP_ID, replyTargetId = null) {
  const msg = ctx.message;
  let sent;
  try {
    const caption = msg.caption ? `【${userId}】 ${msg.caption}` : msg.text ? `【${userId}】 ${msg.text}` : `【${userId}】`;
    if (msg.photo) sent = await bot.api.sendPhoto(targetChatId, msg.photo[msg.photo.length - 1].file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.video) sent = await bot.api.sendVideo(targetChatId, msg.video.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.document) sent = await bot.api.sendDocument(targetChatId, msg.document.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.audio) sent = await bot.api.sendAudio(targetChatId, msg.audio.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.voice) sent = await bot.api.sendVoice(targetChatId, msg.voice.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.animation) sent = await bot.api.sendAnimation(targetChatId, msg.animation.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.sticker) sent = await bot.api.sendSticker(targetChatId, msg.sticker.file_id, { reply_to_message_id: replyTargetId || undefined });
    else if (msg.location) sent = await bot.api.sendMessage(targetChatId, `【${userId}】 sent location: [${msg.location.latitude}, ${msg.location.longitude}]`, { reply_to_message_id: replyTargetId || undefined });
    else if (msg.poll) sent = await bot.api.sendPoll(targetChatId, msg.poll.question, msg.poll.options.map(o => o.text), { type: msg.poll.type, is_anonymous: true, reply_to_message_id: replyTargetId || undefined });
    else sent = await bot.api.sendMessage(targetChatId, caption, { reply_to_message_id: replyTargetId || undefined });
    if (sent) messageMap.set(msg.message_id, sent.message_id);
    saveUserMessage(userId, msg.text || msg.caption || "[Non-text]");
  } catch (err) {
    console.log("Forward message error:", err.message);
  }
}

// ---------------------
// 通知管理员
// ---------------------
async function notifyAdminsOfSpammer(ctx, user, origMsgId) {
  try {
    for (const adminId of adminsSet) {
      try {
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `approve:${origMsgId}:${ctx.from.id}`)
          .text("❌ Reject", `reject:${origMsgId}:${ctx.from.id}`);
        const sentMsg = await ctx.bot.api.sendMessage(adminId, `🚨 User ${formatUserIdentity(user)} sent a link/mention.\nContent: ${ctx.message.text || ctx.message.caption || "[Non-text]"}\nApprove to forward or reject.`, { reply_markup: keyboard });
        pendingMessages.set(`${origMsgId}:${adminId}`, { ctx, userId: getUserId(ctx.from.id), notifMsgId: sentMsg.message_id, chatId: adminId });
      } catch {}
    }
  } catch (err) {
    console.log("Failed to notify admins:", err.message);
  }
}

// ---------------------
// 初始化机器人
// ---------------------
await Promise.all(bots.map(b => b.init()));

// ---------------------
// 群消息处理
// ---------------------
bots.forEach(bot => {
  bot.on("message", async ctx => {
    const msg = ctx.message;
    if (ctx.chat.type === "private" || ctx.from.is_bot) return;

    // 多机器人轮询
    const botToUse = getNextBot();
    if (bot.token !== botToUse.token) return;

    const member = await bot.api.getChatMember(GROUP_ID, ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    const userId = getUserId(ctx.from.id);

    if (!isAdmin) {
      try { await ctx.deleteMessage(); } catch {}
    }

    const textToCheck = msg.text || msg.caption;
    if (containsBlockedKeyword(textToCheck)) return;

    if (containsLinkOrMention(textToCheck)) {
      if (!processedMessages.has(msg.message_id)) {
        processedMessages.add(msg.message_id);
        await notifyAdminsOfSpammer(ctx, ctx.from, msg.message_id);
      }
      return;
    }

    if (!isAdmin) await forwardMessage(bot, ctx, userId);
  });
});

// ---------------------
// 回调查询处理（按钮）
// ---------------------
bots.forEach(bot => {
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data.split(":");
    const action = data[0];
    const origMsgId = parseInt(data[1]);
    const origUserId = parseInt(data[2]);

    if (!pendingMessages.has(`${origMsgId}:${ctx.from.id}`)) {
      return ctx.answerCallbackQuery({ text: "Already processed or invalid", show_alert: true });
    }

    try {
      if (action === "approve") {
        await forwardMessage(ctx.bot, pendingMessages.get(`${origMsgId}:${ctx.from.id}`).ctx, getUserId(origUserId));
        await ctx.answerCallbackQuery({ text: "Message approved and forwarded", show_alert: true });
      } else if (action === "reject") {
        await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
      }

      // 编辑所有管理员通知消息，标记为已处理
      for (const [key, pending] of pendingMessages.entries()) {
        if (key.startsWith(`${origMsgId}:`)) {
          try {
            await ctx.bot.api.editMessageReplyMarkup(pending.chatId, pending.notifMsgId, { reply_markup: new InlineKeyboard().text("✅ Processed", "processed") });
          } catch {}
          pendingMessages.delete(key);
        }
      }

    } catch (err) {
      console.log("Error handling callback:", err.message);
    }
  });
});

// ---------------------
// 管理员私聊记录
// ---------------------
bots.forEach(bot => {
  bot.on("message:text", ctx => {
    if (ctx.chat.type === "private" && !ctx.from.is_bot) {
      adminsSet.add(ctx.from.id);
    }
  });
});

// ---------------------
// 用户退群清理
// ---------------------
bots.forEach(bot => {
  bot.on("chat_member", ctx => {
    const status = ctx.chatMember.new_chat_member.status;
    const userId = ctx.chatMember.new_chat_member.user.id;
    if (status === "left" || status === "kicked") {
      const nickname = userMap.get(userId);
      if (nickname) usedNicknames.delete(nickname);
      userMap.delete(userId);
      userHistory.delete(userId);
      processedMessages.delete(userId);
      notifiedUsers.delete(userId);
    }
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
