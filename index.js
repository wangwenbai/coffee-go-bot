import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";

dotenv.config();

// ---------------------
// 环境变量
// ---------------------
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim()).filter(Boolean);
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
const adCountMap = new Map();
const notifiedUsers = new Set();
const processingMessageIds = new Set(); // 避免多机器人重复处理
let roundRobinIndex = 0;

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
// 获取所有已私聊的管理员
// ---------------------
async function getAdminIds(bot) {
  try {
    const admins = await bot.api.getChatAdministrators(chatId);
    return admins.filter(a => !a.user.is_bot).map(a => a.user.id);
  } catch (err) {
    console.log("Failed to get chat administrators:", err.message);
    return [];
  }
}

// ---------------------
// 消息转发
// ---------------------
async function forwardMessage(bot, ctx, userId, targetChatId = chatId, replyTargetId = null) {
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
// 创建机器人实例
// ---------------------
const bots = BOT_TOKENS.map(token => new Bot(token));
await Promise.all(bots.map(b => b.init()));

// ---------------------
// 群消息处理（单机器人轮询处理）
const roundRobinLock = { index: 0 }; // 轮询锁
bots.forEach(bot => {
  bot.on("message", async ctx => {
    const msg = ctx.message;
    if (ctx.chat.type === "private" || ctx.from.is_bot) return;
    const userId = getUserId(ctx.from.id);

    const member = await bot.api.getChatMember(chatId, ctx.from.id);
    if (member.status === "administrator" || member.status === "creator") return;

    // 避免多机器人重复处理
    if (processingMessageIds.has(msg.message_id)) return;
    processingMessageIds.add(msg.message_id);

    try {
      const textToCheck = msg.text || msg.caption;

      // 链接或 @ → 违规审批
      if (containsLinkOrMention(textToCheck)) {
        const admins = await getAdminIds(bot);
        for (const adminId of admins) {
          const keyboard = new InlineKeyboard()
            .text("✅ Approve", `approve:${msg.message_id}:${ctx.from.id}`)
            .text("❌ Reject", `reject:${msg.message_id}:${ctx.from.id}`);
          const sentMsg = await bot.api.sendMessage(adminId,
            `User ${ctx.from.first_name} (${userId}) sent a message containing a link or mention.\nContent: ${textToCheck || "[Non-text]"}\nApprove or reject.`,
            { reply_markup: keyboard }
          );
          pendingMessages.set(`${msg.message_id}:${adminId}`, { ctx, userId, notifMsgId: sentMsg.message_id, chatId: adminId });
        }
        try { await ctx.deleteMessage(); } catch {}
        return;
      }

      // 普通消息删除并轮询转发
      try { await ctx.deleteMessage(); } catch {}
      const robot = bots[roundRobinLock.index % bots.length];
      roundRobinLock.index++;
      await forwardMessage(robot, ctx, userId);

    } finally {
      processingMessageIds.delete(msg.message_id);
    }
  });
});

// ---------------------
// 回调查询（审批按钮）
bots.forEach(bot => {
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

    const pendingKeys = Array.from(pendingMessages.keys())
      .filter(key => key.startsWith(`${origMsgId}:`));

    if (!pendingKeys.length) return ctx.answerCallbackQuery({ text: "This message has been processed", show_alert: true });

    try {
      if (action === "approve") {
        const pending = pendingMessages.get(pendingKeys[0]);
        await forwardMessage(bot, pending.ctx, pending.userId);
        await ctx.answerCallbackQuery({ text: "Message approved and forwarded", show_alert: true });
      } else if (action === "reject") {
        await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
      }

      // 编辑所有通知消息并删除 pending
      await Promise.all(pendingKeys.map(async key => {
        const pending = pendingMessages.get(key);
        try {
          await bot.api.editMessageReplyMarkup(pending.chatId, pending.notifMsgId,
            { reply_markup: new InlineKeyboard().text("✅ Processed", "processed") }
          );
        } catch {}
        pendingMessages.delete(key);
      }));

    } catch (err) { console.log("Error handling callback:", err.message); }
  });
});

// ---------------------
// 用户退群清理
bots.forEach(bot => {
  bot.on("chat_member", async ctx => {
    const status = ctx.chatMember.new_chat_member.status;
    const userId = ctx.chatMember.new_chat_member.user.id;
    if (status === "left" || status === "kicked") {
      const nickname = userMap.get(userId);
      if (nickname) usedNicknames.delete(nickname);
      userMap.delete(userId);
      userHistory.delete(userId);
      adCountMap.delete(userId);
      notifiedUsers.delete(userId);
      console.log(`Removed anonymous ID for user ${userId}`);
    }
  });
});

// ---------------------
// Express Webhook
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
