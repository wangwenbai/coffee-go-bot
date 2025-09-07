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

// ---------------------
// 消息转发函数
// ---------------------
async function forwardMessage(ctx, userId, replyTargetId = null) {
  const msg = ctx.message;
  let sent;
  try {
    const caption = msg.caption ? `【${userId}】 ${msg.caption}` : msg.text ? `【${userId}】: ${msg.text}` : `【${userId}】`;

    if (msg.photo) sent = await ctx.api.sendPhoto(chatId, msg.photo[msg.photo.length - 1].file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.video) sent = await ctx.api.sendVideo(chatId, msg.video.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.document) sent = await ctx.api.sendDocument(chatId, msg.document.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.audio) sent = await ctx.api.sendAudio(chatId, msg.audio.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.voice) sent = await ctx.api.sendVoice(chatId, msg.voice.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.animation) sent = await ctx.api.sendAnimation(chatId, msg.animation.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.sticker) sent = await ctx.api.sendSticker(chatId, msg.sticker.file_id, { reply_to_message_id: replyTargetId || undefined });
    else if (msg.location) sent = await ctx.api.sendMessage(chatId, `【${userId}】 sent location: [${msg.location.latitude}, ${msg.location.longitude}]`, { reply_to_message_id: replyTargetId || undefined });
    else if (msg.poll) sent = await ctx.api.sendPoll(chatId, msg.poll.question, msg.poll.options.map(o => o.text), { type: msg.poll.type, is_anonymous: true, reply_to_message_id: replyTargetId || undefined });
    else sent = await ctx.api.sendMessage(chatId, caption, { reply_to_message_id: replyTargetId || undefined });

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
  const isChannelMsg = !!msg.sender_chat && msg.sender_chat.type === "channel";

  // 管理员消息或频道消息直接显示，不删除
  if (isAdmin || isChannelMsg) return;

  const userId = getUserId(ctx.from.id);
  const textToCheck = msg.text || msg.caption;

  // 屏蔽词检查
  if (containsBlockedKeyword(textToCheck)) {
    try { await ctx.deleteMessage(); } catch {}
    return;
  }

  // 含链接/@ → 私聊管理员审核
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
    try { await ctx.deleteMessage(); } catch {}
    return;
  }

  // 普通消息 → 匿名转发
  forwardMessage(ctx, userId);
  try { await ctx.deleteMessage(); } catch {}
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

    // 编辑所有管理员的通知消息为已处理
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
