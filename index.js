import { Bot, webhookCallback } from "grammy";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";

dotenv.config();

const bot = new Bot(process.env.BOT_TOKEN);

const chatId = process.env.GROUP_ID;
const prefix = process.env.NICK_PREFIX || "User-";

// 用户编号映射
const userMap = new Map();
const userHistory = new Map();

// 消息映射：原始消息 ID → 群里机器人消息 ID
const messageMap = new Map();

// 屏蔽关键词数组
let blockedKeywords = [];

// 加载屏蔽词函数
function loadBlockedKeywords() {
  try {
    const data = fs.readFileSync('./blocked.txt', 'utf8');
    blockedKeywords = data.split(',').map(word => word.trim()).filter(Boolean);
    console.log(`屏蔽词已加载: ${blockedKeywords.length} 个`);
  } catch (err) {
    console.log("加载屏蔽词失败:", err.message);
  }
}

// 初始化加载一次
loadBlockedKeywords();

// 热更新 blocked.txt
fs.watchFile('./blocked.txt', (curr, prev) => {
  console.log('blocked.txt 文件发生变化，重新加载...');
  loadBlockedKeywords();
});

// 随机生成 5 位数字编号
function generateRandomId() {
  return Math.floor(10000 + Math.random() * 90000);
}

// 获取用户编号（首次分配后绑定）
function getUserId(userId) {
  if (!userMap.has(userId)) {
    const randomId = generateRandomId();
    userMap.set(userId, `${prefix}${randomId}`);
  }
  return userMap.get(userId);
}

// 保存用户历史消息
function saveUserMessage(userId, msg) {
  if (!userHistory.has(userId)) userHistory.set(userId, []);
  userHistory.get(userId).push(msg);
}

// 判断是否包含屏蔽关键词（大小写不敏感）
function containsBlockedKeyword(text) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return blockedKeywords.some(word => lowerText.includes(word.toLowerCase()));
}

// 判断用户是否为群管理员
async function isAdmin(ctx) {
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return member.status === "administrator" || member.status === "creator";
  } catch {
    return false;
  }
}

// 处理所有消息
bot.on("message", async ctx => {
  const msg = ctx.message;
  if (ctx.from.is_bot) return;
  const userId = getUserId(ctx.from.id);

  // 删除原始消息
  try {
    await ctx.deleteMessage();
  } catch (err) {
    console.log("删除消息失败:", err.message);
  }

  // 屏蔽关键词
  if ((msg.text && containsBlockedKeyword(msg.text))) {
    console.log(`消息被屏蔽: ${msg.text}`);
    saveUserMessage(userId, "[屏蔽消息]");
    return;
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

// 添加屏蔽词（管理员命令）- 支持英文逗号批量添加 - 私聊反馈
bot.command("block", async ctx => {
  if (!(await isAdmin(ctx))) return ctx.api.sendMessage(ctx.from.id, "只有管理员可以添加屏蔽词。");

  const text = ctx.message.text.slice(6).trim(); // 去掉 "/block "
  if (!text) return ctx.api.sendMessage(ctx.from.id, "请指定要屏蔽的词。");

  const words = text.split(",").map(word => word.trim()).filter(Boolean);
  if (!words.length) return ctx.api.sendMessage(ctx.from.id, "没有有效屏蔽词。");

  let added = [];
  for (const word of words) {
    if (!blockedKeywords.includes(word)) {
      blockedKeywords.push(word);
      added.push(word);
    }
  }

  if (added.length) {
    fs.writeFileSync('./blocked.txt', blockedKeywords.join(","), "utf8");
    await ctx.api.sendMessage(ctx.from.id, `屏蔽词已添加: ${added.join(", ")}`);
  } else {
    await ctx.api.sendMessage(ctx.from.id, "这些词已在屏蔽列表中。");
  }
});

// 移除屏蔽词（管理员命令）- 支持英文逗号批量删除 - 私聊反馈
bot.command("unblock", async ctx => {
  if (!(await isAdmin(ctx))) return ctx.api.sendMessage(ctx.from.id, "只有管理员可以移除屏蔽词。");

  const text = ctx.message.text.slice(8).trim(); // 去掉 "/unblock "
  if (!text) return ctx.api.sendMessage(ctx.from.id, "请指定要移除的词。");

  const words = text.split(",").map(word => word.trim()).filter(Boolean);
  if (!words.length) return ctx.api.sendMessage(ctx.from.id, "没有有效屏蔽词。");

  let removed = [];
  blockedKeywords = blockedKeywords.filter(word => {
    if (words.includes(word)) {
      removed.push(word);
      return false;
    }
    return true;
  });

  if (removed.length) {
    fs.writeFileSync('./blocked.txt', blockedKeywords.join(","), "utf8");
    await ctx.api.sendMessage(ctx.from.id, `屏蔽词已移除: ${removed.join(", ")}`);
  } else {
    await ctx.api.sendMessage(ctx.from.id, "这些词不在屏蔽列表中。");
  }
});

// 查看当前屏蔽词 - 私聊反馈
bot.command("blocked", async ctx => {
  if (!blockedKeywords.length) return ctx.api.sendMessage(ctx.from.id, "当前没有屏蔽词。");
  await ctx.api.sendMessage(ctx.from.id, `当前屏蔽词: ${blockedKeywords.join(", ")}`);
});

// 监听用户退群
bot.on("chat_member", async ctx => {
  const status = ctx.chatMember.new_chat_member.status;
  const userId = ctx.chatMember.new_chat_member.user.id;
  if (status === "left" || status === "kicked") {
    userMap.delete(userId);
    userHistory.delete(userId);
    console.log(`已移除用户 ${userId} 的匿名编号`);
  }
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
