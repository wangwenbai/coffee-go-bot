import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const bot = new Bot(process.env.BOT_TOKEN);
const app = express();
const port = process.env.PORT || 3000;

// 读取屏蔽词
let blockedKeywords = [];
try {
  blockedKeywords = fs.readFileSync("blocked.txt", "utf-8")
    .split(",")
    .map(k => k.trim().toLowerCase())
    .filter(k => k.length > 0);
  console.log(`Blocked keywords loaded: ${blockedKeywords.length}`);
} catch (err) {
  console.error("Failed to load blocked keywords:", err.message);
}

// 全局存储待审核消息
const pendingReviews = new Map();
const groupId = process.env.GROUP_ID;
const adminIds = process.env.ADMIN_IDS.split(",").map(id => id.trim());

// ---------------------
// 群消息处理
// ---------------------
bot.on("message", async ctx => {
  const msg = ctx.message;

  // 忽略私聊 & 机器人自己
  if (ctx.chat.type === "private" || ctx.from.is_bot) return;

  // 忽略频道自动转发的消息（避免删除评论按钮）
  if (msg.is_automatic_forward) return;

  // 判断是否管理员
  const member = await bot.api.getChatMember(groupId, ctx.from.id);
  const isAdmin = member.status === "administrator" || member.status === "creator";
  if (isAdmin) {
    return; // 管理员消息直接保留，不匿名也不检查屏蔽词
  }

  // 判断消息内容（文字、媒体 + caption）
  const text = msg.text || msg.caption || "";
  const containsBlocked = blockedKeywords.some(keyword =>
    text.toLowerCase().includes(keyword)
  );
  if (containsBlocked) {
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  // 删除原始消息
  await ctx.deleteMessage().catch(() => {});

  // 保存待审核
  const reviewId = `${msg.chat.id}_${msg.message_id}_${Date.now()}`;
  pendingReviews.set(reviewId, {
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    message: msg,
  });

  // 通知所有管理员私聊审核
  for (const adminId of adminIds) {
    try {
      const keyboard = new InlineKeyboard()
        .text("✅ Approve", `approve:${reviewId}`)
        .text("❌ Reject", `reject:${reviewId}`);
      await bot.api.sendMessage(
        adminId,
        `📩 New anonymous message pending review:\n\n${text || "[Media message]"}`,
        {
          reply_markup: keyboard,
        }
      );
    } catch (err) {
      console.error("Failed to send private review:", err.description);
    }
  }
});

// ---------------------
// 审核按钮处理
// ---------------------
bot.on("callback_query:data", async ctx => {
  const [action, reviewId] = ctx.callbackQuery.data.split(":");
  const review = pendingReviews.get(reviewId);

  if (!review) {
    await ctx.answerCallbackQuery({ text: "Already handled or not found", show_alert: true });
    return;
  }

  if (action === "approve") {
    try {
      // 转发完整消息（文字/图片/视频等）
      if (review.message.text) {
        await bot.api.sendMessage(groupId, review.message.text);
      } else if (review.message.photo) {
        await bot.api.sendPhoto(groupId, review.message.photo.slice(-1)[0].file_id, {
          caption: review.message.caption || "",
        });
      } else if (review.message.video) {
        await bot.api.sendVideo(groupId, review.message.video.file_id, {
          caption: review.message.caption || "",
        });
      } else if (review.message.document) {
        await bot.api.sendDocument(groupId, review.message.document.file_id, {
          caption: review.message.caption || "",
        });
      }
    } catch (err) {
      console.error("Failed to forward approved message:", err.description);
    }
  }

  // 更新所有管理员的审核消息 → "已处理"
  for (const adminId of adminIds) {
    try {
      await bot.api.editMessageText(
        adminId,
        ctx.callbackQuery.message.message_id,
        undefined,
        "✅ This request has been processed.",
        {
          reply_markup: new InlineKeyboard().text("✔️ Processed", "noop"),
        }
      );
    } catch (err) {
      console.error("Failed to edit notification message:", err.description);
    }
  }

  pendingReviews.delete(reviewId);
  await ctx.answerCallbackQuery({ text: "Processed" });
});

// ---------------------
// Express 服务 & Webhook
// ---------------------
app.use(express.json());
app.use(`/${bot.token}`, (req, res) => {
  bot.handleUpdate(req.body, res).catch(err => console.error(err));
});

app.listen(port, async () => {
  console.log(`Listening on port ${port}`);

  try {
    await bot.api.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/${bot.token}`);
    console.log(`Webhook set to ${process.env.RENDER_EXTERNAL_URL}/${bot.token}`);
  } catch (err) {
    console.error("Failed to set webhook", err.description);
  }
});
