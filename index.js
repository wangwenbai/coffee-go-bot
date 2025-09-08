import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";

dotenv.config();

// ---------------------
// 多机器人初始化
// ---------------------
if (!process.env.BOT_TOKENS) throw new Error("Missing BOT_TOKENS environment variable");
const tokens = process.env.BOT_TOKENS.split(",").map(t => t.trim()).filter(Boolean);
if (tokens.length === 0) throw new Error("No valid BOT_TOKENS found");

const bots = tokens.map(t => new Bot(t));
for (const bot of bots) await bot.init();

const chatId = process.env.GROUP_ID;
const prefix = process.env.NICK_PREFIX || "User";

// ---------------------
// 全局数据
// ---------------------
const userMap = new Map();          // telegramId => 匿名编号
const usedNicknames = new Set();    // 已分配的匿名码
const userHistory = new Map();      // 匿名编号 => 历史消息
const messageMap = new Map();       // 原始消息ID => 转发消息ID
const pendingMessages = new Map();  // key: `${origMsgId}:${adminId}` => { ctx, userId, notifMsgId, chatId }
const adCountMap = new Map();       // userId => 广告次数
const notifiedUsers = new Set();    // 已通知过的用户

// ---------------------
// 屏蔽词逻辑
// ---------------------
let blockedKeywords = [];
function loadBlockedKeywords() {
  try {
    const data = fs.readFileSync('./blocked.txt', 'utf8');
    blockedKeywords = data.split(/\r?\n/).map(w => w.trim()).filter(Boolean);
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

async function notifyAdminsOfSpammer(bot, user) {
  try {
    const admins = await bot.api.getChatAdministrators(chatId);
    const adminUsers = admins.filter(a => !a.user.is_bot);
    const userIdentity = formatUserIdentity(user);
    for (const admin of adminUsers) {
      await bot.api.sendMessage(
        admin.user.id,
        `🚨 User ${userIdentity} suspected of spamming, exceeded 3 times!`
      );
    }
  } catch (err) {
    console.log("Failed to notify admins of spammer:", err.message);
  }
}

// ---------------------
// 消息转发函数
// ---------------------
async function forwardMessage(bot, ctx, userId, targetChatId = chatId, replyTargetId = null) {
  const msg = ctx.message;
  let sent;
  try {
    const caption = msg.caption ? `【${userId}】 ${msg.caption}` : msg.text ? `【${userId}】: ${msg.text}` : `【${userId}】`;

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
// 群消息处理
// ---------------------
for (const bot of bots) {
  bot.on("message", async ctx => {
    const msg = ctx.message;
    if (ctx.chat.type === "private" || ctx.from.is_bot) return;

    const member = await bot.api.getChatMember(chatId, ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    const userId = getUserId(ctx.from.id);

    if (isAdmin) return; // 管理员消息不匿名

    // 删除普通用户消息
    try { await ctx.deleteMessage(); } catch {}

    const textToCheck = msg.text || msg.caption;
    if (containsBlockedKeyword(textToCheck)) return;

    if (containsLinkOrMention(textToCheck)) {
      const currentCount = (adCountMap.get(ctx.from.id) || 0) + 1;
      adCountMap.set(ctx.from.id, currentCount);
      if (currentCount > 3 && !notifiedUsers.has(ctx.from.id)) {
        notifiedUsers.add(ctx.from.id);
        await notifyAdminsOfSpammer(bot, ctx.from);
      }

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

    // 匿名转发到主群
    await forwardMessage(bot, ctx, userId);

    // 如果是频道消息同步到讨论群
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      await forwardMessage(bot, ctx, userId, msg.chat.id);
    }
  });
}

// ---------------------
// 回调查询（审核按钮）
// ---------------------
for (const bot of bots) {
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
        await forwardMessage(bot, pendingMessages.get(pendingKeys[0]).ctx, pendingMessages.get(pendingKeys[0]).userId);
        await ctx.answerCallbackQuery({ text: "Message approved and forwarded", show_alert: true });
      } else if (action === "reject") {
        await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
      }

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
}

// ---------------------
// 用户退群清理
// ---------------------
for (const bot of bots) {
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
}

// ---------------------
// Express Webhook
// ---------------------
const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// 为每个机器人注册 webhook 路径
for (const bot of bots) {
  const webhookPath = `/bot${bot.token}`;
  app.post(webhookPath, (req, res) => { bot.handleUpdate(req.body).catch(console.error); res.sendStatus(200); });
}

app.get("/", (req, res) => res.send("Bot running"));

// 只监听一次端口，轮询设置所有机器人 webhook
app.listen(port, async () => {
  console.log(`Listening on port ${port}`);
  if (!process.env.RENDER_EXTERNAL_URL) return;
  for (const bot of bots) {
    const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/bot${bot.token}`;
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
      await bot.api.setWebhook(webhookUrl);
      console.log(`Webhook set to ${webhookUrl}`);
    } catch (err) {
      console.log("Webhook setup failed:", err.message);
    }
  }
});
