import express from "express";
import fs from "fs";
import { Bot, InlineKeyboard } from "grammy";

// 读取环境变量
const TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID; // 目标群 ID
const PUBLIC_URL = process.env.PUBLIC_URL; // 你在 Render 配置的公网 URL

if (!TOKEN || !GROUP_ID || !PUBLIC_URL) {
  console.error("❌ Missing BOT_TOKEN, GROUP_ID or PUBLIC_URL in environment variables!");
  process.exit(1);
}

const bot = new Bot(TOKEN);
const app = express();

// ========= 屏蔽词 =========
let blockedWords = [];
function loadBlockedWords() {
  try {
    const data = fs.readFileSync("blocked.txt", "utf8");
    blockedWords = data.split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
    console.log(`Blocked keywords loaded: ${blockedWords.length}`);
  } catch (err) {
    console.error("Failed to load blocked.txt:", err.message);
    blockedWords = [];
  }
}
loadBlockedWords();

// ========= 审核存储 =========
const pendingReviews = new Map(); // key: reviewId

// ========= 获取管理员 =========
async function getAdmins() {
  try {
    const admins = await bot.api.getChatAdministrators(GROUP_ID);
    return admins.map(a => a.user);
  } catch (err) {
    console.error("Failed to fetch admins:", err.message);
    return [];
  }
}

// ========= 检查屏蔽词 =========
function containsBlockedWord(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return blockedWords.some(word => lower.includes(word));
}

// ========= 审核逻辑 =========
async function sendToAdminsForReview(originalMsg) {
  const admins = await getAdmins();
  if (!admins.length) return;

  const reviewId = Date.now().toString();
  pendingReviews.set(reviewId, {
    originalMsg,
    handled: false,
  });

  for (const admin of admins) {
    try {
      const kb = new InlineKeyboard()
        .text("✅ Approve", `approve:${reviewId}`)
        .text("❌ Reject", `reject:${reviewId}`);

      await bot.api.sendMessage(admin.id, `Review needed:\n\n${originalMsg.text || "[Media message]"}`, {
        reply_markup: kb,
      });
    } catch (err) {
      console.error(`Failed to send private review to ${admin.id}:`, err.message);
    }
  }
}

// ========= 处理消息 =========
bot.on("message", async (ctx) => {
  const msg = ctx.message;

  // 管理员消息：直接转发，不屏蔽
  try {
    const member = await ctx.api.getChatMember(GROUP_ID, msg.from.id);
    if (member.status === "administrator" || member.status === "creator") {
      return; // 管理员消息放行
    }
  } catch (err) {
    console.error("Check admin failed:", err.message);
  }

  // 检查屏蔽词
  const textContent = msg.text || msg.caption || "";
  if (containsBlockedWord(textContent)) {
    try {
      await ctx.deleteMessage();
    } catch {}
    return;
  }

  // 检查链接或 @username
  const entities = msg.entities || msg.caption_entities || [];
  const hasLink = entities.some(e =>
    e.type === "url" ||
    e.type === "text_link" ||
    (e.type === "mention")
  );

  if (hasLink) {
    try {
      await ctx.deleteMessage();
    } catch {}
    await sendToAdminsForReview(msg);
    return;
  }

  // 其他普通消息：匿名转发
  try {
    await ctx.deleteMessage();
    if (msg.text) {
      await bot.api.sendMessage(GROUP_ID, msg.text);
    } else if (msg.photo) {
      await bot.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, {
        caption: msg.caption || undefined,
      });
    } else if (msg.video) {
      await bot.api.sendVideo(GROUP_ID, msg.video.file_id, {
        caption: msg.caption || undefined,
      });
    }
  } catch (err) {
    console.error("Forward failed:", err.message);
  }
});

// ========= 审核回调 =========
bot.on("callback_query:data", async (ctx) => {
  const [action, reviewId] = ctx.callbackQuery.data.split(":");
  const review = pendingReviews.get(reviewId);

  if (!review || review.handled) {
    return ctx.answerCallbackQuery({ text: "Already handled", show_alert: false });
  }

  // 确认操作者是否管理员
  try {
    const member = await ctx.api.getChatMember(GROUP_ID, ctx.from.id);
    if (member.status !== "administrator" && member.status !== "creator") {
      return ctx.answerCallbackQuery({ text: "Not authorized", show_alert: true });
    }
  } catch {
    return ctx.answerCallbackQuery({ text: "Check failed", show_alert: true });
  }

  review.handled = true;

  if (action === "approve") {
    const msg = review.originalMsg;
    try {
      if (msg.text) {
        await bot.api.sendMessage(GROUP_ID, msg.text);
      } else if (msg.photo) {
        await bot.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, {
          caption: msg.caption || undefined,
        });
      } else if (msg.video) {
        await bot.api.sendVideo(GROUP_ID, msg.video.file_id, {
          caption: msg.caption || undefined,
        });
      }
    } catch (err) {
      console.error("Send approved failed:", err.message);
    }
  }

  // 编辑所有管理员的按钮为 "Processed"
  const admins = await getAdmins();
  for (const admin of admins) {
    try {
      await ctx.api.editMessageReplyMarkup(admin.id, ctx.callbackQuery.message.message_id, {
        reply_markup: new InlineKeyboard().text("✔ Processed", "noop"),
      });
    } catch (err) {
      console.error("Failed to update admin msg:", err.message);
    }
  }

  await ctx.answerCallbackQuery({ text: "Processed" });
});

// ========= Webhook =========
app.use(express.json());
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Listening on port ${PORT}`);
  try {
    await bot.api.setWebhook(`${PUBLIC_URL}/bot${TOKEN}`);
    console.log("Webhook set to", `${PUBLIC_URL}/bot${TOKEN}`);
  } catch (err) {
    console.error("Failed to set webhook:", err.message);
  }
});
