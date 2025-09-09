import express from "express";
import { Bot } from "grammy";
import fs from "fs";
import path from "path";

// 环境变量
const BOT_TOKENS = process.env.BOT_TOKENS?.split(",").map(t => t.trim()).filter(Boolean) || [];
const GROUP_ID = Number(process.env.GROUP_ID);
const NICK_PREFIX = process.env.NICK_PREFIX || "#";
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

// 存储屏蔽词
let blockedWords = [];
function loadBlockedWords() {
  try {
    const filePath = path.resolve("blocked.txt");
    if (fs.existsSync(filePath)) {
      blockedWords = fs.readFileSync(filePath, "utf-8")
        .split("\n")
        .map(w => w.trim())
        .filter(Boolean);
      console.log("屏蔽词更新:", blockedWords);
    }
  } catch (err) {
    console.error("读取 blocked.txt 出错:", err);
  }
}
loadBlockedWords();
setInterval(loadBlockedWords, 60 * 1000);

// 保存用户匿名码 & 管理员列表 & 待审核消息
const userNicks = new Map(); // userId -> nick
const adminIds = new Set();
const pendingApprovals = new Map(); // msgId -> { fromUser, text, media, adminMessages: Map }

function generateNick() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `${NICK_PREFIX}${code}`;
}

async function loadGroupAdmins(bot) {
  try {
    const admins = await bot.api.getChatAdministrators(GROUP_ID);
    adminIds.clear();
    for (const a of admins) {
      if (a.user) adminIds.add(a.user.id);
    }
    console.log("管理员列表更新:", Array.from(adminIds));
  } catch (err) {
    console.error("获取管理员失败:", err);
  }
}

// 处理群消息
async function handleGroupMessage(ctx, bot) {
  const msg = ctx.message;
  const userId = msg.from?.id;
  const messageId = msg.message_id;

  // 匿名管理员（群身份发的）不处理
  if (msg.sender_chat && msg.sender_chat.id === GROUP_ID) return;

  // 管理员消息不处理
  if (adminIds.has(userId)) return;

  // 生成或获取匿名码
  if (!userNicks.has(userId)) {
    userNicks.set(userId, generateNick());
  }
  const nick = userNicks.get(userId);

  const text = msg.text || msg.caption || "";
  const hasLinkOrMention = /(https?:\/\/|t\.me|@[\w\d_]+)/i.test(text);
  const hasBlocked = blockedWords.some(w => text.toLowerCase().includes(w.toLowerCase()));

  // 违规消息 → 删除 + 通知管理员
  if (hasLinkOrMention || hasBlocked) {
    try {
      await ctx.api.deleteMessage(GROUP_ID, messageId);
    } catch (err) {
      console.error("删除违规消息失败:", err.description);
    }

    const notifyText = `⚠️ 检测到违规内容\n` +
      `👤 用户: ${msg.from?.first_name || ""} (@${msg.from?.username || "无"}) [${msg.from?.id}]\n` +
      `📛 匿名码: ${nick}\n\n` +
      `📝 内容: ${text || "[非文字内容]"}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ 同意转发", callback_data: `approve:${messageId}` },
          { text: "❌ 拒绝转发", callback_data: `reject:${messageId}` }
        ]
      ]
    };

    pendingApprovals.set(messageId, {
      fromUser: msg.from,
      text,
      fullMessage: msg,
      nick,
      adminMessages: new Map()
    });

    for (let adminId of adminIds) {
      try {
        const sentMsg = await ctx.api.sendMessage(adminId, notifyText, { reply_markup: keyboard });
        pendingApprovals.get(messageId).adminMessages.set(adminId, sentMsg.message_id);
      } catch (err) {
        console.error("通知管理员失败:", err.description);
      }
    }
    return;
  }

  // 正常消息 → 删除并匿名转发
  try {
    await ctx.api.deleteMessage(GROUP_ID, messageId);
  } catch (err) {
    console.error("删除消息失败:", err.description);
  }

  try {
    await forwardAnonymous(bot, msg, nick);
  } catch (err) {
    console.error("匿名转发失败:", err.description);
  }
}

// 匿名转发（支持所有类型）
async function forwardAnonymous(bot, msg, nick) {
  const opts = { caption: msg.caption ? `${nick}: ${msg.caption}` : nick };

  if (msg.text) {
    await bot.api.sendMessage(GROUP_ID, `${nick}: ${msg.text}`);
  } else if (msg.photo) {
    await bot.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, opts);
  } else if (msg.video) {
    await bot.api.sendVideo(GROUP_ID, msg.video.file_id, opts);
  } else if (msg.document) {
    await bot.api.sendDocument(GROUP_ID, msg.document.file_id, opts);
  } else if (msg.sticker) {
    await bot.api.sendSticker(GROUP_ID, msg.sticker.file_id);
  } else if (msg.voice) {
    await bot.api.sendVoice(GROUP_ID, msg.voice.file_id, opts);
  } else if (msg.audio) {
    await bot.api.sendAudio(GROUP_ID, msg.audio.file_id, opts);
  } else if (msg.animation) {
    await bot.api.sendAnimation(GROUP_ID, msg.animation.file_id, opts);
  } else {
    await bot.api.sendMessage(GROUP_ID, `${nick}: [不支持的消息类型]`);
  }
}

// 审批处理
async function handleApproval(ctx, action, msgId) {
  const pending = pendingApprovals.get(Number(msgId));
  if (!pending) {
    return ctx.answerCallbackQuery({ text: "该请求已处理过", show_alert: true });
  }

  if (action === "approve") {
    await forwardAnonymous(ctx.api, pending.fullMessage, pending.nick);
  }

  // 更新所有管理员的通知消息
  for (let [adminId, adminMsgId] of pending.adminMessages) {
    try {
      await ctx.api.editMessageReplyMarkup(adminId, adminMsgId, {
        inline_keyboard: [[{ text: action === "approve" ? "✅ 已同意" : "❌ 已拒绝", callback_data: "done" }]]
      });
    } catch {}
  }

  pendingApprovals.delete(Number(msgId));
  await ctx.answerCallbackQuery({ text: "操作成功" });
}

// 启动多个 bot
const bots = BOT_TOKENS.map(token => {
  const bot = new Bot(token);

  bot.on("message", async ctx => handleGroupMessage(ctx, bot));

  bot.on("callback_query:data", async ctx => {
    const [action, msgId] = ctx.callbackQuery.data.split(":");
    if (action === "approve" || action === "reject") {
      await handleApproval(ctx, action, msgId);
    }
  });

  loadGroupAdmins(bot);

  return bot;
});

// Express server
const app = express();
app.use(express.json());

app.post("/webhook/:token", (req, res) => {
  const bot = bots.find(b => b.token === req.params.token);
  if (!bot) return res.sendStatus(404);
  bot.handleUpdate(req.body, res);
});

app.listen(PORT, async () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);

  for (const bot of bots) {
    if (BASE_URL) {
      const url = `${BASE_URL}/webhook/${bot.token}`;
      await bot.api.setWebhook(url);
      console.log(`Webhook 已设置: ${url}`);
    } else {
      bot.start();
      console.log("使用 Long Polling 模式");
    }
  }
});
