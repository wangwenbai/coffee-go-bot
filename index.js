import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";
import path from "path";

const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const GROUP_ID = Number(process.env.GROUP_ID);
const NICK_PREFIX = process.env.NICK_PREFIX || "匿名";
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

const app = express();
app.use(express.json());

// 匿名码管理
const userMap = new Map(); // userId => nickname
const nicknameSet = new Set();

// 屏蔽词管理
let bannedWords = [];
const blockedFile = path.resolve("./blocked.txt");
function loadBlocked() {
  if (fs.existsSync(blockedFile)) {
    bannedWords = fs.readFileSync(blockedFile, "utf-8")
      .split("\n")
      .map(w => w.trim())
      .filter(Boolean);
    console.log("✅ 屏蔽词已加载：", bannedWords);
  }
}
loadBlocked();
setInterval(loadBlocked, 60 * 1000); // 每分钟刷新

// 初始化所有机器人
const bots = [];
await Promise.all(BOT_TOKENS.map(async token => {
  const bot = new Bot(token, { polling: false });
  await bot.init(); // Webhook 必须初始化
  bots.push(bot);
}));

// 多机器人轮流索引
let botIndex = 0;
function getNextBot() {
  const bot = bots[botIndex];
  botIndex = (botIndex + 1) % bots.length;
  return bot;
}

// 生成匿名昵称
function generateNickname(userId) {
  if (userMap.has(userId)) return userMap.get(userId);
  while (true) {
    const letters = [...Array(2)].map(() => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
    const digits = Math.floor(Math.random() * 100).toString().padStart(2, "0");
    const arr = [letters, digits].sort(() => Math.random() - 0.5).join("");
    const nick = `【${NICK_PREFIX}${arr}】`;
    if (!nicknameSet.has(nick)) {
      userMap.set(userId, nick);
      nicknameSet.add(nick);
      return nick;
    }
  }
}

// 检查是否违规
function isViolation(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasLinkOrMention = /\bhttps?:\/\/\S+|\@\w+/i.test(text);
  const hasBannedWord = bannedWords.some(w => lower.includes(w.toLowerCase()));
  return hasLinkOrMention || hasBannedWord;
}

// 管理员私聊列表
const adminSet = new Set(); // userId

// 保存待审批消息
const pendingMap = new Map(); // messageId => { userId, text, processed: false }

// 处理群消息
bots.forEach(bot => {
  bot.on("message", async ctx => {
    if (!ctx.chat || ctx.chat.id !== GROUP_ID) return;

    const text = ctx.message.text || "";
    const userId = ctx.message.from.id;
    const nick = generateNickname(userId);

    if (isViolation(text)) {
      // 删除违规消息
      try { await ctx.deleteMessage(); } catch {}
      // 保存待审批
      pendingMap.set(ctx.message.message_id, { userId, text, processed: false });

      // 通知所有已私聊过机器人管理员
      for (const adminId of adminSet) {
        try {
          await bot.api.sendMessage(adminId,
            `${nick} 发送了违规消息，请审批：\n内容: ${text}`,
            {
              reply_markup: new InlineKeyboard()
                .text("同意转发", `approve_${ctx.message.message_id}`)
                .text("拒绝转发", `reject_${ctx.message.message_id}`)
            });
        } catch (err) {
          // 忽略未私聊错误
        }
      }
    } else {
      // 正常转发匿名消息
      const forwardBot = getNextBot();
      try {
        await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${text}`);
      } catch {}
    }
  });

  // 处理管理员审批按钮
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data;
    if (!data) return;

    const [action, msgIdStr] = data.split("_");
    const msgId = Number(msgIdStr);
    if (!pendingMap.has(msgId)) {
      await ctx.answerCallbackQuery({ text: "消息已处理" });
      return;
    }
    const pending = pendingMap.get(msgId);
    if (pending.processed) {
      await ctx.answerCallbackQuery({ text: "消息已处理" });
      return;
    }

    if (action === "approve") {
      pending.processed = true;
      // 匿名转发
      const nick = userMap.get(pending.userId) || generateNickname(pending.userId);
      const forwardBot = getNextBot();
      try { await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${pending.text}`); } catch {}
      await ctx.editMessageReplyMarkup(new InlineKeyboard().text("已处理", "done"));
      pendingMap.delete(msgId);
      await ctx.answerCallbackQuery({ text: "已同意并转发" });
    } else if (action === "reject") {
      pending.processed = true;
      await ctx.editMessageReplyMarkup(new InlineKeyboard().text("已处理", "done"));
      pendingMap.delete(msgId);
      await ctx.answerCallbackQuery({ text: "已拒绝" });
    }
  });
});

// Webhook 路由
bots.forEach(bot => {
  app.post(`/bot${bot.token}`, async (req, res) => {
    try {
      await bot.handleUpdate(req.body);
      res.sendStatus(200);
    } catch (err) {
      console.error(err);
      res.sendStatus(500);
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
