import { Bot, InlineKeyboard } from "grammy";
import fs from "fs";
import express from "express";
import Redis from "ioredis";

const PORT = process.env.PORT || 3000;

// --- 多机器人 Token 配置 ---
const BOT_TOKENS = [
  "TOKEN_1",
  "TOKEN_2",
  "TOKEN_3"
];

let bots = [];
let botIndex = 0;

// --- Redis 配置 ---
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

// --- 屏蔽词 ---
let bannedWords = [];
function loadBannedWords() {
  if (fs.existsSync("blocked.txt")) {
    bannedWords = fs.readFileSync("blocked.txt", "utf-8")
      .split("\n")
      .map(w => w.trim())
      .filter(Boolean);
    console.log("✅ 屏蔽词已加载：", bannedWords);
  }
}
loadBannedWords();
setInterval(loadBannedWords, 60_000);

// --- 群管理信息 ---
const groupData = new Map(); 
// key: chatId, value: { admins: Map<adminId, true>, queue: [], processing: false, pendingMessages: Map<messageId, {...}> }

// --- Express 保活 ---
const app = express();
app.use(express.json());
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// --- 初始化机器人 ---
async function initBots() {
  for (let i = 0; i < BOT_TOKENS.length; i++) {
    const bot = new Bot(BOT_TOKENS[i]);
    await bot.init();

    bot.on("message", ctx => enqueueMessage(ctx, bot));
    bot.on("callback_query:data", ctx => handleApproval(ctx));

    bots.push(bot);
    bot.start();
    console.log(`🤖 Bot #${i + 1} 已启动`);
  }
}
initBots();

// --- 入队消息 ---
function enqueueMessage(ctx, bot) {
  if (!ctx.chat || ctx.from.is_bot) return;

  if (!groupData.has(ctx.chat.id)) {
    groupData.set(ctx.chat.id, { 
      admins: new Map(), 
      queue: [], 
      processing: false, 
      pendingMessages: new Map() 
    });
  }

  const gData = groupData.get(ctx.chat.id);
  gData.queue.push({ ctx, bot });

  if (!gData.processing) processQueue(ctx.chat.id);
}

// --- 队列处理 ---
async function processQueue(chatId) {
  const gData = groupData.get(chatId);
  gData.processing = true;

  while (gData.queue.length > 0) {
    const { ctx, bot } = gData.queue.shift();
    await handleMessage(ctx, bot, gData);
  }

  gData.processing = false;
}

// --- 获取管理员 ---
async function ensureAdmins(ctx, gData) {
  try {
    if (ctx.chat.type.endsWith("group")) {
      const admins = await ctx.getChatAdministrators();
      admins.forEach(a => gData.admins.set(a.user.id, true));
    }
  } catch (e) {
    console.log("⚠️ 获取管理员失败", e.message);
  }
}

// --- 处理消息 ---
async function handleMessage(ctx, bot, gData) {
  await ensureAdmins(ctx, gData);

  const text = ctx.message?.text || "";
  const containsLinkOrMention = /https?:\/\/\S+|@\w+/.test(text);
  const containsBanned = bannedWords.some(w => text.toLowerCase().includes(w));

  if (ctx.chat.type.endsWith("group")) {
    try { await ctx.deleteMessage(); } catch {}

    if (containsLinkOrMention || containsBanned) {
      // 保存到 Redis
      const key = `pending:${ctx.chat.id}:${ctx.message.message_id}`;
      await redis.set(key, JSON.stringify({
        chatId: ctx.chat.id,
        content: text,
        approved: false
      }));

      // 待审批
      gData.pendingMessages.set(ctx.message.message_id, {
        chatId: ctx.chat.id,
        content: text,
        approved: false
      });

      const keyboard = new InlineKeyboard()
        .text("✅ 同意转发", `approve_${ctx.message.message_id}`)
        .text("❌ 拒绝", `reject_${ctx.message.message_id}`);

      for (let adminId of gData.admins.keys()) {
        try {
          await bot.api.sendMessage(adminId,
            `用户 ${ctx.from.username || ctx.from.first_name} 发送消息:\n${text}\n审批操作：`,
            { reply_markup: keyboard }
          );
        } catch (e) {
          if (!e.description?.includes("Forbidden")) console.error(e);
        }
      }
    } else {
      // 普通消息，轮流机器人处理
      const forwardBot = bots[botIndex];
      botIndex = (botIndex + 1) % bots.length;
      try { await forwardBot.api.sendMessage(ctx.chat.id, text, { parse_mode: "HTML" }); } catch {}
    }
  }
}

// --- 审批处理 ---
async function handleApproval(ctx) {
  const data = ctx.callbackQuery.data;
  const [action, messageId] = data.split("_");
  const msgId = Number(messageId);

  // 找到群
  let gData;
  for (let gd of groupData.values()) {
    if (gd.pendingMessages.has(msgId)) {
      gData = gd;
      break;
    }
  }
  if (!gData) return;

  const msgInfo = gData.pendingMessages.get(msgId);
  if (!msgInfo) return;

  if (action === "approve" && !msgInfo.approved) {
    msgInfo.approved = true;

    // 更新 Redis
    const key = `pending:${msgInfo.chatId}:${msgId}`;
    await redis.set(key, JSON.stringify(msgInfo));

    const forwardBot = bots[botIndex];
    botIndex = (botIndex + 1) % bots.length;
    try { await forwardBot.api.sendMessage(msgInfo.chatId, msgInfo.content, { parse_mode: "HTML" }); } catch {}
  }

  // 更新所有管理员按钮为已处理
  for (let adminId of gData.admins.keys()) {
    try {
      await ctx.api.editMessageReplyMarkup(adminId, ctx.callbackQuery.message.message_id, {
        reply_markup: new InlineKeyboard().text("已处理", "done")
      });
    } catch {}
  }

  await ctx.answerCallbackQuery();
}
