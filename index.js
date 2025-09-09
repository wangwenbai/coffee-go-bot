import express from "express";
import fs from "fs";
import path from "path";
import { Bot, InlineKeyboard } from "grammy";

// ---- 环境变量 ----
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const GROUP_ID = process.env.GROUP_ID;
const NICK_PREFIX = process.env.NICK_PREFIX || "匿名";
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

// ---- 全局状态 ----
const bots = [];
const userMap = new Map(); // chat_id -> nick
const nickSet = new Set(); // 用于唯一匿名码
const adminSet = new Set(); // 已私聊管理员
let bannedWords = [];

// ---- 屏蔽词加载 ----
const BLOCKED_FILE = path.join(process.cwd(), "blocked.txt");
function loadBannedWords() {
  if (fs.existsSync(BLOCKED_FILE)) {
    bannedWords = fs.readFileSync(BLOCKED_FILE, "utf-8")
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);
    console.log("✅ 屏蔽词已加载：", bannedWords);
  }
}
loadBannedWords();
setInterval(loadBannedWords, 60 * 1000); // 每分钟刷新

// ---- 匿名码生成 ----
function generateNick() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  while (true) {
    const arr = [
      chars[Math.floor(Math.random() * 26)],
      chars[Math.floor(Math.random() * 26)],
      digits[Math.floor(Math.random() * 10)],
      digits[Math.floor(Math.random() * 10)],
    ];
    arr.sort(() => Math.random() - 0.5);
    const nick = `${NICK_PREFIX}${arr.join("")}`;
    if (!nickSet.has(nick)) {
      nickSet.add(nick);
      return nick;
    }
  }
}

// ---- 初始化 Bot ----
BOT_TOKENS.forEach(token => {
  const bot = new Bot(token, { polling: false });
  bots.push(bot);

  bot.on("message", async ctx => {
    const msg = ctx.message;
    if (!msg || msg.chat.id.toString() !== GROUP_ID) return;

    const chatId = msg.from.id;

    // 分配匿名码
    if (!userMap.has(chatId)) {
      const nick = generateNick();
      userMap.set(chatId, nick);
    }
    const nick = userMap.get(chatId);

    // 消息内容
    const text = msg.text || "";
    const hasLinkOrMention = text.includes("http") || text.includes("@");
    const hasBannedWord = bannedWords.some(word => text.toLowerCase().includes(word.toLowerCase()));

    if (hasLinkOrMention || hasBannedWord) {
      // 删除消息
      try { await ctx.deleteMessage(); } catch {}
      
      // 通知管理员
      for (const adminId of adminSet) {
        try {
          await ctx.api.sendMessage(adminId,
            `${nick} 发送了一条可能违规的消息：\n${text}\n批准或拒绝？`,
            { reply_markup: new InlineKeyboard()
                .text("✅ 批准", `approve_${msg.message_id}`)
                .text("❌ 拒绝", `reject_${msg.message_id}`) }
          );
        } catch {}
      }
      return;
    }

    // 正常消息匿名转发
    const index = Math.floor(Math.random() * bots.length);
    const forwardBot = bots[index];
    const caption = `【${nick}】 ${text}`;
    try { await forwardBot.api.sendMessage(GROUP_ID, caption); } catch {}
  });

  // 处理管理员按钮
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data;
    const [action, msgId] = data.split("_");
    const originalMsg = await ctx.api.getChatMessage(GROUP_ID, parseInt(msgId));
    const chatId = originalMsg.from.id;
    const nick = userMap.get(chatId);

    if (action === "approve") {
      const index = Math.floor(Math.random() * bots.length);
      const forwardBot = bots[index];
      const caption = `【${nick}】 ${originalMsg.text}`;
      try { await forwardBot.api.sendMessage(GROUP_ID, caption); } catch {}
      await ctx.editMessageText("已批准 ✅");
    } else if (action === "reject") {
      await ctx.editMessageText("已拒绝 ❌");
    }
  });
});

// ---- Webhook 配置 ----
const app = express();
app.use(express.json());
bots.forEach(bot => {
  app.post(`/bot${bot.token}`, (req, res) => {
    bot.handleUpdate(req.body).then(() => res.sendStatus(200));
  });
});

// ---- 管理员识别 ----
app.post("/register_admin", async (req, res) => {
  const { user_id } = req.body;
  adminSet.add(user_id);
  res.send({ ok: true });
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  // 设置 webhook
  bots.forEach(async bot => {
    try {
      await bot.api.setWebhook(`${RENDER_EXTERNAL_URL}/bot${bot.token}`);
    } catch (err) {
      console.error("Webhook 设置失败", err);
    }
  });
});
