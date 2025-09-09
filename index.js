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
// 屏蔽词加载
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
// 已处理消息集合
// =====================
const processedMessages = new Set();

// =====================
// 待审批消息
// =====================
const pendingApprovals = new Map(); // message_id -> { userNick, text, notifiedAdmins }

// =====================
// 群消息处理
// =====================
async function handleGroupMessage(ctx) {
  const msg = ctx.message;
  const userId = msg.from.id;
  const messageId = msg.message_id;

  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);

  if (adminIds.has(userId)) return; // 管理员消息不处理

  const text = msg.text || "";
  if (!nickMap.has(userId)) nickMap.set(userId, generateNick());
  const nick = nickMap.get(userId);

  const hasLinkOrMention = /\bhttps?:\/\/\S+|\@\w+/i.test(text);
  const hasBlockedWord = blockedWords.some(word => text.toLowerCase().includes(word.toLowerCase()));

  // 删除消息
  try { await ctx.api.deleteMessage(ctx.chat.id, messageId); }
  catch(e){ console.log("删除消息失败:", e.description || e); }

  // 判断是否违规
  if (hasLinkOrMention || hasBlockedWord) {
    pendingApprovals.set(messageId, { userNick: nick, text, notifiedAdmins: new Set() });
    for (let adminId of adminIds) {
      try {
        const keyboard = new InlineKeyboard()
          .text("同意", `approve_${messageId}`)
          .text("拒绝", `reject_${messageId}`);
        await ctx.api.sendMessage(adminId,
          `用户 ${nick} 发送了可能违规消息，等待审批：\n${text}`,
          { reply_markup: keyboard }
        );
        pendingApprovals.get(messageId).notifiedAdmins.add(adminId);
      } catch(e){ console.log("通知管理员失败:", e.description || e); }
    }
    return; // 不转发
  }

  // 正常匿名转发
  try {
    const forwardBot = getNextBot();
    await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${text}`);
  } catch(e){ console.log("转发失败:", e.description || e); }
}

// =====================
// 审批回调
// =====================
async function handleCallback(ctx) {
  const data = ctx.callbackQuery.data;
  const match = data.match(/^(approve|reject)_(\d+)$/);
  if (!match) return;
  const [_, action, messageIdStr] = match;
  const messageId = Number(messageIdStr);

  const pending = pendingApprovals.get(messageId);
  if (!pending) return;

  // 更新所有管理员按钮为“已处理”
  for (let adminId of pending.notifiedAdmins) {
    try {
      await ctx.api.editMessageReplyMarkup(adminId, ctx.callbackQuery.message.message_id, {
        inline_keyboard: [[{ text: action === "approve" ? "已同意" : "已拒绝", callback_data: "done" }]]
      });
    } catch {}
  }

  // 审核同意 → 匿名转发
  if (action === "approve") {
    try {
      const forwardBot = getNextBot();
      await forwardBot.api.sendMessage(GROUP_ID, `${pending.userNick} ${pending.text}`);
    } catch(e){ console.log("审批转发失败:", e.description || e); }
  }

  pendingApprovals.delete(messageId);
  await ctx.answerCallbackQuery();
}

// =====================
// 事件绑定
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
// 启动服务器 & 初始化机器人
// =====================
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  for (const bot of bots) {
    try {
      await bot.init();
      await bot.api.setWebhook(WEBHOOK_URL);
      console.log(`Webhook 设置成功: ${WEBHOOK_URL}`);
    } catch(e) {
      console.log("Webhook 设置失败，切换轮询模式:", e.message || e);
      bot.start();
    }
  }
});
