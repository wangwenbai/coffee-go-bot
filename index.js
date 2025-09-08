import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";

dotenv.config();

// ---------------------
// 配置
// ---------------------
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim()).filter(Boolean);
const GROUP_ID = parseInt(process.env.GROUP_ID, 10);
const NICK_PREFIX = process.env.NICK_PREFIX || "User";
const ADMIN_FILE = "./admins.json";
const BLOCKED_FILE = "./blocked.txt";

// ---------------------
// 全局存储
// ---------------------
const userMap = new Map();          // telegramId => 匿名编号
const userHistory = new Map();      // 匿名编号 => 历史消息
const messageMap = new Map();       // 原始消息ID => 转发消息ID
const pendingMessages = new Map();  // `${origMsgId}:${adminId}` => { ctx, userId, notifMsgId, chatId }
const usedNicknames = new Set();    
const adCountMap = new Map();       
const violationCount = new Map();   // 链接或@违规次数

let dynamicAdmins = new Set();

// ---------------------
// 屏蔽词加载
// ---------------------
let blockedKeywords = [];
function loadBlockedKeywords() {
  try {
    const data = fs.readFileSync(BLOCKED_FILE, "utf8");
    blockedKeywords = data.split("\n").map(w => w.trim()).filter(Boolean);
    console.log(`Blocked keywords loaded: ${blockedKeywords.length}`);
  } catch (err) {
    console.log("Failed to load blocked keywords:", err.message);
  }
}
loadBlockedKeywords();
fs.watchFile(BLOCKED_FILE, () => loadBlockedKeywords());

// ---------------------
// 动态管理员加载/保存
// ---------------------
function loadAdmins() {
  if (fs.existsSync(ADMIN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
      dynamicAdmins = new Set(data);
      console.log("Admins loaded:", [...dynamicAdmins]);
    } catch {}
  }
}
function saveAdmins() {
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify([...dynamicAdmins], null, 2));
  } catch (err) { console.error("Failed to save admins:", err); }
}
loadAdmins();

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

async function notifyAdminsOfSpammer(userId, reason) {
  for (const adminId of dynamicAdmins) {
    try {
      await bots[0].api.sendMessage(adminId, `⚠️ 用户 ${userId} 已违规超过3次: ${reason}`);
    } catch (err) {
      if (err.error_code === 403) {
        console.warn(`管理员 ${adminId} 未和机器人私聊，跳过通知`);
      } else {
        console.error("Notify admin failed:", err);
      }
    }
  }
}

// ---------------------
// 消息转发
// ---------------------
let botIndex = 0;
function getNextBot() {
  const bot = bots[botIndex];
  botIndex = (botIndex + 1) % bots.length;
  return bot;
}

async function forwardMessage(ctx, userId, targetChatId = GROUP_ID, replyTargetId = null) {
  const msg = ctx.message;
  let sent;
  const bot = getNextBot();
  try {
    const caption = msg.caption ? `【${userId}】 ${msg.caption}` : msg.text ? `【${userId}】 ${msg.text}` : `【${userId}】`;

    if (msg.photo) sent = await bot.api.sendPhoto(targetChatId, msg.photo[msg.photo.length-1].file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.video) sent = await bot.api.sendVideo(targetChatId, msg.video.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.document) sent = await bot.api.sendDocument(targetChatId, msg.document.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else sent = await bot.api.sendMessage(targetChatId, caption, { reply_to_message_id: replyTargetId || undefined });

    if (sent) messageMap.set(msg.message_id, sent.message_id);
    saveUserMessage(userId, msg.text || msg.caption || "[Non-text]");
  } catch (err) { console.error("Forward message error:", err.message); }
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
    const msg = ctx.message;
    if (ctx.chat.type === "private" || ctx.from.is_bot) return;

    const userId = getUserId(ctx.from.id);

    // 删除普通用户消息
    try { await ctx.deleteMessage(); } catch {}

    // 屏蔽词
    const textToCheck = msg.text || msg.caption;
    if (containsBlockedKeyword(textToCheck)) return;

    // 链接或@ → 违规计数 + 通知管理员
    if (containsLinkOrMention(textToCheck)) {
      const count = (violationCount.get(ctx.from.id) || 0) + 1;
      violationCount.set(ctx.from.id, count);
      if (count > 3) await notifyAdminsOfSpammer(userId, "发送链接或@超过3次");

      // 发送给管理员审核
      for (const adminId of dynamicAdmins) {
        try {
          const keyboard = new InlineKeyboard()
            .text("✅ Approve", `approve:${msg.message_id}:${ctx.from.id}`)
            .text("❌ Reject", `reject:${msg.message_id}:${ctx.from.id}`);
          const sentMsg = await bot.api.sendMessage(adminId,
            `用户 ${userId} 发送了链接或@，请审核:\n${textToCheck || "[Non-text]"}`,
            { reply_markup: keyboard });
          pendingMessages.set(`${msg.message_id}:${adminId}`, { ctx, userId, notifMsgId: sentMsg.message_id, chatId: adminId });
        } catch {}
      }
      return;
    }

    // 匿名转发
    await forwardMessage(ctx, userId);
  });

  // 回调查询（管理员审核）
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data.split(":");
    const action = data[0];
    const origMsgId = parseInt(data[1]);
    const origUserId = parseInt(data[2]);

    const pendingKeys = Array.from(pendingMessages.keys()).filter(k => k.startsWith(`${origMsgId}:`));
    if (!pendingKeys.length) return ctx.answerCallbackQuery({ text: "已处理", show_alert: true });

    try {
      if (action === "approve") {
        await forwardMessage(pendingMessages.get(pendingKeys[0]).ctx, pendingMessages.get(pendingKeys[0]).userId);
        await ctx.answerCallbackQuery({ text: "已通过", show_alert: true });
      } else if (action === "reject") {
        await ctx.answerCallbackQuery({ text: "已拒绝", show_alert: true });
      }

      // 更新按钮状态
      await Promise.all(pendingKeys.map(async key => {
        const p = pendingMessages.get(key);
        try { await bot.api.editMessageReplyMarkup(p.chatId, p.notifMsgId, { reply_markup: new InlineKeyboard().text("✅ Processed", "processed") }); } catch {}
        pendingMessages.delete(key);
      }));
    } catch {}
  });

  // 管理员私聊注册
  bot.command("start", async ctx => {
    if (ctx.chat.type === "private") {
      dynamicAdmins.add(ctx.from.id);
      saveAdmins();
      await ctx.reply("✅ 你已注册为管理员，将收到违规提醒。");
    }
  });

  // 用户退群清理
  bot.on("chat_member", async ctx => {
    const status = ctx.chatMember.new_chat_member.status;
    const userId = ctx.chatMember.new_chat_member.user.id;
    if (status === "left" || status === "kicked") {
      const nickname = userMap.get(userId);
      if (nickname) usedNicknames.delete(nickname);
      userMap.delete(userId);
      userHistory.delete(userId);
      adCountMap.delete(userId);
      violationCount.delete(userId);
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
    } catch (err) { console.log(`Webhook setup failed for bot ${bot.token}:`, err.message); }
  }));
});
