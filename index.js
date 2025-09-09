import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";

// =====================
// 环境变量
// =====================
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const GROUP_ID = Number(process.env.GROUP_ID);
const NICK_PREFIX = process.env.NICK_PREFIX || "匿名";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = `${process.env.RENDER_EXTERNAL_URL}/webhook`;

// =====================
// 屏蔽词（可选）
// =====================
let blockedWords = [];
function loadBlockedWords() {
  if (fs.existsSync("./blocked.txt")) {
    blockedWords = fs.readFileSync("./blocked.txt", "utf-8")
      .split(/\r?\n/)
      .map(w => w.trim())
      .filter(Boolean);
    console.log("✅ 屏蔽词已加载：", blockedWords);
  }
}
loadBlockedWords();
setInterval(loadBlockedWords, 60_000);

// =====================
// 匿名昵称管理
// =====================
const nickMap = new Map();
const usedCodes = new Set();
function generateNick() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); }
  while (usedCodes.has(code));
  usedCodes.add(code);
  return `【${NICK_PREFIX}${code}】`;
}
function releaseNick(userId) {
  if (nickMap.has(userId)) {
    const nick = nickMap.get(userId);
    const code = nick.slice(NICK_PREFIX.length + 1, -1);
    usedCodes.delete(code);
    nickMap.delete(userId);
  }
}

// =====================
// 多机器人轮转
// =====================
const bots = BOT_TOKENS.map(token => new Bot(token));
let botIndex = 0;
function getNextBot() {
  const bot = bots[botIndex];
  botIndex = (botIndex + 1) % bots.length;
  return bot;
}

// =====================
// 管理员列表
// =====================
const adminIds = new Set();

// =====================
// 群消息处理
// =====================
async function handleGroupMessage(ctx) {
  const msg = ctx.message;
  const userId = msg.from.id;
  const chatId = Number(ctx.chat.id);
  const text = msg.text || "";

  if (adminIds.has(userId)) return;

  if (!nickMap.has(userId)) nickMap.set(userId, generateNick());
  const nick = nickMap.get(userId);

  const hasLinkOrMention = /\bhttps?:\/\/\S+|\@\w+/i.test(text);
  const hasBlockedWord = blockedWords.some(word => text.toLowerCase().includes(word.toLowerCase()));

  const safeDelete = async () => {
    try { await ctx.api.deleteMessage(chatId, msg.message_id); } 
    catch(e){ console.log("删除消息失败:", e.description || e); }
  };

  if (hasLinkOrMention || hasBlockedWord) {
    await safeDelete();
    for (let adminId of adminIds) {
      try {
        const keyboard = new InlineKeyboard()
          .text("同意", `approve_${msg.message_id}`)
          .text("拒绝", `reject_${msg.message_id}`);
        await ctx.api.sendMessage(adminId, `用户 ${nick} 发送了违规消息，等待审批：\n${text}`, { reply_markup: keyboard });
      } catch(e){ console.log("通知管理员失败:", e.description || e); }
    }
    return;
  }

  // 删除并匿名转发
  await safeDelete();
  try {
    const forwardBot = getNextBot();
    await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${text}`);
  } catch(e){ console.log("转发失败:", e.description || e); }
}

// =====================
// 管理员审批回调
// =====================
async function handleCallback(ctx) {
  const data = ctx.callbackQuery.data;
  const match = data.match(/^(approve|reject)_(\d+)$/);
  if (!match) return;
  const [_, action] = match;

  for (let adminId of adminIds) {
    try {
      await ctx.api.editMessageReplyMarkup(adminId, ctx.callbackQuery.message.message_id, {
        inline_keyboard: [[{ text: action === "approve" ? "已同意" : "已拒绝", callback_data: "done" }]]
      });
    } catch {}
  }

  if (action === "approve") {
    const nick = nickMap.get(ctx.callbackQuery.from.id) || NICK_PREFIX;
    const lines = ctx.callbackQuery.message.text?.split("\n") || [];
    const originalText = lines[lines.length - 1] || "";
    try {
      const forwardBot = getNextBot();
      await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${originalText}`);
    } catch(e){ console.log("审批转发失败:", e.description || e); }
  }

  await ctx.answerCallbackQuery();
}

// =====================
// 绑定事件
// =====================
bots.forEach(bot => {
  bot.on("message", handleGroupMessage);
  bot.on("callback_query", handleCallback);
  bot.on("message", async ctx => {
    if (ctx.chat.type === "private") adminIds.add(ctx.from.id);
  });
});

// =====================
// Express Webhook
// =====================
const app = express();
app.use(express.json());
app.post("/webhook", async (req, res) => {
  const updates = Array.isArray(req.body) ? req.body : [req.body];
  for (const update of updates) {
    for (const bot of bots) {
      try { await bot.handleUpdate(update); } catch(e){ console.log("处理update失败:", e); }
    }
  }
  res.sendStatus(200);
});

// =====================
// 启动服务器 & Webhook/轮询
// =====================
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  for (const bot of bots) {
    try {
      await bot.api.setWebhook(WEBHOOK_URL);
      console.log(`Webhook 设置成功: ${WEBHOOK_URL}`);
    } catch(e) {
      console.log("设置Webhook失败，自动切换轮询模式:", e.description || e);
      bot.start();
    }
  }
});
