import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";
import path from "path";

const {
  BOT_TOKENS,
  GROUP_ID,
  NICK_PREFIX,
  PORT = 3000,
  RENDER_EXTERNAL_URL
} = process.env;

if (!BOT_TOKENS || !GROUP_ID || !NICK_PREFIX || !RENDER_EXTERNAL_URL) {
  console.error("请检查环境变量 BOT_TOKENS, GROUP_ID, NICK_PREFIX, PORT, RENDER_EXTERNAL_URL");
  process.exit(1);
}

// --- 初始化多个机器人 ---
const tokens = BOT_TOKENS.split(",").map(t => t.trim()).filter(Boolean);
const bots = tokens.map(t => new Bot(t));
let botIndex = 0; // 多机器人轮流发送

// --- 数据存储 ---
const userMap = new Map(); // userId => nick
const usedNickCodes = new Set();
const pendingApprovals = new Map(); // messageId => { text, userId, processed: false }
let blockedWords = [];

// --- 屏蔽词动态加载 ---
const loadBlockedWords = () => {
  try {
    const txt = fs.readFileSync(path.resolve("./blocked.txt"), "utf-8");
    blockedWords = txt.split(/\r?\n/).map(w => w.trim()).filter(Boolean);
    console.log("✅ 屏蔽词已加载：", blockedWords);
  } catch (e) {
    console.error("加载屏蔽词失败", e);
  }
};
loadBlockedWords();
setInterval(loadBlockedWords, 60 * 1000); // 每分钟重新加载

// --- 生成唯一匿名码 ---
function generateNickname() {
  let code;
  do {
    const letters = Array.from({ length: 2 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26)));
    const digits = Array.from({ length: 2 }, () => Math.floor(Math.random() * 10));
    const arr = letters.concat(digits).sort(() => Math.random() - 0.5);
    code = `${NICK_PREFIX}${arr.join("")}`;
  } while (usedNickCodes.has(code));
  usedNickCodes.add(code);
  return `【${code}】`;
}

// --- 获取轮流机器人 ---
function getNextBot() {
  const bot = bots[botIndex];
  botIndex = (botIndex + 1) % bots.length;
  return bot;
}

// --- 存储管理员 ---
let adminIds = new Set();
async function refreshAdmins(bot) {
  try {
    const admins = await bot.api.getChatAdministrators(GROUP_ID);
    adminIds = new Set(admins.map(a => a.user.id));
    console.log("管理员列表已更新", Array.from(adminIds));
  } catch (e) {
    console.warn("获取管理员失败", e);
  }
}

// --- 消息处理 ---
async function handleUpdate(bot, update) {
  if (!update.message) return;
  const msg = update.message;
  if (msg.chat.id.toString() !== GROUP_ID) return;

  const userId = msg.from.id;
  if (!userMap.has(userId)) {
    const nick = generateNickname();
    userMap.set(userId, nick);
  }
  const nick = userMap.get(userId);

  const text = msg.text || msg.caption || "";
  const hasLinkOrMention = /\bhttps?:\/\/\S+|@\w+/i.test(text);
  const hasBlocked = blockedWords.some(w => text.toLowerCase().includes(w.toLowerCase()));

  if (hasLinkOrMention || hasBlocked) {
    // 删除原消息
    try {
      await bot.api.deleteMessage(GROUP_ID, msg.message_id);
    } catch (e) {}

    // 发送审批消息给所有私聊过的管理员
    const keyboard = new InlineKeyboard()
      .text("✅ 同意", `approve_${msg.message_id}`)
      .text("❌ 拒绝", `reject_${msg.message_id}`);
    pendingApprovals.set(msg.message_id, { text, userId, processed: false, nick });

    for (const adminId of adminIds) {
      try {
        await bot.api.sendMessage(adminId, `${nick} 发送了违规消息，请审批：\n${text}`, { reply_markup: keyboard });
      } catch (e) {}
    }
  } else {
    // 正常消息匿名转发
    try {
      const nextBot = getNextBot();
      await nextBot.api.sendMessage(GROUP_ID, `${nick} ${text}`);
      await bot.api.deleteMessage(GROUP_ID, msg.message_id);
    } catch (e) {
      console.warn("转发失败", e);
    }
  }
}

// --- 处理审批回调 ---
async function handleCallback(bot, ctx) {
  const data = ctx.callbackQuery.data;
  const match = data.match(/(approve|reject)_(\d+)/);
  if (!match) return;
  const [_, action, msgId] = match;
  const pending = pendingApprovals.get(Number(msgId));
  if (!pending || pending.processed) return;

  pending.processed = true;
  if (action === "approve") {
    // 审批同意，匿名转发
    const nextBot = getNextBot();
    try {
      await nextBot.api.sendMessage(GROUP_ID, `${pending.nick} ${pending.text}`);
    } catch (e) {}
  }
  // 更新所有管理员显示已处理
  for (const adminId of adminIds) {
    try {
      await bot.api.editMessageReplyMarkup(adminId, Number(msgId), { inline_keyboard: [[{ text: "已处理", callback_data: "done" }]] });
    } catch (e) {}
  }
}

// --- Webhook 服务器 ---
const app = express();
app.use(express.json());

app.post(`/${tokens[0]}`, async (req, res) => {
  for (const bot of bots) {
    try {
      await bot.handleUpdate(req.body);
    } catch (e) {}
  }
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// --- 初始化所有机器人 ---
(async () => {
  for (const bot of bots) {
    await refreshAdmins(bot);

    bot.on("message", async (ctx) => handleUpdate(bot, ctx.update));
    bot.on("callback_query:data", async (ctx) => handleCallback(bot, ctx));
  }
})();
