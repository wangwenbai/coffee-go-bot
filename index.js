import express from "express";
import fs from "fs";
import { Bot, InlineKeyboard } from "grammy";
import path from "path";

// 读取配置
const TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((id) => id.trim());

const bot = new Bot(TOKEN);

// 保存用户编号映射
const userMap = new Map();

// 屏蔽词文件路径
const BLOCKED_FILE = path.resolve("blocked.txt");
let blockedWords = [];

// 加载屏蔽词
function loadBlockedWords() {
  if (fs.existsSync(BLOCKED_FILE)) {
    const text = fs.readFileSync(BLOCKED_FILE, "utf8");
    blockedWords = text
      .split(",")
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    console.log("Blocked keywords loaded:", blockedWords.length);
  } else {
    console.log("No blocked.txt found, skipping load.");
  }
}
loadBlockedWords();

// 热更新屏蔽词
fs.watchFile(BLOCKED_FILE, () => {
  console.log("blocked.txt updated, reloading...");
  loadBlockedWords();
});

// 生成随机 5 位数编号
function getAnonId(userId) {
  if (!userMap.has(userId)) {
    const randomId = Math.floor(10000 + Math.random() * 90000);
    userMap.set(userId, `User ${randomId}`);
  }
  return userMap.get(userId);
}

// 检查是否触及屏蔽词
function containsBlockedWord(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return blockedWords.some((w) => lower.includes(w));
}

// 检查是否包含链接或 @
function containsLinkOrMention(text) {
  if (!text) return false;
  return /(https?:\/\/|www\.)/.test(text) || /@[\w_]+/.test(text);
}

// 处理用户消息
bot.on("message", async (ctx) => {
  const msg = ctx.message;

  // 跳过频道推送的消息（保留评论按钮）
  if (msg.is_automatic_forward) {
    return;
  }

  // 群管理员消息 -> 不删除、不匿名
  const member = await ctx.getChatMember(ctx.from.id);
  if (["creator", "administrator"].includes(member.status)) {
    return;
  }

  // 检查屏蔽词
  const text = msg.text || msg.caption || "";
  if (containsBlockedWord(text)) {
    try {
      await ctx.deleteMessage();
    } catch {}
    return;
  }

  // 检查链接/@ -> 进入审核流程
  if (containsLinkOrMention(text)) {
    try {
      await ctx.deleteMessage();
    } catch {}
    const anonId = getAnonId(ctx.from.id);

    // 给管理员发送审核请求
    for (const adminId of ADMIN_IDS) {
      try {
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `approve:${ctx.chat.id}:${ctx.from.id}:${msg.message_id}`)
          .text("❌ Reject", `reject:${ctx.chat.id}:${ctx.from.id}:${msg.message_id}`);

        await bot.api.sendMessage(
          adminId,
          `Message from ${anonId} requires review:\n\n${text}`,
          { reply_markup: keyboard }
        );
      } catch (err) {
        console.error("Failed to notify admin", err.message);
      }
    }
    return;
  }

  // 普通消息 -> 匿名转发
  try {
    await ctx.deleteMessage();
  } catch {}
  const anonId = getAnonId(ctx.from.id);

  // 处理多媒体+文字
  if (msg.photo) {
    await bot.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, {
      caption: `${anonId}: ${msg.caption || ""}`,
    });
  } else if (msg.video) {
    await bot.api.sendVideo(GROUP_ID, msg.video.file_id, {
      caption: `${anonId}: ${msg.caption || ""}`,
    });
  } else if (msg.document) {
    await bot.api.sendDocument(GROUP_ID, msg.document.file_id, {
      caption: `${anonId}: ${msg.caption || ""}`,
    });
  } else if (msg.sticker) {
    await bot.api.sendSticker(GROUP_ID, msg.sticker.file_id);
  } else if (msg.voice) {
    await bot.api.sendVoice(GROUP_ID, msg.voice.file_id, {
      caption: `${anonId}`,
    });
  } else if (msg.audio) {
    await bot.api.sendAudio(GROUP_ID, msg.audio.file_id, {
      caption: `${anonId}: ${msg.caption || ""}`,
    });
  } else if (msg.video_note) {
    await bot.api.sendVideoNote(GROUP_ID, msg.video_note.file_id);
  } else if (msg.location) {
    await bot.api.sendLocation(GROUP_ID, msg.location.latitude, msg.location.longitude);
  } else if (msg.poll) {
    await bot.api.sendPoll(GROUP_ID, msg.poll.question, msg.poll.options.map((o) => o.text));
  } else {
    await bot.api.sendMessage(GROUP_ID, `${anonId}: ${text}`);
  }
});

// 处理管理员审核按钮
bot.on("callback_query:data", async (ctx) => {
  const [action, chatId, userId, msgId] = ctx.callbackQuery.data.split(":");
  const fromId = String(ctx.from.id);

  if (!ADMIN_IDS.includes(fromId)) {
    return ctx.answerCallbackQuery({ text: "Only admins can act.", show_alert: true });
  }

  const anonId = getAnonId(userId);

  if (action === "approve") {
    // 审核通过 -> 匿名转发
    const originalText = ctx.callbackQuery.message.text.split("\n\n")[1] || "";
    await bot.api.sendMessage(chatId, `${anonId}: ${originalText}`);
    await ctx.editMessageText(`✅ Processed: ${originalText}`, {
      reply_markup: new InlineKeyboard().text("Processed"),
    });
  } else if (action === "reject") {
    await ctx.editMessageText(`❌ Rejected`, {
      reply_markup: new InlineKeyboard().text("Processed"),
    });
  }

  await ctx.answerCallbackQuery({ text: "Done" });
});

// Express + Webhook
const app = express();
app.use(express.json());

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res).catch((err) => console.error(err));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Listening on port ${PORT}`);
  try {
    await bot.api.deleteWebhook();
    await bot.api.setWebhook(`https://${process.env.RENDER_EXTERNAL_URL}/bot${TOKEN}`);
    console.log("Webhook set");
  } catch (err) {
    console.error("Failed to set webhook", err.message);
  }
});
