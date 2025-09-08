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
const processedMessages = new Set(); // messageId 已处理
const messageMap = new Map();       // 原始消息ID => 转发消息ID
const pendingMessages = new Map();  // `${origMsgId}:${adminId}` => { ctx, userId, notifMsgId, chatId }
const usedNicknames = new Set();    
const notifiedUsers = new Set();    
const adminsSet = new Set();       // 私聊过机器人的管理员
let lastBotIndex = -1;             // 多机器人轮询索引

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
// 通知管理员
// ---------------------
async function notifyAdmins(user, text, bots) {
  const userIdentity = formatUserIdentity(user);
  for (const adminId of adminsSet) {
    for (const bot of bots) {
      try {
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `approve:${user.id}:${Date.now()}`)
          .text("❌ Reject", `reject:${user.id}:${Date.now()}`);
        await bot.api.sendMessage(adminId, `🚨 User ${userIdentity} sent a message:\n${text}`, { reply_markup: keyboard });
      } catch (err) {
        // 私聊失败不阻塞
        // console.log(`Failed to notify admin ${adminId}: ${err.message}`);
      }
    }
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
    try {
      const msg = ctx.message;
      if (ctx.from.is_bot || ctx.chat.type === "private") return;

      // 轮询选择机器人
      lastBotIndex = (lastBotIndex + 1) % bots.length;
      const handlerBot = bots[lastBotIndex];

      const member = await handlerBot.api.getChatMember(chatId, ctx.from.id);
      const isAdmin = member.status === "administrator" || member.status === "creator";
      const userId = getUserId(ctx.from.id);

      // 管理员消息不处理匿名
      if (!isAdmin) {
        try { await ctx.deleteMessage(); } catch {}
      }

      const textToCheck = msg.text || msg.caption;

      // 屏蔽词
      if (containsBlockedKeyword(textToCheck)) return;

      // 链接或 @
      if (containsLinkOrMention(textToCheck)) {
        if (!notifiedUsers.has(ctx.from.id)) {
          notifiedUsers.add(ctx.from.id);
          await notifyAdmins(ctx.from, textToCheck || "[Non-text]", bots);
        }
        return;
      }

      // 匿名转发
      if (!isAdmin) {
        await forwardMessage(handlerBot, ctx, userId);
      }

      // 如果是频道消息，转发到讨论群
      if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
        await forwardMessage(handlerBot, ctx, userId, msg.chat.id);
      }

    } catch (err) { console.log("Message handling error:", err.message); }
  });
});

// ---------------------
// 回调查询（审核按钮）
// ---------------------
bots.forEach(bot => {
  bot.on("callback_query:data", async ctx => {
    try {
      const data = ctx.callbackQuery.data.split(":");
      const action = data[0];
      const origUserId = parseInt(data[1]);
      const pendingKeys = Array.from(pendingMessages.keys()).filter(k => k.startsWith(`${origUserId}:`));
      if (!pendingKeys.length) return ctx.answerCallbackQuery({ text: "Processed", show_alert: true });

      if (action === "approve") {
        for (const key of pendingKeys) {
          const pending = pendingMessages.get(key);
          await forwardMessage(bots[0], pending.ctx, pending.userId); // 用任意机器人转发
        }
        ctx.answerCallbackQuery({ text: "Message approved", show_alert: true });
      } else if (action === "reject") {
        ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
      }

      // 更新按钮为已处理
      for (const key of pendingKeys) {
        const pending = pendingMessages.get(key);
        try {
          await bots[0].api.editMessageReplyMarkup(pending.chatId, pending.notifMsgId,
            { reply_markup: new InlineKeyboard().text("✅ Processed", "processed") });
        } catch {}
        pendingMessages.delete(key);
      }
    } catch (err) { console.log("Callback handling error:", err.message); }
  });
});

// ---------------------
// 用户退群清理
// ---------------------
bots.forEach(bot => {
  bot.on("chat_member", ctx => {
    const status = ctx.chatMember.new_chat_member.status;
    const userId = ctx.chatMember.new_chat_member.user.id;
    if (status === "left" || status === "kicked") {
      const nickname = userMap.get(userId);
      if (nickname) usedNicknames.delete(nickname);
      userMap.delete(userId);
      userHistory.delete(userId);
      notifiedUsers.delete(userId);
    }
  });
});

// ---------------------
// 管理员私聊注册
// ---------------------
bots.forEach(bot => {
  bot.on("message", ctx => {
    if (ctx.chat.type === "private" && !ctx.from.is_bot) {
      adminsSet.add(ctx.from.id);
    }
  });
});

// ---------------------
// Express Webhook
// ---------------------
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
