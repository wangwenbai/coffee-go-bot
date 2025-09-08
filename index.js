import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";
import Redis from "ioredis";

dotenv.config();

// ---------------------
// 环境变量
// ---------------------
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim()).filter(Boolean);
const GROUP_ID = process.env.GROUP_ID;
const NICK_PREFIX = process.env.NICK_PREFIX || "User";
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// ---------------------
// Redis 客户端
// ---------------------
const redis = new Redis(REDIS_URL);

// ---------------------
// 全局存储
// ---------------------
const userMap = new Map();
const usedNicknames = new Set();
let blockedKeywords = [];
const dynamicAdmins = new Set();

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
// 消息队列
// ---------------------
async function enqueueForward(ctx, userId) {
  const msgKey = `msgLock:${ctx.chat.id}:${ctx.message.message_id}`;
  const locked = await redis.set(msgKey, "1", "NX", "EX", 60); // 上锁60秒
  if (!locked) return; // 已被其他机器人处理过

  const msgStr = JSON.stringify({ chatId: GROUP_ID, message: ctx.message, userId });
  await redis.rpush("forwardQueue", msgStr);
}

async function processForwardQueue(bot) {
  while (true) {
    const data = await redis.lpop("forwardQueue");
    if (!data) break;
    const { chatId, message, userId } = JSON.parse(data);
    try {
      const caption = message.caption ? `【${userId}】 ${message.caption}` : message.text ? `【${userId}】 ${message.text}` : `【${userId}】`;
      if (message.photo) await bot.api.sendPhoto(chatId, message.photo[message.photo.length - 1].file_id, { caption });
      else if (message.video) await bot.api.sendVideo(chatId, message.video.file_id, { caption });
      else await bot.api.sendMessage(chatId, caption);
    } catch (err) {
      console.log("Forward error:", err.message);
    }
  }
}

// ---------------------
// 违规通知队列
// ---------------------
async function enqueueNotify(origMsgId, ctx, textToCheck, userId) {
  const notifyKey = `notifyLock:${ctx.chat.id}:${origMsgId}`;
  const locked = await redis.set(notifyKey, "1", "NX", "EX", 60);
  if (!locked) return; // 已通知过

  const dataStr = JSON.stringify({ origMsgId, chatId: ctx.chat.id, fromId: ctx.from.id, textToCheck, userId });
  await redis.rpush("notifyQueue", dataStr);
}

async function processNotifyQueue(bot) {
  while (true) {
    const data = await redis.lpop("notifyQueue");
    if (!data) break;
    const { origMsgId, chatId, fromId, textToCheck, userId } = JSON.parse(data);

    for (const adminId of dynamicAdmins) {
      try {
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `approve:${origMsgId}:${fromId}`)
          .text("❌ Reject", `reject:${origMsgId}:${fromId}`);
        const msg = await bot.api.sendMessage(adminId,
          `用户 ${userId} 发送了链接或@，请审核:\n${textToCheck || "[Non-text]"}`,
          { reply_markup: keyboard });
        // 保存 pending 数据
        await redis.sadd(`pendingAdmins:${origMsgId}`, msg.message_id);
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
      const key = `violation:${ctx.from.id}`;
      let count = parseInt(await redis.get(key) || "0") + 1;
      await redis.set(key, count);

      if (count > 3) {
        await enqueueNotify(ctx.message.message_id, ctx, textToCheck, userId);
        processNotifyQueue(bot);
      }
      return;
    }

    if (!isAdmin) {
      await enqueueForward(ctx, userId);
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

    const isAdmin = (await bot.api.getChatMember(GROUP_ID, ctx.from.id)).status === "administrator" || ctx.from.id === GROUP_ID;
    if (!isAdmin) return ctx.answerCallbackQuery({ text: "Only admins", show_alert: true });

    const pendingMsgIds = await redis.smembers(`pendingAdmins:${origMsgId}`);
    if (!pendingMsgIds || pendingMsgIds.length === 0) return ctx.answerCallbackQuery({ text: "Already processed", show_alert: true });

    // 审核操作
    if (action === "approve") {
      const msgKey = `msgLock:${GROUP_ID}:${origMsgId}`;
      const locked = await redis.set(msgKey, "1", "NX", "EX", 60);
      if (locked) {
        // 可以转发原消息
        const msgData = await redis.get(`origMessage:${origMsgId}`);
        if (msgData) {
          const { ctxObj, userId } = JSON.parse(msgData);
          await enqueueForward(ctxObj, userId);
          processForwardQueue(bot);
        }
      }
      await ctx.answerCallbackQuery({ text: "Message approved and forwarded", show_alert: true });
    } else if (action === "reject") {
      await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
    }

    // 更新所有管理员按钮为“已处理”
    const processedKeyboard = new InlineKeyboard().text("✅ Processed", "processed");
    for (const msgId of pendingMsgIds) {
      try { await bot.api.editMessageReplyMarkup(ctx.from.id, parseInt(msgId), { reply_markup: processedKeyboard }); } catch {}
    }

    await redis.del(`pendingAdmins:${origMsgId}`);
    await redis.del(`origMessage:${origMsgId}`);
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
