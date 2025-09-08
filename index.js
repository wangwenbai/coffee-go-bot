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
const usedNicknames = new Set();
let blockedKeywords = [];
const dynamicAdmins = new Set();
const messageLocks = new Set();      // 消息去重锁
const notifyLocks = new Set();       // 通知去重锁
const forwardQueue = [];             // 消息队列
const notifyQueue = [];              // 违规通知队列
const pendingAdmins = new Map();     // origMsgId => Set(adminMsgId)

// ---------------------
// 屏蔽词
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
// 消息队列处理
// ---------------------
async function processForwardQueue(bot) {
  while (forwardQueue.length) {
    const { ctx, userId } = forwardQueue.shift();
    const msgKey = `${ctx.chat.id}:${ctx.message.message_id}`;
    if (messageLocks.has(msgKey)) continue; // 已处理
    messageLocks.add(msgKey);

    try {
      const msg = ctx.message;
      const caption = msg.caption ? `【${userId}】 ${msg.caption}` : msg.text ? `【${userId}】 ${msg.text}` : `【${userId}】`;
      if (msg.photo) await ctx.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, { caption });
      else if (msg.video) await ctx.api.sendVideo(GROUP_ID, msg.video.file_id, { caption });
      else if (msg.document) await ctx.api.sendDocument(GROUP_ID, msg.document.file_id, { caption });
      else if (msg.audio) await ctx.api.sendAudio(GROUP_ID, msg.audio.file_id, { caption });
      else await ctx.api.sendMessage(GROUP_ID, caption);
    } catch (err) {
      console.log("Forward error:", err.message);
    }
  }
}

async function processNotifyQueue(bot) {
  while (notifyQueue.length) {
    const { origMsgId, ctx, textToCheck, userId } = notifyQueue.shift();
    const notifyKey = `${ctx.chat.id}:${origMsgId}`;
    if (notifyLocks.has(notifyKey)) continue; // 已通知
    notifyLocks.add(notifyKey);

    for (const adminId of dynamicAdmins) {
      try {
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `approve:${origMsgId}:${ctx.from.id}`)
          .text("❌ Reject", `reject:${origMsgId}:${ctx.from.id}`);
        const msg = await bot.api.sendMessage(adminId,
          `用户 ${userId} 发送了链接或@，请审核:\n${textToCheck || "[Non-text]"}`,
          { reply_markup: keyboard });
        if (!pendingAdmins.has(origMsgId)) pendingAdmins.set(origMsgId, new Set());
        pendingAdmins.get(origMsgId).add(msg.message_id);
      } catch (err) {
        if (err.error_code === 403) console.warn(`管理员 ${adminId} 未私聊机器人，无法通知`);
      }
    }
  }
}

// ---------------------
// 创建机器人
// ---------------------
const bots = BOT_TOKENS.map(token => new Bot(token));
await Promise.all(bots.map(b => b.init()));

// ---------------------
// 群消息处理
// ---------------------
bots.forEach(bot => {
  bot.on("message", async ctx => {
    if (ctx.chat.type === "private" || ctx.from.is_bot) return;

    const member = await bot.api.getChatMember(GROUP_ID, ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    const userId = getUserId(ctx.from.id);

    if (!isAdmin) try { await ctx.deleteMessage(); } catch {}

    const textToCheck = ctx.message.text || ctx.message.caption;
    if (containsBlockedKeyword(textToCheck)) return;

    if (containsLinkOrMention(textToCheck)) {
      if (!ctx.from._violationCount) ctx.from._violationCount = 0;
      ctx.from._violationCount += 1;

      if (ctx.from._violationCount > 3) {
        notifyQueue.push({ origMsgId: ctx.message.message_id, ctx, textToCheck, userId });
        processNotifyQueue(bot);
      }
      return;
    }

    if (!isAdmin) {
      forwardQueue.push({ ctx, userId });
      processForwardQueue(bot);
    }
  });

  // ---------------------
  // 回调按钮处理 + 多管理员同步更新
  // ---------------------
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data.split(":");
    const action = data[0];
    const origMsgId = parseInt(data[1]);
    const origUserId = parseInt(data[2]);

    const member = await bot.api.getChatMember(GROUP_ID, ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    if (!isAdmin) return ctx.answerCallbackQuery({ text: "Only admins", show_alert: true });

    if (action === "approve" || action === "reject") {
      // 更新所有管理员按钮为“已处理”
      const processedKeyboard = new InlineKeyboard().text("✅ Processed", "processed");
      if (pendingAdmins.has(origMsgId)) {
        for (const msgId of pendingAdmins.get(origMsgId)) {
          try { await bot.api.editMessageReplyMarkup(ctx.from.id, msgId, { reply_markup: processedKeyboard }); } catch {}
        }
        pendingAdmins.delete(origMsgId);
      }

      await ctx.answerCallbackQuery({ text: action === "approve" ? "Message approved" : "Message rejected", show_alert: true });
    }
  });

  // ---------------------
  // 用户退群清理
  // ---------------------
  bot.on("chat_member", async ctx => {
    const status = ctx.chatMember.new_chat_member.status;
    const userId = ctx.chatMember.new_chat_member.user.id;
    if (status === "left" || status === "kicked") {
      const nickname = userMap.get(userId);
      if (nickname) usedNicknames.delete(nickname);
      userMap.delete(userId);
    }

    // 动态加入管理员
    if (ctx.chatMember.new_chat_member.user && !ctx.chatMember.new_chat_member.user.is_bot) {
      dynamicAdmins.add(ctx.chatMember.new_chat_member.user.id);
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
