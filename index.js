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

// ---------------------
// 全局存储 (JS 里不能写类型声明)
// ---------------------
const userMap = new Map();
const userHistory = new Map();
const messageMap = new Map();
const pendingMessages = new Map();
const usedNicknames = new Set();

// ---------------------
// 屏蔽词
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
    nickname = `${NICK_PREFIX}${letters}${numbers}`;
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
// 安全发送消息
// ---------------------
async function safeSendMessage(bot, chatId, text, options) {
  try { await bot.api.sendMessage(chatId, text, options); } catch (err) {
    if (err.response && err.response.error_code === 403) return; // 管理员未私聊
    console.log("sendMessage failed:", err.message);
  }
}

// ---------------------
// 转发消息
// ---------------------
async function forwardMessage(ctx, userId, targetChatId = GROUP_ID, replyTargetId = null) {
  const msg = ctx.message;
  let sent;
  try {
    const caption = msg.caption ? `【${userId}】 ${msg.caption}` : msg.text ? `【${userId}】 ${msg.text}` : `【${userId}】`;
    if (msg.photo) sent = await ctx.api.sendPhoto(targetChatId, msg.photo[msg.photo.length - 1].file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.video) sent = await ctx.api.sendVideo(targetChatId, msg.video.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.document) sent = await ctx.api.sendDocument(targetChatId, msg.document.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else sent = await ctx.api.sendMessage(targetChatId, caption, { reply_to_message_id: replyTargetId || undefined });

    if (sent) messageMap.set(msg.message_id, sent.message_id);
    saveUserMessage(userId, msg.text || msg.caption || "[Non-text]");
  } catch (err) {
    console.log("Forward message error:", err.message);
  }
}

// ---------------------
// 获取所有管理员
// ---------------------
async function getAdmins(bot) {
  try {
    const admins = await bot.api.getChatAdministrators(GROUP_ID);
    return admins.filter(a => !a.user.is_bot).map(a => a.user.id);
  } catch (err) {
    console.log("getAdmins failed:", err.message);
    return [];
  }
}

// ---------------------
// 创建机器人实例
// ---------------------
const bots = BOT_TOKENS.map(token => new Bot(token));
await Promise.all(bots.map(b => b.init()));

let robotIndex = 0;

// ---------------------
// 群消息处理
// ---------------------
bots.forEach(bot => {
  bot.on("message", async ctx => {
    const msg = ctx.message;
    if (ctx.chat.type === "private" || ctx.from.is_bot) return;

    const member = await bot.api.getChatMember(GROUP_ID, ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    const userId = getUserId(ctx.from.id);

    if (isAdmin) return;

    try { await ctx.deleteMessage(); } catch {}

    const textToCheck = msg.text || msg.caption;
    const isBlocked = containsBlockedKeyword(textToCheck) || containsLinkOrMention(textToCheck);

    if (isBlocked) {
      const admins = await getAdmins(bot);
      const keyboard = new InlineKeyboard()
        .text("✅ Approve", `approve:${msg.message_id}:${ctx.from.id}`)
        .text("❌ Reject", `reject:${msg.message_id}:${ctx.from.id}`);
      for (const adminId of admins) {
        await safeSendMessage(bot, adminId, `User ${formatUserIdentity(ctx.from)} (#${userId}) sent a blocked message.\nContent: ${textToCheck || "[Non-text]"}\nApprove or reject.`, { reply_markup: keyboard });
        pendingMessages.set(`${msg.message_id}:${adminId}`, { ctx, userId, notifMsgId: null, chatId: adminId, msgData: msg });
      }
      return;
    }

    const botToUse = bots[robotIndex % bots.length];
    robotIndex++;
    await forwardMessage(ctx, userId);
  });
});

// ---------------------
// 审批按钮
// ---------------------
bots.forEach(bot => {
  bot.on("callback_query:data", async ctx => {
    const userIdClicker = ctx.from.id;
    const member = await bot.api.getChatMember(GROUP_ID, userIdClicker);
    if (!(member.status === "administrator" || member.status === "creator")) {
      return ctx.answerCallbackQuery({ text: "Only admins can approve/reject", show_alert: true });
    }

    const data = ctx.callbackQuery.data.split(":");
    const action = data[0];
    const origMsgId = parseInt(data[1]);
    const origUserId = parseInt(data[2]);

    const pendingKeys = Array.from(pendingMessages.keys()).filter(key => key.startsWith(`${origMsgId}:`));
    if (!pendingKeys.length) return ctx.answerCallbackQuery({ text: "This message has been processed", show_alert: true });

    const firstPending = pendingMessages.get(pendingKeys[0]);
    const { ctx: originalCtx, userId } = firstPending;

    try {
      if (action === "approve") {
        const botToUse = bots[robotIndex % bots.length];
        robotIndex++;
        await forwardMessage(originalCtx, userId);
        await ctx.answerCallbackQuery({ text: "Message approved and forwarded", show_alert: true });
      } else if (action === "reject") {
        await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
      }

      await Promise.all(pendingKeys.map(async key => {
        const pending = pendingMessages.get(key);
        try {
          await bot.api.editMessageReplyMarkup(pending.chatId, pending.notifMsgId || undefined,
            { reply_markup: new InlineKeyboard().text("✅ Processed", "processed") }
          );
        } catch {}
        pendingMessages.delete(key);
      }));
    } catch (err) { console.log("Error handling callback:", err.message); }
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
