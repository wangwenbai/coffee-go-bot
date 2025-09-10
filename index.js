import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";

// =====================
// 环境变量
// =====================
const BOT_TOKENS = (process.env.BOT_TOKENS || "")
  .split(",")
  .map(t => t.trim())
  .filter(Boolean); // ✅ 过滤空 token
const GROUP_ID = Number(process.env.GROUP_ID);
const NICK_PREFIX = process.env.NICK_PREFIX || "#";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = (process.env.RENDER_EXTERNAL_URL || "") + "/webhook";

if (!BOT_TOKENS.length || !GROUP_ID || !process.env.RENDER_EXTERNAL_URL) {
  console.error("❌ 缺少必要环境变量：BOT_TOKENS / GROUP_ID / RENDER_EXTERNAL_URL");
  process.exit(1);
}

// =====================
// 屏蔽词
// =====================
let blockedWordsRegex = null;
function loadBlockedWords() {
  if (fs.existsSync("./blocked.txt")) {
    const words = fs.readFileSync("./blocked.txt", "utf-8")
      .split(/\r?\n/)
      .map(w => w.trim())
      .filter(Boolean);
    blockedWordsRegex = new RegExp(words.join("|"), "i");
    console.log("✅ 屏蔽词已加载:", words.length, "条");
  }
}
loadBlockedWords();

// =====================
// 匿名昵称生成
// =====================
const nickMap = new Map();
const usedCodes = new Set();
const NICK_MAX_COUNT = 10000;

function generateNick(userId) {
  if (nickMap.has(userId)) {
    nickMap.get(userId).lastUsed = Date.now();
    return nickMap.get(userId).nick;
  }
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  while (true) {
    let code = Array.from({ length: 4 }, () =>
      letters.charAt(Math.floor(Math.random() * letters.length))
    ).join("");
    if (!usedCodes.has(code)) {
      usedCodes.add(code);
      const nick = `【${NICK_PREFIX}${code}】`;
      nickMap.set(userId, { nick, lastUsed: Date.now(), user: {} });
      return nick;
    }
  }
}

function releaseNick(userId) {
  if (nickMap.has(userId)) {
    const { nick } = nickMap.get(userId);
    const code = nick.slice(NICK_PREFIX.length + 1, -1);
    usedCodes.delete(code);
    nickMap.delete(userId);
  }
}

// 定时清理 nickMap
setInterval(() => {
  const now = Date.now();
  const entries = [...nickMap.entries()];
  for (const [userId, { lastUsed }] of entries) {
    if (now - lastUsed > 10 * 24 * 60 * 60 * 1000) releaseNick(userId);
  }
  if (nickMap.size > NICK_MAX_COUNT) {
    const sorted = [...nickMap.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < nickMap.size - NICK_MAX_COUNT; i++) releaseNick(sorted[i][0]);
  }
}, 24 * 60 * 60 * 1000);

// =====================
// 初始化机器人
// =====================
const bots = BOT_TOKENS.map(token => new Bot(token));
let botIndex = 0;
function getNextBot() {
  const bot = bots[botIndex];
  botIndex = (botIndex + 1) % bots.length;
  return bot;
}

// =====================
// 管理员缓存
// =====================
const adminIds = new Set();
async function loadGroupAdmins(bot) {
  try {
    const admins = await bot.api.getChatAdministrators(GROUP_ID);
    // 删除已经不在群里的管理员
    const currentIds = new Set(admins.map(a => a.user.id));
    for (const id of adminIds) {
      if (!currentIds.has(id)) adminIds.delete(id);
    }
    // 加入最新管理员
    for (const id of currentIds) adminIds.add(id);
    console.log("✅ 管理员列表更新:", [...adminIds]);
  } catch (e) {
    console.error("❌ 获取管理员失败:", e.message);
  }
}
// 每天更新一次管理员列表
setInterval(() => {
  bots.forEach(bot => loadGroupAdmins(bot));
}, 24 * 60 * 60 * 1000);

