import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";

dotenv.config();

// ---------------------
// 环境变量
// ---------------------
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim()).filter(Boolean); // 多机器人
const GROUP_ID = process.env.GROUP_ID;
const NICK_PREFIX = process.env.NICK_PREFIX || "User";

// ---------------------
// 全局存储
// ---------------------
const userMap = new Map();          // telegramId => 匿名编号
const userHistory = new Map();      // 匿名编号 => 历史消息
const messageMap = new Map();       // 原始消息ID => 转发消息ID
const pendingMessages = new Map();  // `${origMsgId}:${adminId}` => { ctx, userId, notifMsgId, chatId }
const usedNicknames = new Set();    
const adminSet = new Set();         // 已私聊机器人管理员集合
let robotIndex = 0;                 // 多机器人轮询索引

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

async function notifyAdminsOfViolation(bot, user, ctx, text) {
  try {
    const msgKey = ctx.message.message_id;
    for (const adminId of adminSet) {
      const keyboard = new InlineKeyboard()
        .text("✅ 同意转发", `approve:${msgKey}:${user.id}`)
        .text("❌ 拒绝", `reject:${msgKey}:${user.id}`);
      const sentMsg = await bot.api.sendMessage(adminId,
        `用户 ${formatUserIdentity(user)} 发送了违规消息:\n${text}\n请审核是否转发`,
        { reply_markup: keyboard }
      );
      pendingMessages.set(`${msgKey}:${adminId}`, { ctx, userId: getUserId(user.id), notifMsgId: sentMsg.message_id, chatId: adminId });
    }
  } catch (err) {
    console.log("Failed to notify admins:", err.message);
  }
}

// ---------------------
// 消息转发
// ---------------------
async function forwardMessage(ctx, userId, targetBot) {
  const msg = ctx.message;
  try {
    const caption = msg.caption ? `【${userId}】 ${msg.caption}` : msg.text ? `【${userId}】 ${msg.text}` : `【${userId}】`;
    let sent;
    if (msg.photo) sent = await targetBot.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, { caption });
    else if (msg.video) sent = await targetBot.api.sendVideo(GROUP_ID, msg.video.file_id, { caption });
    else if (msg.document) sent = await targetBot.api.sendDocument(GROUP_ID, msg.document.file_id, { caption });
    else sent = await targetBot.api.sendMessage(GROUP_ID, caption);
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
bots.forEach(() => {
  const bot = bots[robotIndex % bots.length]; // 使用轮询逻辑
  bot.on("message", async ctx => {
    const msg = ctx.message;
    if (ctx.chat.type === "private" || ctx.from.is_bot) return;

    const member = await bot.api.getChatMember(GROUP_ID, ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    const userId = getUserId(ctx.from.id);

    if (isAdmin) return; // 管理员消息不删除

    // 删除普通用户消息
    try { await ctx.deleteMessage(); } catch {}

    const textToCheck = msg.text || msg.caption;

    // 违规消息（屏蔽词、链接、@）
    if (containsBlockedKeyword(textToCheck) || containsLinkOrMention(textToCheck)) {
      await notifyAdminsOfViolation(bot, ctx.from, ctx, textToCheck);
      return; // 不立即转发
    }

    // 普通消息 → 单机器人轮询转发
    const targetBot = bots[robotIndex % bots.length];
    robotIndex++;
    await forwardMessage(ctx, userId, targetBot);
  });
});

// ---------------------
// 回调查询（管理员按钮审批）
bots.forEach(bot => {
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data.split(":");
    const action = data[0];
    const origMsgId = parseInt(data[1]);
    const origUserId = parseInt(data[2]);

    const pendingKeys = Array.from(pendingMessages.keys()).filter(key => key.startsWith(`${origMsgId}:`));
    if (!pendingKeys.length) return ctx.answerCallbackQuery({ text: "消息已处理", show_alert: true });

    const pending = pendingMessages.get(pendingKeys[0]);
    const targetBot = bots[robotIndex % bots.length];
    robotIndex++;

    try {
      if (action === "approve") {
        await forwardMessage(pending.ctx, pending.userId, targetBot);
        await ctx.answerCallbackQuery({ text: "消息已转发", show_alert: true });
      } else if (action === "reject") {
        await ctx.answerCallbackQuery({ text: "消息已拒绝", show_alert: true });
      }

      // 更新所有管理员按钮为已处理
      await Promise.all(pendingKeys.map(async key => {
        const p = pendingMessages.get(key);
        try {
          await bot.api.editMessageReplyMarkup(p.chatId, p.notifMsgId,
            { reply_markup: new InlineKeyboard().text("已处理", "processed") }
          );
        } catch {}
        pendingMessages.delete(key);
      }));

    } catch (err) {
      console.log("Error handling callback:", err.message);
    }
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
    }
  });

  // 记录管理员私聊机器人
  bot.on("message:text", async ctx => {
    if (ctx.chat.type === "private") adminSet.add(ctx.from.id);
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
