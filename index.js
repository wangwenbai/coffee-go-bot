import { Bot, webhookCallback, InlineKeyboard } from "grammy";
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
const messageMap = new Map();
const pendingMessages = new Map();

// 屏蔽关键词
let blockedKeywords = [];

// 加载 blocked.txt
function loadBlockedKeywords() {
  try {
    const data = fs.readFileSync('./blocked.txt', 'utf8');
    blockedKeywords = data.split(',').map(word => word.trim()).filter(Boolean);
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

// 生成 5 位随机编号
function generateRandomId() {
  return Math.floor(10000 + Math.random() * 90000);
}
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

// 判断是否管理员消息
async function isAdminMessage(userId) {
  try {
    const member = await bot.api.getChatMember(chatId, userId);
    return member.status === "administrator" || member.status === "creator";
  } catch (err) {
    console.log("Check admin failed:", err.message);
    return false;
  }
}

// 检测是否包含链接或 @ 用户
function containsLinkOrMention(text) {
  if (!text) return false;
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
  const mentionRegex = /@[a-zA-Z0-9_]+/;
  return urlRegex.test(text) || mentionRegex.test(text);
}

// 转发消息函数
async function forwardMessage(ctx, userId, replyTargetId = null) {
  const msg = ctx.message;
  let sent;
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
}

// 群消息处理
bot.on("message", async ctx => {
  const msg = ctx.message;
  if (ctx.chat.type === "private" || ctx.from.is_bot) return;

  // 管理员消息直接显示
  if (await isAdminMessage(ctx.from.id)) return;

  const userId = getUserId(ctx.from.id);
  let replyTargetId = null;
  if (msg.reply_to_message) {
    const repliedMsgId = msg.reply_to_message.message_id;
    replyTargetId = messageMap.get(repliedMsgId) || null;
  }

  try { await ctx.deleteMessage(); } catch {}

  if (msg.text && containsBlockedKeyword(msg.text)) {
    saveUserMessage(userId, "[Blocked message]");
    return;
  }

  // 链接/@ 用户消息 → 待管理员审核（群内@所有管理员）
  if (msg.text && containsLinkOrMention(msg.text)) {
    const admins = await bot.api.getChatAdministrators(chatId);
    const adminMentions = admins
      .filter(a => !a.user.is_bot)
      .map(a => `@${a.user.username || a.user.first_name}`)
      .join(' ');

    const keyboard = new InlineKeyboard()
      .text("✅ Approve", `approve:${msg.message_id}:${ctx.from.id}`)
      .text("❌ Reject", `reject:${msg.message_id}:${ctx.from.id}`);

    await ctx.api.sendMessage(chatId,
      `User ${ctx.from.first_name} (${userId}) sent a link or @ mention. Admins, please review:\n${msg.text}\n${adminMentions}`,
      { reply_markup: keyboard }
    );
    pendingMessages.set(msg.message_id, { ctx, userId, replyTargetId });
    return; // 审核前不转发
  }

  // 普通消息直接匿名转发
  forwardMessage(ctx, userId, replyTargetId);
});

// 回调按钮处理（仅管理员可操作，点击后删除审核通知）
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
    // 删除审核通知
    await ctx.api.deleteMessage(ctx.callbackQuery.message.message_id);
  } catch (err) {
    console.log("Failed to delete review message:", err.message);
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

// 用户退群清理
bot.on("chat_member", async ctx => {
  const status = ctx.chatMember.new_chat_member.status;
  const userId = ctx.chatMember.new_chat_member.user.id;
  if (status === "left" || status === "kicked") {
    userMap.delete(userId);
    userHistory.delete(userId);
    console.log(`Removed anonymous ID for user ${userId}`);
  }
});

// Express 绑定端口和 Webhook
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
