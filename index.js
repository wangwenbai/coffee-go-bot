import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";
import path from "path";

// --- 环境变量 ---
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const GROUP_ID = Number(process.env.GROUP_ID);
const NICK_PREFIX = process.env.NICK_PREFIX || "Anon";
const PORT = process.env.PORT || 3000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

// --- 多机器人 ---
const bots = BOT_TOKENS.map(token => new Bot(token));

// --- 匿名管理 ---
const userMap = new Map(); // userId -> nickname
const usedCodes = new Set();

// --- 屏蔽词 ---
let blockedWords = [];
const blockedFile = path.join(process.cwd(), "blocked.txt");
function loadBlockedWords() {
  if (fs.existsSync(blockedFile)) {
    blockedWords = fs.readFileSync(blockedFile, "utf-8")
      .split(/\r?\n/)
      .map(w => w.trim())
      .filter(Boolean);
    console.log("✅ 屏蔽词已加载：", blockedWords);
  }
}
loadBlockedWords();
setInterval(loadBlockedWords, 60_000); // 每60秒刷新

// --- 管理员 ---
let adminIds = new Set();
async function refreshAdmins(bot) {
  try {
    const admins = await bot.api.getChatAdministrators(GROUP_ID);
    adminIds = new Set(admins.map(a => a.user.id));
    console.log("✅ 管理员已更新：", [...adminIds]);
  } catch (e) {
    console.error("获取管理员失败", e);
  }
}

// --- 匿名名生成 ---
function generateNickname() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  while (true) {
    const arr = [];
    for (let i = 0; i < 2; i++) arr.push(letters[Math.floor(Math.random() * letters.length)]);
    for (let i = 0; i < 2; i++) arr.push(digits[Math.floor(Math.random() * digits.length)]);
    arr.sort(() => Math.random() - 0.5);
    const code = arr.join("");
    if (!usedCodes.has(code)) {
      usedCodes.add(code);
      return `[${NICK_PREFIX}${code}]`;
    }
  }
}

// --- 消息审批记录 ---
const pendingApprovals = new Map(); // messageId -> { text, userId, processed }

// --- 轮流机器人索引 ---
let botIndex = 0;

// --- Express ---
const app = express();
app.use(express.json());

// --- Webhook 路由 ---
app.post(`/${bots[0].token}`, async (req, res) => {
  const update = req.body;
  const bot = bots[botIndex];
  botIndex = (botIndex + 1) % bots.length; // 轮流

  try {
    await handleUpdate(bot, update);
  } catch (e) {
    console.error(e);
  }
  res.sendStatus(200);
});

// --- 消息处理 ---
async function handleUpdate(bot, update) {
  if (!update.message) return;
  const msg = update.message;
  if (msg.chat.id !== GROUP_ID) return;

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
    } catch (e) {
      console.warn("删除消息失败", e);
    }

    // 生成审批消息
    const keyboard = new InlineKeyboard()
      .text("✅ 同意", `approve_${msg.message_id}`)
      .text("❌ 拒绝", `reject_${msg.message_id}`);

    pendingApprovals.set(msg.message_id, { text, userId, processed: false });

    for (const adminId of adminIds) {
      try {
        await bot.api.sendMessage(adminId, 
          `${nick} 发送了违规消息，请审批：\n${text}`, 
          { reply_markup: keyboard }
        );
      } catch (e) {
        // admin没有私聊过bot会失败
      }
    }
  } else {
    // 正常消息可以匿名转发
    try {
      await bot.api.sendMessage(GROUP_ID, `${nick} ${text}`, { reply_to_message_id: msg.message_id });
      await bot.api.deleteMessage(GROUP_ID, msg.message_id);
    } catch (e) {
      console.warn("转发消息失败", e);
    }
  }
}

// --- 回调处理 ---
for (const bot of bots) {
  bot.callbackQuery(async ctx => {
    const data = ctx.callbackQuery.data;
    const [action, msgIdStr] = data.split("_");
    const msgId = Number(msgIdStr);
    const approval = pendingApprovals.get(msgId);
    if (!approval || approval.processed) {
      await ctx.answerCallbackQuery({ text: "已处理" });
      return;
    }
    approval.processed = true;
    pendingApprovals.set(msgId, approval);

    if (action === "approve") {
      const nick = userMap.get(approval.userId) || "[匿名]";
      await ctx.api.sendMessage(GROUP_ID, `${nick} ${approval.text}`);
    }

    for (const adminId of adminIds) {
      try {
        await ctx.api.editMessageText(adminId, `${approval.text}\n已处理`);
      } catch (e) {}
    }
    await ctx.answerCallbackQuery({ text: "处理完成" });
  });
}

// --- 设置 Webhook ---
(async () => {
  for (const bot of bots) {
    try {
      await bot.api.setWebhook(`${EXTERNAL_URL}/${bot.token}`);
      await refreshAdmins(bot);
    } catch (e) {
      console.error("设置 webhook 失败", e);
    }
  }
})();

// --- 启动 Express ---
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
