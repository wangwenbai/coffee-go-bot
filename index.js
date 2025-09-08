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
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

// ---------------------
// 全局存储
// ---------------------
const userMap = new Map();          
const userHistory = new Map();      
const messageMap = new Map();       
const pendingMessages = new Map();  
const usedNicknames = new Set();    
const violationCount = new Map();   
let dynamicAdmins = new Set();      
let blockedKeywords = [];

// 消息去重缓存
const forwardedMsgIds = new Set();
const MAX_CACHE_SIZE = 5000;

// ---------------------
// 屏蔽词逻辑
// ---------------------
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

// ---------------------
// 通知管理员
// ---------------------
async function notifyAdminsOfSpammer(userId, reason) {
  if (!dynamicAdmins.size) return;
  const firstBot = bots[0]; 
  for (const adminId of dynamicAdmins) {
    try {
      await firstBot.api.sendMessage(adminId, `🚨 用户 ${userId} ${reason}`);
    } catch (err) {
      if (err.error_code === 403) console.warn(`管理员 ${adminId} 未与机器人私聊，无法通知`);
    }
  }
}

// ---------------------
// 消息转发
// ---------------------
async function forwardMessage(ctx, userId, targetChatId = GROUP_ID, replyTargetId = null) {
  const msg = ctx.message;
  if (forwardedMsgIds.has(msg.message_id)) return; 
  forwardedMsgIds.add(msg.message_id);
  if (forwardedMsgIds.size > MAX_CACHE_SIZE) {
    const first = forwardedMsgIds.values().next().value;
    forwardedMsgIds.delete(first);
  }

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

    const member = await bot.api.getChatMember(GROUP_ID, ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    const userId = getUserId(ctx.from.id);

    if (isAdmin) return; 

    try { await ctx.deleteMessage(); } catch {}

    const textToCheck = msg.text || msg.caption;
    if (containsBlockedKeyword(textToCheck)) return;

    if (containsLinkOrMention(textToCheck)) {
      const count = (violationCount.get(ctx.from.id) || 0) + 1;
      violationCount.set(ctx.from.id, count);

      if (count > 3) await notifyAdminsOfSpammer(userId, "发送链接或@超过3次");

      for (const adminId of dynamicAdmins) {
        try {
          const keyboard = new InlineKeyboard()
            .text("✅ Approve", `approve:${msg.message_id}:${ctx.from.id}`)
            .text("❌ Reject", `reject:${msg.message_id}:${ctx.from.id}`);
          const sentMsg = await bots[0].api.sendMessage(adminId,
            `用户 ${userId} 发送了链接或@，请审核:\n${textToCheck || "[Non-text]"}`,
            { reply_markup: keyboard });
          pendingMessages.set(`${msg.message_id}:${adminId}`, { ctx, userId, notifMsgId: sentMsg.message_id, chatId: adminId });
        } catch (err) {
          if (err.error_code === 403) console.warn(`管理员 ${adminId} 未私聊机器人，无法通知`);
        }
      }
      return;
    }

    await forwardMessage(ctx, userId);
  });
});

// ---------------------
// 回调查询、用户退群清理、管理员动态注册
// ---------------------
bots.forEach(bot => {
  bot.on("callback_query:data", async ctx => {
    const userIdClicker = ctx.from.id;
    const member = await bot.api.getChatMember(GROUP_ID, userIdClicker);
    if (!(member.status === "administrator" || member.status === "creator")) return ctx.answerCallbackQuery({ text: "Only admins", show_alert: true });

    const data = ctx.callbackQuery.data.split(":");
    const action = data[0];
    const origMsgId = parseInt(data[1]);
    const origUserId = parseInt(data[2]);

    const pendingKeys = Array.from(pendingMessages.keys()).filter(key => key.startsWith(`${origMsgId}:`));
    if (!pendingKeys.length) return ctx.answerCallbackQuery({ text: "Already processed", show_alert: true });

    try {
      if (action === "approve") {
        await forwardMessage(pendingMessages.get(pendingKeys[0]).ctx, pendingMessages.get(pendingKeys[0]).userId);
        await ctx.answerCallbackQuery({ text: "Message approved", show_alert: true });
      } else if (action === "reject") {
        await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
      }

      await Promise.all(pendingKeys.map(async key => {
        const pending = pendingMessages.get(key);
        try {
          await bot.api.editMessageReplyMarkup(pending.chatId, pending.notifMsgId, { reply_markup: new InlineKeyboard().text("✅ Processed", "processed") });
        } catch {}
        pendingMessages.delete(key);
      }));
    } catch (err) { console.log("Callback error:", err.message); }
  });

  bot.on("chat_member", async ctx => {
    const status = ctx.chatMember.new_chat_member.status;
    const userId = ctx.chatMember.new_chat_member.user.id;
    if (status === "left" || status === "kicked") {
      const nickname = userMap.get(userId);
      if (nickname) usedNicknames.delete(nickname);
      userMap.delete(userId);
      userHistory.delete(userId);
      violationCount.delete(userId);
      console.log(`Removed anonymous ID for user ${userId}`);
    }
  });

  bot.on("message:text", async ctx => {
    if (ctx.chat.type === "private" && ctx.text === "/start") {
      dynamicAdmins.add(ctx.from.id);
      await ctx.reply("您已注册为管理员，可接收违规通知。");
    }
  });
});

// ---------------------
// Express Webhook
// ---------------------
const app = express();
app.use(express.json());

bots.forEach(bot => {
  const webhookPath = `/bot${bot.token}`;
  app.post(webhookPath, (req, res) => { bot.handleUpdate(req.body).catch(console.error); res.sendStatus(200); });
});

app.get("/", (req, res) => res.send("Bot running"));

app.listen(PORT, async () => {
  console.log(`Listening on port ${PORT}`);
  if (!RENDER_EXTERNAL_URL) return;

  await Promise.all(bots.map(async bot => {
    const webhookUrl = `${RENDER_EXTERNAL_URL}/bot${bot.token}`;
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
      await bot.api.setWebhook(webhookUrl);
      console.log(`Webhook set for bot ${bot.token}: ${webhookUrl}`);
    } catch (err) {
      console.log(`Webhook setup failed for bot ${bot.token}:`, err.message);
    }
  }));
});
