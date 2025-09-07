import { Bot, webhookCallback } from "grammy";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const bot = new Bot(process.env.BOT_TOKEN);

const chatId = process.env.GROUP_ID;
const prefix = process.env.NICK_PREFIX || "User-";

// 用户编号映射
const userMap = new Map();
const userHistory = new Map();

// 消息映射：原始消息 ID → 群里机器人消息 ID
const messageMap = new Map();

// 随机生成 5 位数字编号
function generateRandomId() {
  return Math.floor(10000 + Math.random() * 90000); // 10000 - 99999
}

function getUserId(userId) {
  if (!userMap.has(userId)) {
    const randomId = generateRandomId();
    userMap.set(userId, `${prefix}${randomId}`);
  }
  return userMap.get(userId);
}

function saveUserMessage(userId, msg) {
  if (!userHistory.has(userId)) userHistory.set(userId, []);
  userHistory.get(userId).push(msg);
}

// 处理消息
bot.on("message", async ctx => {
  const msg = ctx.message;
  if (ctx.from.is_bot) return;
  const userId = getUserId(ctx.from.id);

  try {
    await ctx.deleteMessage();
  } catch (err) {
    console.log("删除消息失败:", err.message);
  }

  // 判断是否是回复消息
  let replyTargetId = null;
  if (msg.reply_to_message) {
    const repliedMsgId = msg.reply_to_message.message_id;
    replyTargetId = messageMap.get(repliedMsgId) || null;
  }

  try {
    let sent;

    if (msg.text) {
      sent = await ctx.api.sendMessage(chatId, `【${userId}】: ${msg.text}`, {
        reply_to_message_id: replyTargetId || undefined,
      });
      saveUserMessage(userId, msg.text);
    } else if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1].file_id;
      sent = await ctx.api.sendPhoto(chatId, photo, {
        caption: `【${userId}】`,
        reply_to_message_id: replyTargetId || undefined,
      });
      saveUserMessage(userId, "[照片]");
    } else if (msg.sticker) {
      sent = await ctx.api.sendSticker(chatId, msg.sticker.file_id, {
        reply_to_message_id: replyTargetId || undefined,
      });
      saveUserMessage(userId, "[贴纸]");
    } else if (msg.video) {
      sent = await ctx.api.sendVideo(chatId, msg.video.file_id, {
        caption: `【${userId}】`,
        reply_to_message_id: replyTargetId || undefined,
      });
      saveUserMessage(userId, "[视频]");
    } else if (msg.document) {
      sent = await ctx.api.sendDocument(chatId, msg.document.file_id, {
        caption: `【${userId}】`,
        reply_to_message_id: replyTargetId || undefined,
      });
      saveUserMessage(userId, "[文件]");
    } else if (msg.audio) {
      sent = await ctx.api.sendAudio(chatId, msg.audio.file_id, {
        caption: `【${userId}】`,
        reply_to_message_id: replyTargetId || undefined,
      });
      saveUserMessage(userId, "[音频]");
    } else if (msg.voice) {
      sent = await ctx.api.sendVoice(chatId, msg.voice.file_id, {
        caption: `【${userId}】`,
        reply_to_message_id: replyTargetId || undefined,
      });
      saveUserMessage(userId, "[语音]");
    } else if (msg.animation) {
      sent = await ctx.api.sendAnimation(chatId, msg.animation.file_id, {
        caption: `【${userId}】`,
        reply_to_message_id: replyTargetId || undefined,
      });
      saveUserMessage(userId, "[动画]");
    } else if (msg.location) {
      sent = await ctx.api.sendMessage(
        chatId,
        `【${userId}】发送了位置: [${msg.location.latitude}, ${msg.location.longitude}]`,
        { reply_to_message_id: replyTargetId || undefined }
      );
      saveUserMessage(userId, "[位置]");
    } else if (msg.poll) {
      const poll = msg.poll;
      sent = await ctx.api.sendPoll(
        chatId,
        poll.question,
        poll.options.map(o => o.text),
        {
          type: poll.type,
          is_anonymous: true,
          reply_to_message_id: replyTargetId || undefined,
        }
      );
      saveUserMessage(userId, "[投票]");
    } else {
      sent = await ctx.api.sendMessage(chatId, `【${userId}】发送了未支持的消息类型`, {
        reply_to_message_id: replyTargetId || undefined,
      });
      saveUserMessage(userId, "[未知消息类型]");
    }

    // 保存消息映射
    if (sent) {
      messageMap.set(msg.message_id, sent.message_id);
    }
  } catch (err) {
    console.log("转发消息失败:", err.message);
  }
});

// 私聊查看历史
bot.command("history", async ctx => {
  const userId = getUserId(ctx.from.id);
  const history = userHistory.get(ctx.from.id) || [];
  if (!history.length) return ctx.reply("你还没有发送过消息。");
  ctx.reply("你的消息历史:\n" + history.join("\n"));
});

// Express 显式绑定端口
const app = express();
const port = process.env.PORT || 3000;

// Webhook 路径
const webhookPath = `/bot${process.env.BOT_TOKEN}`;
app.use(express.json());
app.post(webhookPath, webhookCallback(bot, "express"));

// Render 根路径
app.get("/", (req, res) => res.send("Bot is running"));

// 启动服务
app.listen(port, async () => {
  console.log(`Server listening on port ${port}`);
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}${webhookPath}`;
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.api.setWebhook(webhookUrl);
    console.log(`Webhook set to ${webhookUrl}`);
  } catch (err) {
    console.log("设置 webhook 失败:", err.message);
  }
});
