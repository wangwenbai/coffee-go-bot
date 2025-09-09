import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";
import crypto from "crypto";

// =====================
// 环境变量配置
// =====================
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const GROUP_ID = Number(process.env.GROUP_ID);
const NICK_PREFIX = process.env.NICK_PREFIX || "匿名";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL + "/webhook";

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
setInterval(loadBlockedWords, 60_000); // 每分钟刷新屏蔽词

// =====================
// 初始化匿名用户映射
// =====================
const nickMap = new Map(); // userId => nickname
const usedCodes = new Set(); // 保证匿名码唯一性

function generateNick() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  while (true) {
    let arr = [...letters + digits];
    arr.sort(() => Math.random() - 0.5);
    let code = arr.slice(0,4).join("");
    if (!usedCodes.has(code)) {
      usedCodes.add(code);
      return `【${NICK_PREFIX}${code}】`;
    }
  }
}

function releaseNick(userId) {
  if (nickMap.has(userId)) {
    const nick = nickMap.get(userId);
    const code = nick.slice(NICK_PREFIX.length+1, -1); // 去掉【前缀和】
    usedCodes.delete(code);
    nickMap.delete(userId);
  }
}

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
// 管理员列表
// =====================
const adminIds = new Set(); // 私聊过机器人并且是管理员的用户id

// =====================
// 消息处理逻辑
// =====================
async function handleGroupMessage(bot, ctx) {
  const msg = ctx.message;
  const userId = msg.from.id;
  const text = msg.text || "";

  // 生成匿名昵称
  if (!nickMap.has(userId)) {
    nickMap.set(userId, generateNick());
  }
  const nick = nickMap.get(userId);

  // 检查违规条件
  const hasLinkOrMention = /\bhttps?:\/\/\S+|\@\w+/i.test(text);
  const hasBlockedWord = blockedWords.some(word => text.toLowerCase().includes(word.toLowerCase()));

  if (hasLinkOrMention || hasBlockedWord) {
    // 删除原消息
    try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch(e){}

    // 通知管理员审批
    for (let adminId of adminIds) {
      try {
        const keyboard = new InlineKeyboard()
          .text("同意", `approve_${ctx.message.message_id}`)
          .text("拒绝", `reject_${ctx.message.message_id}`);
        await ctx.api.sendMessage(adminId,
          `用户 ${nick} 发送了违规消息，等待审批：\n${text}`,
          { reply_markup: keyboard }
        );
      } catch(e) {
        // 忽略不能私聊的错误
      }
    }
    return;
  }

  // 正常删除并匿名转发
  try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch(e){}
  const forwardBot = getNextBot();
  try {
    await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${text}`);
  } catch(e){}
}

// =====================
// 管理员审批回调
// =====================
async function handleCallback(bot, ctx) {
  const data = ctx.callbackQuery.data;
  const match = data.match(/^(approve|reject)_(\d+)$/);
  if (!match) return;
  const action = match[1];
  const messageId = match[2];

  // 更新所有管理员按钮
  for (let adminId of adminIds) {
    try {
      await ctx.api.editMessageReplyMarkup(adminId, ctx.callbackQuery.message.message_id, { inline_keyboard: [
        [{ text: action === "approve" ? "已同意" : "已拒绝", callback_data: "done" }]
      ]});
    } catch(e){}
  }

  if (action === "approve") {
    // 转发消息
    const nick = nickMap.get(ctx.callbackQuery.from.id) || NICK_PREFIX;
    try {
      const forwardBot = getNextBot();
      await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${ctx.callbackQuery.message.text.split("\n").pop()}`);
    } catch(e){}
  }
  await ctx.answerCallbackQuery();
}

// =====================
// 机器人消息绑定
// =====================
bots.forEach(bot => {
  bot.on("message", async ctx => {
    try {
      if (ctx.chat.id === GROUP_ID) {
        await handleGroupMessage(bot, ctx);
      } else if (ctx.chat.type === "private") {
        adminIds.add(ctx.from.id);
      }
    } catch(e){}
  });
  bot.on("callback_query", async ctx => {
    try { await handleCallback(bot, ctx); } catch(e){}
  });
});

// =====================
// Express Webhook
// =====================
const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  try {
    const updates = Array.isArray(req.body) ? req.body : [req.body];
    for (const update of updates) {
      for (const bot of bots) {
        try { await bot.handleUpdate(update); } catch(e){}
      }
    }
  } catch(e){}
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  // 设置 webhook
  for (const bot of bots) {
    try { await bot.api.setWebhook(`${WEBHOOK_URL}`); } catch(e){}
  }
});