// =====================
// 违规消息处理
// =====================
const pendingReviews = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [reviewId, review] of pendingReviews) {
    if (now - review.reviewTime > 24 * 60 * 60 * 1000) pendingReviews.delete(reviewId);
  }
}, 60 * 60 * 1000);

// =====================
// 已处理消息
// =====================
const processedMessages = new Set();
const processedQueue = [];
function markProcessed(msgKey) {
  processedMessages.add(msgKey);
  processedQueue.push(msgKey);
  if (processedQueue.length > 1000) {
    const oldKey = processedQueue.shift();
    processedMessages.delete(oldKey);
  }
}

// =====================
// 消息处理函数
// =====================
async function handleMessage(ctx) {
  const msg = ctx.message;
  if (!msg || !msg.from) return;

  const userId = msg.from.id;
  // ✅ 首次私聊管理员机器人立即加入 adminIds
  if (msg.chat.type === "private" && !adminIds.has(userId)) {
    adminIds.add(userId);
    console.log(`ℹ️ 新管理员私聊机器人，已加入 adminIds: ${userId}`);
  }

  if (!nickMap.has(userId)) {
    const nick = generateNick(userId);
    nickMap.get(userId).user = msg.from;
  }

  if (!msg.chat || (msg.chat.type !== "group" && msg.chat.type !== "supergroup")) return;

  const msgKey = `${msg.chat.id}_${msg.message_id}`;
  if (processedMessages.has(msgKey)) return;
  markProcessed(msgKey);

  if (msg.from.is_bot) return;
  const nick = generateNick(userId);
  if (adminIds.has(userId)) return;

  const text = msg.text || msg.caption || "";
  const hasLinkOrMention = /\bhttps?:\/\/\S+|\@\w+/i.test(text);
  const hasBlockedWord = blockedWordsRegex && blockedWordsRegex.test(text);

  if (hasLinkOrMention || hasBlockedWord) {
    try { await ctx.api.deleteMessage(msg.chat.id, msg.message_id); } catch {}
    const reviewId = `${msg.chat.id}_${msg.message_id}`;
    const adminMsgIds = [];
    pendingReviews.set(reviewId, { user: msg.from, msg, adminMsgIds, reviewTime: Date.now() });

    const fullName = `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
    for (const adminId of adminIds) {
      try {
        const kb = new InlineKeyboard()
          .text("✅ 同意", `approve_${reviewId}`)
          .text("❌ 拒绝", `reject_${reviewId}`);
        const m = await ctx.api.sendMessage(
          adminId,
          `⚠️ 用户违规消息待审核\n\n👤 用户: ${fullName} (${msg.from.username ? '@'+msg.from.username : '无用户名'})\n🆔 ID: ${msg.from.id}\n\n内容: ${text}`,
          { reply_markup: kb }
        ).catch(() => null);
        if (m) adminMsgIds.push(m.message_id);
      } catch {}
    }
    return;
  }

  // 正常消息：删除 + 匿名转发
  try { await ctx.api.deleteMessage(msg.chat.id, msg.message_id); } catch {}
  const forwardBot = getNextBot();
  try {
    if (msg.photo) await forwardBot.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, { caption: `${nick}${msg.caption ? ' ' + msg.caption : ''}` });
    else if (msg.video) await forwardBot.api.sendVideo(GROUP_ID, msg.video.file_id, { caption: `${nick}${msg.caption ? ' ' + msg.caption : ''}` });
    else if (msg.sticker) await forwardBot.api.sendSticker(GROUP_ID, msg.sticker.file_id);
    else if (msg.text) await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${msg.text}`);
    else await forwardBot.api.sendMessage(GROUP_ID, `${nick} [不支持的消息类型]`);
  } catch (e) {
    console.error("转发失败:", e.message);
  }
}

// =====================
// 审核回调、info_code 和 Webhook 逻辑
// =====================
// （保持之前优化版逻辑不变，略去重复部分，可直接沿用上一版代码）
