import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";

dotenv.config();

// ---------------------
// Bot 初始化
// ---------------------
const bot = new Bot(process.env.BOT_TOKEN);
await bot.init();

const chatId = process.env.GROUP_ID;
const prefix = process.env.NICK_PREFIX || "User-";

const userMap = new Map();          // telegramId => 匿名编号
const userHistory = new Map();      // 匿名编号 => 历史消息
const messageMap = new Map();       // 原始消息ID => 转发消息ID
const pendingMessages = new Map();  // key: `${origMsgId}:${adminId}` => { ctx, userId, notifMsgId, chatId }

// NEW: 恶意广告计数与已通知集合（避免重复通知）
const adCountMap = new Map();       // telegramId => 广告次数
const notifiedUsers = new Set();    // telegramId（已触发过通知的用户）

// ---------------------
// 屏蔽词逻辑
// ---------------------
let blockedKeywords = [];

function loadBlockedKeywords() {
  try {
    const data = fs.readFileSync('./blocked.txt', 'utf8');
    blockedKeywords = data.split(',').map(w => w.trim()).filter(Boolean);
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
function generateRandomId() { return Math.floor(10000 + Math.random() * 90000); }

function getUserId(userId) {
  if (!userMap.has(userId)) userMap.set(userId, `${prefix}${generateRandomId()}`);
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

// NEW: 超过阈值后私聊所有管理员的通知函数
async function notifyAdminsOfSpammer(ctx, count, anonId) {
  try {
    const admins = await bot.api.getChatAdministrators(chatId);
    const adminUsers = admins.filter(a => !a.user.is_bot);
    const username = ctx.from.username ? `@${ctx.from.username}` : "(no username)";
    const text = [
      "🚨 Ad-Spam Alert",
      `User: ${username}`,
      `Telegram ID: ${ctx.from.id}`,
      `Anon ID: ${anonId}`,
      `Detected Ad Attempts: ${count}`,
      `Action: Please review this member.`
    ].join("\n");
    for (const admin of adminUsers) {
      await bot.api.sendMessage(admin.user.id, text);
    }
  } catch (err) {
    console.log("Failed to notify admins:", err.message);
  }
}

// ---------------------
// 消息转发函数
// ---------------------
async function forwardMessage(ctx, userId, targetChatId = chatId, replyTargetId = null) {
  const msg = ctx.message;
  let sent;
  try {
    const caption = msg.caption ? `【${userId}】 ${msg.caption}` : msg.text ? `【${userId}】: ${msg.text}` : `【${userId}】`;

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
// 群消息处理
// ---------------------
bot.on("message", async ctx => {
  const msg = ctx.message;
  if (ctx.chat.type === "private" || ctx.from.is_bot) return;

  const member = await bot.api.getChatMember(chatId, ctx.from.id);
  const isAdmin = member.status === "administrator" || member.status === "creator";

  const userId = getUserId(ctx.from.id);

  // 管理员消息不匿名
  if (isAdmin) return;

  // 删除普通用户消息
  try { await ctx.deleteMessage(); } catch {}

  // NEW: 统计恶意广告（含链接/@ 或 命中屏蔽词）
  const textToCheck = msg.text || msg.caption;
  const isAdAttempt = containsLinkOrMention(textToCheck) || containsBlockedKeyword(textToCheck);
  if (isAdAttempt) {
    const prev = adCountMap.get(ctx.from.id) || 0;
    const next = prev + 1;
    adCountMap.set(ctx.from.id, next);

    // 超过三次且尚未通知过 → 私聊所有管理员一次
    if (next > 3 && !notifiedUsers.has(ctx.from.id)) {
      await notifyAdminsOfSpammer(ctx, next, userId);
      notifiedUsers.add(ctx.from.id); // 若希望每次都通知，可移除此行与上方判断
    }
  }

  // 屏蔽词检查（保持你的原有逻辑）
  if (containsBlockedKeyword(textToCheck)) return;

  // 含链接/@ → 私聊管理员审核（保持你的原有逻辑）
  if (containsLinkOrMention(textToCheck)) {
    try {
      const admins = await bot.api.getChatAdministrators(chatId);
      const adminUsers = admins.filter(a => !a.user.is_bot);
      for (const admin of adminUsers) {
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `approve:${msg.message_id}:${ctx.from.id}`)
          .text("❌ Reject", `reject:${msg.message_id}:${ctx.from.id}`);
        const sentMsg = await bot.api.sendMessage(admin.user.id,
          `User ${ctx.from.first_name} (${userId}) sent a message containing a link or mention.\nContent: ${textToCheck || "[Non-text]"}\nApprove to forward or reject.`,
          { reply_markup: keyboard }
        );
        pendingMessages.set(`${msg.message_id}:${admin.user.id}`, { ctx, userId, notifMsgId: sentMsg.message_id, chatId: admin.user.id });
      }
    } catch (err) {
      console.log("Failed to send private review:", err.message);
    }
    return;
  }

  // 匿名转发到主群（保持你的原有逻辑）
  await forwardMessage(ctx, userId);

  // 同步到讨论群（如果是频道转发或讨论群）（保持你的原有逻辑）
  if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
    await forwardMessage(ctx, userId, msg.chat.id);
  }
});

// ---------------------
// 回调查询（审核按钮）
// ---------------------
bot.on("callback_query:data", async ctx => {
  const userIdClicker = ctx.from.id;
  const member = await bot.api.getChatMember(chatId, userIdClicker);
  if (!(member.status === "administrator" || member.status === "creator")) {
    return ctx.answerCallbackQuery({ text: "Only admins can approve/reject", show_alert: true });
  }

  const data = ctx.callbackQuery.data.split(":");
  const action = data[0];
  const origMsgId = parseInt(data[1]);
  const origUserId = parseInt(data[2]);

  const pendingKeys = Array.from(pendingMessages.keys()).filter(key => key.startsWith(`${origMsgId}:`));

  if (pendingKeys.length === 0) {
    return ctx.answerCallbackQuery({ text: "This message has been processed", show_alert: true });
  }

  try {
    if (action === "approve") {
      await forwardMessage(pendingMessages.get(pendingKeys[0]).ctx, pendingMessages.get(pendingKeys[0]).userId);
      await ctx.answerCallbackQuery({ text: "Message approved and forwarded", show_alert: true });
    } else if (action === "reject") {
      await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
    }

    // 编辑所有管理员通知消息为已处理
    for (const key of pendingKeys) {
      const pending = pendingMessages.get(key);
      try {
        await bot.api.editMessageReplyMarkup(pending.chatId, pending.notifMsgId,
          { reply_markup: new InlineKeyboard().text("✅ Processed", "processed") }
        );
      } catch (err) {
        console.log("Failed to edit notification message:", err.message);
      }
      pendingMessages.delete(key);
    }
  } catch (err) {
    console.log("Error handling callback:", err.message);
  }
});

// ---------------------
// 用户退群清理
// ---------------------
bot.on("chat_member", async ctx => {
  const status = ctx.chatMember.new_chat_member.status;
  const userId = ctx.chatMember.new_chat_member.user.id;
  if (status === "left" || status === "kicked") {
    userMap.delete(userId);
    userHistory.delete(userId);
    // NEW: 同时清理计数和通知状态，避免数据残留
    adCountMap.delete(userId);
    notifiedUsers.delete(userId);
    console.log(`Removed anonymous ID for user ${userId}`);
  }
});

// ---------------------
// Express Webhook (Render)
// ---------------------
const app = express();
const port = process.env.PORT || 3000;
const webhookPath = `/bot${process.env.BOT_TOKEN}`;

app.use(express.json());
app.post(webhookPath, (req, res) => { bot.handleUpdate(req.body).catch(console.error); res.sendStatus(200); });
app.get("/", (req, res) => res.send("Bot running"));

app.listen(port, async () => {
  console.log(`Listening on port ${port}`);
  if (!process.env.RENDER_EXTERNAL_URL) return;
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}${webhookPath}`;
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.api.setWebhook(webhookUrl);
    console.log(`Webhook set to ${webhookUrl}`);
  } catch (err) {
    console.log("Webhook setup failed:", err.message);
  }
});
