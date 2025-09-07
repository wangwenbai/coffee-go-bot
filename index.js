import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";

dotenv.config();

const bot = new Bot(process.env.BOT_TOKEN);
const chatId = process.env.GROUP_ID;
const prefix = process.env.NICK_PREFIX || "User-";

const userMap = new Map();
const userHistory = new Map();
const messageMap = new Map();
const pendingMessages = new Map();

let blockedKeywords = [];

// Load blocked keywords
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

async function forwardMessage(ctx, userId, replyTargetId = null) {
  const msg = ctx.message;
  let sent;
  try {
    if (msg.text) sent = await ctx.api.sendMessage(chatId, `【${userId}】: ${msg.text}`, { reply_to_message_id: replyTargetId || undefined });
    else if (msg.photo) sent = await ctx.api.sendPhoto(chatId, msg.photo[msg.photo.length - 1].file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
    else if (msg.sticker) sent = await ctx.api.sendSticker(chatId, msg.sticker.file_id, { reply_to_message_id: replyTargetId || undefined });
    else if (msg.video) sent = await ctx.api.sendVideo(chatId, msg.video.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
    else if (msg.document) sent = await ctx.api.sendDocument(chatId, msg.document.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
    else if (msg.audio) sent = await ctx.api.sendAudio(chatId, msg.audio.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
    else if (msg.voice) sent = await ctx.api.sendVoice(chatId, msg.voice.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
    else if (msg.animation) sent = await ctx.api.sendAnimation(chatId, msg.animation.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
    else if (msg.location) sent = await ctx.api.sendMessage(chatId, `【${userId}】 sent location: [${msg.location.latitude}, ${msg.location.longitude}]`, { reply_to_message_id: replyTargetId || undefined });
    else if (msg.poll) sent = await ctx.api.sendPoll(chatId, msg.poll.question, msg.poll.options.map(o => o.text), { type: msg.poll.type, is_anonymous: true, reply_to_message_id: replyTargetId || undefined });
    else sent = await ctx.api.sendMessage(chatId, `【${userId}】 sent unsupported message type`, { reply_to_message_id: replyTargetId || undefined });

    if (sent) messageMap.set(msg.message_id, sent.message_id);
    saveUserMessage(userId, msg.text || "[Non-text]");
  } catch (err) {
    console.log("Forward message error:", err.message);
  }
}

// Handle group messages
bot.on("message", async ctx => {
  const msg = ctx.message;
  if (ctx.chat.type === "private" || ctx.from.is_bot) return;

  const userId = getUserId(ctx.from.id);

  // Delete original message
  try { await ctx.deleteMessage(); } catch {}

  // Blocked keyword
  if (msg.text && containsBlockedKeyword(msg.text)) return;

  // Messages with link or @ mention → private review
  if (msg.text && containsLinkOrMention(msg.text)) {
    try {
      const admins = await bot.api.getChatAdministrators(chatId);
      const adminUsers = admins.filter(a => !a.user.is_bot);

      for (const admin of adminUsers) {
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `approve:${msg.message_id}:${ctx.from.id}`)
          .text("❌ Reject", `reject:${msg.message_id}:${ctx.from.id}`);

        await bot.api.sendMessage(admin.user.id,
          `User ${ctx.from.first_name} (${userId}) sent a message containing a link or mention.\nContent: ${msg.text || "[Non-text]"}\nApprove to forward or reject.`,
          { reply_markup: keyboard }
        );
      }

      pendingMessages.set(msg.message_id, { ctx, userId });
    } catch (err) {
      console.log("Failed to send private review:", err.message);
    }
    return; // Do not forward yet
  }

  // Normal message → anonymous forward
  forwardMessage(ctx, userId);
});

// Callback query for approve/reject
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

  const pending = pendingMessages.get(origMsgId);
  if (!pending) return ctx.answerCallbackQuery({ text: "Already handled or not found", show_alert: true });

  if (action === "approve") {
    forwardMessage(pending.ctx, pending.userId);
    pendingMessages.delete(origMsgId);
    await ctx.answerCallbackQuery({ text: "Message approved and forwarded", show_alert: true });
  } else if (action === "reject") {
    pendingMessages.delete(origMsgId);
    await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
  }
});

// User left → clean mapping
bot.on("chat_member", async ctx => {
  const status = ctx.chatMember.new_chat_member.status;
  const userId = ctx.chatMember.new_chat_member.user.id;
  if (status === "left" || status === "kicked") {
    userMap.delete(userId);
    userHistory.delete(userId);
    console.log(`Removed anonymous ID for user ${userId}`);
  }
});

// Start bot with webhook (Render)
const app = express();
const port = process.env.PORT || 3000;
const webhookPath = `/bot${process.env.BOT_TOKEN}`;
app.use(express.json());
app.post(webhookPath, (req, res) => { bot.handleUpdate(req.body); res.sendStatus(200); });
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
