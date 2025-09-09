import express from "express";
import { Bot } from "grammy";
import fs from "fs";
import path from "path";

// 环境变量
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const GROUP_ID = process.env.GROUP_ID;
const NICK_PREFIX = process.env.NICK_PREFIX || "#";
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

// 存储屏蔽词
let blockedWords = [];
function loadBlockedWords() {
  const filePath = path.join(process.cwd(), "blocked.txt");
  if (fs.existsSync(filePath)) {
    blockedWords = fs.readFileSync(filePath, "utf-8").split("\n").map(w => w.trim()).filter(Boolean);
  }
}
loadBlockedWords();
setInterval(loadBlockedWords, 60 * 1000);

// 匿名码存储
const userAnonMap = new Map(); // user_id -> code
function generateAnonCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// 管理员缓存
let adminCache = [];
async function refreshAdmins(bot) {
  try {
    const admins = await bot.api.getChatAdministrators(GROUP_ID);
    adminCache = admins.map(a => a.user.id);
  } catch (err) {
    console.error("获取管理员失败", err);
  }
}
setInterval(() => refreshAdmins(bots[0]), 5 * 60 * 1000);

// 审核队列
const pendingReviews = new Map(); // key: message_id, value: {user, content, handled}

// 轮询分配器
let botIndex = 0;
function getNextBot() {
  const bot = bots[botIndex];
  botIndex = (botIndex + 1) % bots.length;
  return bot;
}

// 初始化多个 Bot
const bots = BOT_TOKENS.map(token => new Bot(token));

// 公共处理函数
async function handleMessage(bot, ctx) {
  const msg = ctx.message;
  if (!msg || msg.chat.id.toString() !== GROUP_ID) return;

  // 管理员不处理（包括匿名管理员）
  if (msg.from && adminCache.includes(msg.from.id)) return;

  const text = msg.text || msg.caption || "";
  const hasLink = /(https?:\/\/\S+)/i.test(text);
  const hasMention = /@\w+/.test(text);
  const hasBlocked = blockedWords.some(w => text.includes(w));

  // 违规消息 -> 删除并发管理员审核
  if (hasLink || hasMention || hasBlocked) {
    try {
      await ctx.deleteMessage();
    } catch (err) {
      console.error("删除消息失败", err.description);
    }

    // 保存到审核队列
    const reviewId = `${msg.chat.id}_${msg.message_id}`;
    pendingReviews.set(reviewId, {
      user: msg.from,
      content: msg,
      handled: false,
    });

    // 通知所有管理员
    for (const adminId of adminCache) {
      try {
        await bot.api.sendMessage(adminId, 
          `🚨 群成员发送了违规内容\n\n` +
          `👤 用户: ${msg.from.first_name} (${msg.from.username ? '@'+msg.from.username : '无用户名'})\n` +
          `🆔 ID: ${msg.from.id}\n` +
          `💬 内容: ${text || "[非文本消息]"}\n\n是否允许匿名转发？`, {
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ 同意", callback_data: `approve:${reviewId}` },
              { text: "❌ 拒绝", callback_data: `reject:${reviewId}` }
            ]]
          }
        });
      } catch (err) {
        console.error("通知管理员失败", err.description);
      }
    }
    return;
  }

  // 正常消息 -> 匿名转发
  const uid = msg.from.id;
  if (!userAnonMap.has(uid)) {
    userAnonMap.set(uid, generateAnonCode());
  }
  const anonCode = userAnonMap.get(uid);
  const header = `${NICK_PREFIX}${anonCode}`;

  try {
    if (msg.text) {
      await ctx.api.sendMessage(GROUP_ID, `${header}: ${msg.text}`);
    } else if (msg.photo) {
      await ctx.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, {
        caption: msg.caption ? `${header}: ${msg.caption}` : header
      });
    } else if (msg.video) {
      await ctx.api.sendVideo(GROUP_ID, msg.video.file_id, {
        caption: msg.caption ? `${header}: ${msg.caption}` : header
      });
    } else if (msg.sticker) {
      await ctx.api.sendSticker(GROUP_ID, msg.sticker.file_id);
    } else if (msg.document) {
      await ctx.api.sendDocument(GROUP_ID, msg.document.file_id, {
        caption: msg.caption ? `${header}: ${msg.caption}` : header
      });
    } else {
      await ctx.api.sendMessage(GROUP_ID, `${header}: [不支持的消息类型]`);
    }

    await ctx.deleteMessage();
  } catch (err) {
    console.error("匿名转发失败", err.description);
  }
}

// 处理管理员审核回调
for (const bot of bots) {
  bot.on("callback_query:data", async ctx => {
    const [action, reviewId] = ctx.callbackQuery.data.split(":");
    const review = pendingReviews.get(reviewId);
    if (!review || review.handled) {
      await ctx.answerCallbackQuery({ text: "该请求已处理", show_alert: true });
      return;
    }

    if (action === "approve") {
      // 转发消息
      const uid = review.user.id;
      if (!userAnonMap.has(uid)) {
        userAnonMap.set(uid, generateAnonCode());
      }
      const anonCode = userAnonMap.get(uid);
      const header = `${NICK_PREFIX}${anonCode}`;
      const content = review.content;

      try {
        if (content.text) {
          await ctx.api.sendMessage(GROUP_ID, `${header}: ${content.text}`);
        } else if (content.photo) {
          await ctx.api.sendPhoto(GROUP_ID, content.photo[content.photo.length - 1].file_id, {
            caption: content.caption ? `${header}: ${content.caption}` : header
          });
        } else if (content.video) {
          await ctx.api.sendVideo(GROUP_ID, content.video.file_id, {
            caption: content.caption ? `${header}: ${content.caption}` : header
          });
        } else if (content.sticker) {
          await ctx.api.sendSticker(GROUP_ID, content.sticker.file_id);
        } else if (content.document) {
          await ctx.api.sendDocument(GROUP_ID, content.document.file_id, {
            caption: content.caption ? `${header}: ${content.caption}` : header
          });
        }
      } catch (err) {
        console.error("管理员同意转发失败", err.description);
      }
    }

    // 标记已处理
    review.handled = true;
    pendingReviews.set(reviewId, review);

    // 修改所有管理员的按钮为已处理
    for (const adminId of adminCache) {
      try {
        await ctx.api.editMessageReplyMarkup(adminId, ctx.callbackQuery.message.message_id, {
          reply_markup: { inline_keyboard: [] }
        });
      } catch (err) {
        // 忽略已修改的
      }
    }

    await ctx.answerCallbackQuery({ text: "处理完成" });
  });
}

// 绑定消息事件（分配）
for (const bot of bots) {
  bot.on("message", async ctx => {
    const handlerBot = getNextBot();
    if (ctx.me.id === handlerBot.botInfo.id) {
      await handleMessage(bot, ctx);
    }
  });
}

// Express 服务器 + Webhook
const app = express();
app.use(express.json());

bots.forEach(bot => {
  const route = `/bot${bot.token.split(":")[0]}`;
  app.post(route, (req, res) => {
    bot.handleUpdate(req.body, res).catch(err => console.error("处理update失败:", err));
  });

  bot.init().then(() => {
    bot.api.setWebhook(`${RENDER_EXTERNAL_URL}${route}`)
      .then(() => console.log(`Webhook 设置成功: ${route}`))
      .catch(err => console.error("设置Webhook失败:", err));
    refreshAdmins(bot); // 初始化时刷新管理员
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
