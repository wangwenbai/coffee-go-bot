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
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

// =====================
// 屏蔽词
// =====================
let blockedWords = [];
function loadBlockedWords() {
  if (fs.existsSync("./blocked.txt")) {
    blockedWords = fs
      .readFileSync("./blocked.txt", "utf-8")
      .split(/\r?\n/)
      .map(w => w.trim())
      .filter(Boolean);
    console.log("✅ 屏蔽词已加载：", blockedWords);
  }
}
loadBlockedWords();
setInterval(loadBlockedWords, 60_000);

// =====================
// 匿名昵称
// =====================
const nickMap = new Map();
function generateNick(userId) {
  if (nickMap.has(userId)) return nickMap.get(userId);
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = Array.from({ length: 4 }, () =>
    letters[Math.floor(Math.random() * letters.length)]
  ).join("");
  const nick = `【${NICK_PREFIX}${code}】`;
  nickMap.set(userId, nick);
  return nick;
}

// =====================
// 管理员
// =====================
let adminIds = new Set();
async function loadGroupAdmins(bot) {
  try {
    const res = await bot.api.getChatAdministrators(GROUP_ID);
    adminIds = new Set(res.map(r => r.user.id));
    console.log("✅ 管理员已更新：", [...adminIds]);
  } catch (e) {
    console.error("❌ 获取管理员失败", e.message);
  }
}

// =====================
// 审批存储
// =====================
const pendingApprovals = new Map(); // msgId => { user, text, adminMessages }

// =====================
// 转发消息（支持所有类型）
// =====================
async function forwardMessage(bot, msg, nick) {
  const caption = msg.caption ? `${nick} ${msg.caption}` : nick;
  if (msg.text) {
    await bot.api.sendMessage(GROUP_ID, `${nick} ${msg.text}`);
  } else if (msg.photo) {
    await bot.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, {
      caption,
    });
  } else if (msg.video) {
    await bot.api.sendVideo(GROUP_ID, msg.video.file_id, { caption });
  } else if (msg.document) {
    await bot.api.sendDocument(GROUP_ID, msg.document.file_id, { caption });
  } else if (msg.sticker) {
    await bot.api.sendSticker(GROUP_ID, msg.sticker.file_id);
  } else if (msg.voice) {
    await bot.api.sendVoice(GROUP_ID, msg.voice.file_id, { caption });
  } else if (msg.audio) {
    await bot.api.sendAudio(GROUP_ID, msg.audio.file_id, { caption });
  } else {
    await bot.api.sendMessage(GROUP_ID, `${nick} [不支持的消息类型]`);
  }
}

// =====================
// 处理群消息
// =====================
async function handleGroupMessage(ctx, bot) {
  const msg = ctx.message;
  const userId = msg.from?.id;

  // 匿名管理员消息（sender_chat == 群 ID）
  if (msg.sender_chat && msg.sender_chat.id === GROUP_ID) return;

  // 普通管理员消息
  if (adminIds.has(userId)) return;

  const text = msg.text || msg.caption || "";
  const nick = generateNick(userId);

  // 违规检查
  const hasLinkOrMention = /\bhttps?:\/\/\S+|\@\w+/i.test(text);
  const hasBlockedWord = blockedWords.some(w =>
    text.toLowerCase().includes(w.toLowerCase())
  );

  if (hasLinkOrMention || hasBlockedWord) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
    } catch (e) {
      console.error("删除违规消息失败：", e.description);
    }

    // 通知管理员
    const fromUser = msg.from;
    const fullName = [fromUser.first_name, fromUser.last_name]
      .filter(Boolean)
      .join(" ");
    const username = fromUser.username ? `@${fromUser.username}` : "无";
    const notifyText = `🚨 违规消息待审核\n\n用户信息:\n昵称: ${fullName}\n用户名: ${username}\n用户ID: ${fromUser.id}\n\n消息内容:\n${text}`;

    const keyboard = new InlineKeyboard()
      .text("✅ 同意", `approve:${msg.message_id}`)
      .text("❌ 拒绝", `reject:${msg.message_id}`);

    const record = { user: fromUser, msg, nick, adminMessages: new Map() };
    for (let adminId of adminIds) {
      try {
        const sent = await ctx.api.sendMessage(adminId, notifyText, {
          reply_markup: keyboard,
        });
        record.adminMessages.set(adminId, sent.message_id);
      } catch {}
    }
    pendingApprovals.set(String(msg.message_id), record);
    return;
  }

  // 正常消息：删除并匿名转发
  try {
    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
  } catch (e) {
    console.error("删除消息失败：", e.description);
  }
  await forwardMessage(bot, msg, nick);
}

// =====================
// 审批
// =====================
async function handleApproval(ctx, action, msgId) {
  const pending = pendingApprovals.get(msgId);
  if (!pending) return;

  // 更新所有管理员的通知
  for (let [adminId, adminMsgId] of pending.adminMessages) {
    try {
      await ctx.api.editMessageReplyMarkup(adminId, adminMsgId, {
        inline_keyboard: [[
          {
            text: action === "approve" ? "✅ 已同意" : "❌ 已拒绝",
            callback_data: "done",
          },
        ]],
      });
    } catch {}
  }

  if (action === "approve") {
    const bot = ctx.me; // 当前 bot
    await forwardMessage(ctx.api, pending.msg, pending.nick);
  }

  pendingApprovals.delete(msgId);
  await ctx.answerCallbackQuery();
}

// =====================
// 启动机器人
// =====================
const bots = await Promise.all(
  BOT_TOKENS.map(async token => {
    const bot = new Bot(token);

    bot.on("message", async ctx => handleGroupMessage(ctx, bot));

    bot.on("callback_query:data", async ctx => {
      const [action, msgId] = ctx.callbackQuery.data.split(":");
      if (["approve", "reject"].includes(action)) {
        await handleApproval(ctx, action, msgId);
      }
    });

    await bot.init();
    await loadGroupAdmins(bot);
    return bot;
  })
);

// 定时刷新管理员
setInterval(() => bots.forEach(loadGroupAdmins), 10 * 60 * 1000);

// =====================
// Webhook 服务
// =====================
const app = express();
app.use(express.json());

app.post("/webhook/:token", async (req, res) => {
  const token = req.params.token;
  const bot = bots.find(b => b.token === token);
  if (bot) {
    try {
      await bot.handleUpdate(req.body);
    } catch (e) {
      console.error("处理 update 失败：", e);
    }
  }
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  for (const bot of bots) {
    if (BASE_URL) {
      const url = `${BASE_URL}/webhook/${bot.token}`;
      try {
        await bot.api.setWebhook(url);
        console.log(`Webhook 已设置: ${url}`);
      } catch (e) {
        console.error("设置 Webhook 失败:", e);
      }
    } else {
      bot.start();
      console.log("使用 Long Polling 模式");
    }
  }
});
