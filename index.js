import express from "express";
import { Bot, InlineKeyboard } from "grammy";
import fs from "fs";
import path from "path";

// 配置环境变量
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const GROUP_ID = parseInt(process.env.GROUP_ID);
const NICK_PREFIX = process.env.NICK_PREFIX || "Anon";
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

// 初始化 Express
const app = express();
app.use(express.json());

// 屏蔽词动态加载
let bannedWords = [];
const loadBannedWords = () => {
  try {
    const txt = fs.readFileSync(path.join(process.cwd(), "blocked.txt"), "utf-8");
    bannedWords = txt.split(/\r?\n/).map(w => w.trim()).filter(Boolean);
    console.log("✅ 屏蔽词已加载：", bannedWords);
  } catch (err) {
    console.log("⚠️ blocked.txt 读取失败:", err.message);
    bannedWords = [];
  }
};
loadBannedWords();
setInterval(loadBannedWords, 60 * 1000); // 每分钟刷新

// 匿名昵称管理
const nickMap = new Map(); // userId => nick
const usedCodes = new Set();

// 生成唯一匿名昵称
const generateNick = () => {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  let code;
  do {
    let arr = [];
    for (let i = 0; i < 2; i++) arr.push(letters[Math.floor(Math.random() * letters.length)]);
    for (let i = 0; i < 2; i++) arr.push(digits[Math.floor(Math.random() * digits.length)]);
    arr.sort(() => Math.random() - 0.5);
    code = arr.join("");
  } while (usedCodes.has(code));
  usedCodes.add(code);
  return `【${NICK_PREFIX}${code}】`;
};

// 管理员列表（私聊过机器人自动添加）
const adminSet = new Set();

// 消息审批记录
const pendingMessages = new Map(); // msgId => {text, senderId, handled}

// 轮流机器人索引
let botIndex = 0;

// 初始化多机器人
const bots = BOT_TOKENS.map(token => new Bot(token));

// webhook 路径
bots.forEach(bot => {
  const webhookPath = `/bot${bot.token}`;
  app.post(webhookPath, (req, res) => {
    bot.handleUpdate(req.body).then(() => res.sendStatus(200));
  });

  // 处理群消息
  bot.on("message", async ctx => {
    const msg = ctx.message;
    if (!msg) return;

    // 私聊管理员，记录 admin
    if (msg.chat.type === "private") {
      adminSet.add(msg.from.id);
      return;
    }

    // 只处理目标群
    if (msg.chat.id !== GROUP_ID) return;

    const userId = msg.from.id;
    if (!nickMap.has(userId)) nickMap.set(userId, generateNick());

    const text = msg.text || msg.caption || "";
    const containsBanned = bannedWords.some(w => text.toLowerCase().includes(w.toLowerCase()));
    const containsLinkOrAt = /\bhttps?:\/\/|@/.test(text);

    if (containsBanned || containsLinkOrAt) {
      // 删除群消息
      try { await ctx.deleteMessage(); } catch(e){}

      // 保存审批记录
      pendingMessages.set(msg.message_id, {text, senderId: userId, handled: false});

      // 通知所有管理员
      for (const adminId of adminSet) {
        try {
          await bot.api.sendMessage(adminId,
            `${nickMap.get(userId)} 发送了违规消息，请审批:\n${text}`,
            {
              reply_markup: new InlineKeyboard()
                .text("同意", `approve_${msg.message_id}`)
                .text("拒绝", `reject_${msg.message_id}`)
            });
        } catch(e){ /* 私聊失败忽略 */ }
      }
    }
  });

  // 处理审批回调
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data;
    const [action, msgIdStr] = data.split("_");
    const msgId = parseInt(msgIdStr);
    const pending = pendingMessages.get(msgId);
    if (!pending || pending.handled) {
      return ctx.answerCallbackQuery("此消息已处理");
    }

    if (action === "approve") {
      // 匿名转发
      const botToUse = bots[botIndex];
      botIndex = (botIndex + 1) % bots.length;
      try {
        await botToUse.api.sendMessage(GROUP_ID, `${nickMap.get(pending.senderId)} ${pending.text}`);
      } catch(e){}

      pending.handled = true;
      pendingMessages.set(msgId, pending);
      ctx.editMessageReplyMarkup(new InlineKeyboard().text("已处理", "done"));
      ctx.answerCallbackQuery("已同意并匿名转发");
    } else if (action === "reject") {
      pending.handled = true;
      pendingMessages.set(msgId, pending);
      ctx.editMessageReplyMarkup(new InlineKeyboard().text("已处理", "done"));
      ctx.answerCallbackQuery("已拒绝");
    }
  });
});

// Render Webhook 设置
app.get("/", (req,res) => res.send("Bot is running"));
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  bots.forEach(bot => bot.api.setWebhook(`${RENDER_EXTERNAL_URL}/bot${bot.token}`));
});
