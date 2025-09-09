import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";

// =====================
// 环境变量配置
// =====================
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const GROUP_ID = Number(process.env.GROUP_ID); // 超级群负数，如 -1001234567890
const NICK_PREFIX = process.env.NICK_PREFIX || "匿名";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = `${process.env.RENDER_EXTERNAL_URL}/webhook`;

// =====================
// 初始化屏蔽词
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
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (usedCodes.has(code));
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
// 初始化机器人（多机器人轮转）
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
async function handleGroupMessage(bot, ctx) {
  const msg = ctx.message;
  const userId = msg.from.id;
  const chatId = Number(ctx.chat.id);
  const text = msg.text || "";

  // 管理员消息保持原样
  if (adminIds.has(userId)) return;

  // 生成匿名昵称
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
        await ctx.api.sendMessage(adminId, `用户 ${nick} 发送了违规消息，等待审批：\n${text}`, {
          reply_markup: keyboard
        });
      } catch(e){ console.log("通知管理员失败:", e.description || e); }
    }
    return;
  }

  // 正常消息：删除并匿名转发
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

  const [_, action, messageId] = match;

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
// 机器人消息绑定
// =====================
bots.forEach(bot => {
  bot.on("message", async ctx => {
    try {
      if (Number(ctx.chat.id) === GROUP_ID) await handleGroupMessage(bot, ctx);
      else if (ctx.chat.type === "private") adminIds.add(ctx.from.id);
    } catch(e){ console.log("处理消息失败:", e); }
  });

  bot.on("callback_query", async ctx => {
    try { await handleCallback(ctx); } catch(e){ console.log("处理回调失败:", e); }
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

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  for (const bot of bots) {
    try { await bot.api.setWebhook(WEBHOOK_URL); } catch(e){ console.log("设置Webhook失败:", e); }
  }
});
