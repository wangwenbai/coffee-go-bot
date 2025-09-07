import { Bot, webhookCallback, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";

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
fs.watchFile('./blocked.txt', () => {
  console.log('blocked.txt changed, reloading...');
  loadBlockedKeywords();
});

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

async function isAdminMessage(userId) {
  try {
    const member = await bot.api.getChatMember(chatId, userId);
    return member.status === "administrator" || member.status === "creator";
  } catch (err) {
    console.log("Check admin failed:", err.message);
    return false;
  }
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
    if (msg.text) {
      sent = await ctx.api.sendMessage(chatId, `【${userId}】: ${msg.text}`, { reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, msg.text);
    } else if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1].file_id;
      sent = await ctx.api.sendPhoto(chatId, photo, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[Photo]");
    } else if (msg.sticker) {
      sent = await ctx.api.sendSticker(chatId, msg.sticker.file_id, { reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[Sticker]");
    } else if (msg.video) {
      sent = await ctx.api.sendVideo(chatId, msg.video.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[Video]");
    } else if (msg.document) {
      sent = await ctx.api.sendDocument(chatId, msg.document.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[Document]");
    } else if (msg.audio) {
      sent = await ctx.api.sendAudio(chatId, msg.audio.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[Audio]");
    } else if (msg.voice) {
      sent = await ctx.api.sendVoice(chatId, msg.voice.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[Voice]");
    } else if (msg.animation) {
      sent = await ctx.api.sendAnimation(chatId, msg.animation.file_id, { caption: `【${userId}】`, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[Animation]");
    } else if (msg.location) {
      sent = await ctx.api.sendMessage(chatId, `【${userId}】 sent location: [${msg.location.latitude}, ${msg.location.longitude}]`, { reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[Location]");
    } else if (msg.poll) {
      const poll = msg.poll;
      sent = await ctx.api.sendPoll(chatId, poll.question, poll.options.map(o => o.text), { type: poll.type, is_anonymous: true, reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[Poll]");
    } else {
      sent = await ctx.api.sendMessage(chatId, `【${userId}】 sent unsupported message type`, { reply_to_message_id: replyTargetId || undefined });
      saveUserMessage(userId, "[Unsupported]");
    }
    if (sent) messageMap.set(msg.message_id, sent.message_id);
  } catch (err) {
    console.log("Forward message error:", err.message);
  }
}

// Handle group messages
bot.on("message", async ctx => {
  const msg = ctx.message;
  if (ctx.chat.type === "private" || ctx.from.is_bot) return;

  if (await isAdminMessage(ctx.from.id)) return;

  const userId = getUserId(ctx.from.id);
  let replyTargetId = null;
  if (msg.reply_to_message) replyTargetId = messageMap.get(msg.reply_to_message.message_id) || null;

  try { await ctx.deleteMessage(); } catch {}

  if (msg.text && containsBlockedKeyword(msg.text)) {
    saveUserMessage(userId, "[Blocked message]");
    return;
  }

  if (msg.text && containsLinkOrMention(msg.text)) {
    const admins = await bot.api.getChatAdministrators(chatId);
    const adminMentions = admins.filter(a => !a.user.is_bot).map(a => `@${a.user.username || a.user.first_name}`).join(' ');

    const keyboard = new InlineKeyboard()
      .text("✅ Approve", `approve:${msg.message_id}:${ctx.from.id}`)
      .text("❌ Reject", `reject:${msg.message_id}:${ctx.from.id}`);

    try {
      const notifMsg = await ctx.api.sendMessage(chatId,
        `User ${ctx.from.first_name} (${userId}) sent a link or @ mention. Admins, please review:\n${msg.text}\n${adminMentions}`,
        { reply_markup: keyboard }
      );

      pendingMessages.set(msg.message_id, { ctx, userId, replyTargetId, notifMsgId: notifMsg.message_id });
      console.log("Pending message saved with notifMsgId:", notifMsg.message_id);
    } catch (err) {
      console.log("Send notification failed:", err.message);
    }
    return;
  }

  forwardMessage(ctx, userId, replyTargetId);
});

// Callback handler
bot.on("callback_query:data", async ctx => {
  const userIdClicker = ctx.from.id;
  const member = await bot.api.getChatMember(chatId, userIdClicker);
  if (!(member.status === "administrator" || member.status === "creator")) {
    return ctx.answerCallbackQuery({ text: "Only admins can approve or reject", show_alert: true });
  }

  const data = ctx.callbackQuery.data.split(":");
  const action = data[0];
  const msgId = parseInt(data[1]);
  const pending = pendingMessages.get(msgId);
  if (!pending) return ctx.answerCallbackQuery({ text: "Message not found or already handled", show_alert: true });

  try {
    await ctx.api.deleteMessage(pending.notifMsgId);
    console.log("Deleted notification message:", pending.notifMsgId);
  } catch (err) {
    console.log("Delete notification failed:", err.message);
  }

  if (action === "approve") {
    await forwardMessage(pending.ctx, pending.userId, pending.replyTargetId);
    pendingMessages.delete(msgId);
    await ctx.answerCallbackQuery({ text: "Message approved and forwarded", show_alert: true });
  } else if (action === "reject") {
    pendingMessages.delete(msgId);
    await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
  }
});

// User left chat cleanup
bot.on("chat_member", async ctx => {
  const status = ctx.chatMember.new_chat_member.status;
  const userId = ctx.chatMember.new_chat_member.user.id;
  if (status === "left" || status === "kicked") {
    userMap.delete(userId);
    userHistory.delete(userId);
    console.log(`Removed anonymous ID for user ${userId}`);
  }
});

// Express + webhook
const app = express();
const port = process.env.PORT || 3000;
const webhookPath = `/bot${process.env.BOT_TOKEN}`;
app.use(express.json());
app.post(webhookPath, webhookCallback(bot, "express"));
app.get("/", (req, res) => res.send("Bot is running"));

app.listen(port, async () => {
  console.log(`Server listening on port ${port}`);
  if (!process.env.RENDER_EXTERNAL_URL) return;
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}${webhookPath}`;
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.api.setWebhook(webhookUrl);
    console.log(`Webhook set to ${webhookUrl}`);
  } catch (err) {
    console.log("Failed to set webhook:", err.message);
  }
});
