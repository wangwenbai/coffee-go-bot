import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";

// =====================
// 环境变量配置
// =====================
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const GROUP_ID = Number(process.env.GROUP_ID);
const NICK_PREFIX = process.env.NICK_PREFIX || "#";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL + "/webhook";

// =====================
// 屏蔽词初始化
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
// 匿名昵称映射
// =====================
const nickMap = new Map(); // userId => nickname
const usedCodes = new Set(); // 匿名码唯一性

function generateNick() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  while (true) {
    let arr = [...letters + digits];
    arr.sort(() => Math.random() - 0.5);
    let code = arr.slice(0, 4).join("");
    if (!usedCodes.has(code)) {
      usedCodes.add(code);
      return `【${NICK_PREFIX}${code}】`;
    }
  }
}

function releaseNick(userId) {
  if (nickMap.has(userId)) {
    const nick = nickMap.get(userId);
    const code = nick.slice(NICK_PREFIX.length + 2, -1);
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
const adminIds = new Set();

// =====================
// 删除消息并转发辅助函数
// =====================
async function tryDeleteThenForward(ctx, msg, forwardFn, retries = 3, delayMs = 500) {
  try {
    await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
    // 删除成功，立即转发
    await forwardFn();
  } catch (e) {
    console.warn(`首次删除失败 (${msg.message_id}): ${e.message}`);
    // 异步重试
    let attempt = 0;
    const interval = setInterval(async () => {
      attempt++;
      try {
        await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
        clearInterval(interval);
        await forwardFn();
      } catch (err) {
        console.warn(`重试删除 ${attempt}/${retries} 失败 (${msg.message_id}): ${err.message}`);
        if (attempt >= retries) clearInterval(interval);
      }
    }, delayMs);
  }
}

// =====================
// 群消息处理逻辑
// =====================
async function handleGroupMessage(bot, ctx) {
  const msg = ctx.message;
  const userId = msg.from.id;

  // 忽略管理员消息
  if (msg.from.is_bot || msg.from.status === "administrator") return;

  // 生成匿名昵称
  if (!nickMap.has(userId)) {
    nickMap.set(userId, generateNick());
  }
  const nick = nickMap.get(userId);

  const text = msg.text || "";
  const hasLinkOrMention = /\bhttps?:\/\/\S+|\@\w+/i.test(text);
  const hasBlockedWord = blockedWords.some(word => text.toLowerCase().includes(word.toLowerCase()));

  if (hasLinkOrMention || hasBlockedWord) {
    // 违规消息，只删除，不直接转发
    await tryDeleteThenForward(ctx, msg, async () => {
      // 通知管理员
      for (let adminId of adminIds) {
        try {
          const keyboard = new InlineKeyboard()
            .text("同意", `approve_${msg.message_id}`)
            .text("拒绝", `reject_${msg.message_id}`);
          await ctx.api.sendMessage(adminId,
            `用户 ${msg.from.username || msg.from.first_name} (${msg.from.id}) 发送了违规消息，等待审批：\n${text}`,
            { reply_markup: keyboard }
          );
        } catch (e) {}
      }
    });
    return;
  }

  // 正常消息，删除后匿名转发
  await tryDeleteThenForward(ctx, msg, async () => {
    const forwardBot = getNextBot();
    try {
      if (msg.photo) {
        await forwardBot.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, {
          caption: `${nick}${msg.caption ? ' ' + msg.caption : ''}`
        });
      } else if (msg.video) {
        await forwardBot.api.sendVideo(GROUP_ID, msg.video.file_id, {
          caption: `${nick}${msg.caption ? ' ' + msg.caption : ''}`
        });
      } else if (msg.sticker) {
        await forwardBot.api.sendSticker(GROUP_ID, msg.sticker.file_id);
      } else if (msg.text) {
        await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${msg.text}`);
      } else {
        await forwardBot.api.sendMessage(GROUP_ID, `${nick} [不支持的消息类型]`);
      }
    } catch (e) {
      console.error("转发失败:", e.message);
    }
  });
}

// =====================
// 审核回调
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
    const msgText = ctx.callbackQuery.message.text.split("\n").pop();
    const nick = NICK_PREFIX;
    const forwardBot = getNextBot();
    await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${msgText}`);
  }
  await ctx.answerCallbackQuery();
}

// =====================
// Bot事件绑定
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
  for (const bot of bots) {
    try { await bot.api.setWebhook(`${WEBHOOK_URL}`); } catch(e){}
  }
});
