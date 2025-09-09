import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";

// =====================
// 环境变量
// =====================
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const GROUP_ID = Number(process.env.GROUP_ID);
const NICK_PREFIX = process.env.NICK_PREFIX || "#";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL + "/webhook";

// =====================
// 屏蔽词
// =====================
let blockedWords = [];
function loadBlockedWords() {
  if (fs.existsSync("./blocked.txt")) {
    blockedWords = fs.readFileSync("./blocked.txt", "utf-8")
      .split(/\r?\n/)
      .map(w => w.trim())
      .filter(Boolean);
    console.log("✅ 屏蔽词已加载:", blockedWords);
  }
}
loadBlockedWords();
setInterval(loadBlockedWords, 60_000);

// =====================
// 匿名昵称生成
// =====================
const nickMap = new Map(); // userId -> nickname
const usedCodes = new Set();
function generateNick(userId) {
  if (nickMap.has(userId)) return nickMap.get(userId);

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  while (true) {
    let code = Array.from({ length: 4 }, () =>
      letters.charAt(Math.floor(Math.random() * letters.length))
    ).join("");
    if (!usedCodes.has(code)) {
      usedCodes.add(code);
      const nick = `【${NICK_PREFIX}${code}】`;
      nickMap.set(userId, nick);
      return nick;
    }
  }
}
function releaseNick(userId) {
  if (nickMap.has(userId)) {
    const nick = nickMap.get(userId);
    const code = nick.slice(NICK_PREFIX.length + 1, -1);
    usedCodes.delete(code);
    nickMap.delete(userId);
    console.log(`🔹 匿名码释放: ${nick} (${userId})`);
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
// 管理员缓存
// =====================
const adminIds = new Set();
async function loadGroupAdmins(bot) {
  try {
    const admins = await bot.api.getChatAdministrators(GROUP_ID);
    adminIds.clear();
    for (const a of admins) adminIds.add(a.user.id);
    console.log("✅ 管理员列表更新:", [...adminIds]);
  } catch (e) {
    console.error("❌ 获取管理员失败:", e.message);
  }
}

// =====================
// 违规消息处理
// =====================
const pendingReviews = new Map(); // reviewId -> { user, msg, adminMsgIds }

// =====================
// 已处理消息标记
// =====================
const processedMessages = new Set();

// =====================
// 消息处理
// =====================
async function handleMessage(ctx) {
  const msg = ctx.message;
  if (!msg || !msg.from) return;

  const msgKey = `${msg.chat.id}_${msg.message_id}`;
  if (processedMessages.has(msgKey)) return;
  processedMessages.add(msgKey);

  if (msg.from.is_bot) return;

  const userId = msg.from.id;
  const nick = generateNick(userId);

  // 管理员消息不处理
  if (adminIds.has(userId)) return;

  const text = msg.text || msg.caption || "";
  const hasLinkOrMention = /\bhttps?:\/\/\S+|\@\w+/i.test(text);
  const hasBlockedWord = blockedWords.some(word =>
    text.toLowerCase().includes(word.toLowerCase())
  );

  if (hasLinkOrMention || hasBlockedWord) {
    try { await ctx.api.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}

    const reviewId = `${msg.chat.id}_${msg.message_id}`;
    const adminMsgIds = [];

    pendingReviews.set(reviewId, { user: msg.from, msg, adminMsgIds });

    for (const adminId of adminIds) {
      try {
        const kb = new InlineKeyboard()
          .text("✅ 同意", `approve_${reviewId}`)
          .text("❌ 拒绝", `reject_${reviewId}`);
        const m = await ctx.api.sendMessage(
          adminId,
          `⚠️ 用户违规消息待审核\n\n👤 用户: ${msg.from.first_name} (${msg.from.username ? '@'+msg.from.username : '无用户名'})\n🆔 ID: ${msg.from.id}\n\n内容: ${text}`,
          { reply_markup: kb }
        );
        adminMsgIds.push(m.message_id);
      } catch (e) {}
    }
    return;
  }

  // 正常消息：删除 + 匿名转发
  try { await ctx.api.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}

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
}

// =====================
// 管理员审核回调
// =====================
bots.forEach(bot => {
  bot.on("callback_query", async ctx => {
    const data = ctx.callbackQuery.data;
    const match = data.match(/^(approve|reject)_(.+)$/);
    if (!match) return;
    const [_, action, reviewId] = match;

    const review = pendingReviews.get(reviewId);
    if (!review) return ctx.answerCallbackQuery({ text: "该消息已处理或过期", show_alert: true });

    const { user, msg, adminMsgIds } = review;
    pendingReviews.delete(reviewId);

    // 更新所有管理员按钮 -> 已处理
    for (const adminId of adminIds) {
      for (const messageId of adminMsgIds) {
        try {
          await ctx.api.editMessageReplyMarkup(adminId, messageId, {
            inline_keyboard: [
              [{ text: action === "approve" ? "✅ 已同意" : "❌ 已拒绝", callback_data: "done" }]
            ]
          });
        } catch (e) {}
      }
    }

    if (action === "approve") {
      const nick = generateNick(user.id);
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
        }
      } catch (e) {
        console.error("审核转发失败:", e.message);
      }
    }

    await ctx.answerCallbackQuery();
  });
});

// =====================
// 绑定消息事件
// =====================
bots.forEach(bot => {
  bot.on("message", handleMessage);
});

// =====================
// 监听退群释放匿名码
// =====================
bots.forEach(bot => {
  bot.on("my_chat_member", async ctx => {
    const chatId = ctx.chat?.id;
    if (chatId !== GROUP_ID) return;

    const oldStatus = ctx.myChatMember?.old_chat_member?.status;
    const newStatus = ctx.myChatMember?.new_chat_member?.status;
    const userId = ctx.myChatMember?.from?.id || ctx.myChatMember?.new_chat_member?.user?.id;

    if ((oldStatus !== 'left' && newStatus === 'left') || newStatus === 'kicked') {
      releaseNick(userId);
    }
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
      try { await bot.handleUpdate(update); } catch (e) { console.error(e.message); }
    }
  }
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  for (const bot of bots) {
    try {
      await bot.init();
      await bot.api.setWebhook(`${WEBHOOK_URL}`);
      await loadGroupAdmins(bot);
      console.log(`✅ Webhook 已设置: ${bot.botInfo.username}`);
    } catch (e) {
      console.error("❌ 设置Webhook失败:", e.message);
    }
  }
});
