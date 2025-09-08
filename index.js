import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";

dotenv.config();

// ---------------------
// 环境变量
// ---------------------
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim()).filter(Boolean);
const chatId = process.env.GROUP_ID;
const prefix = process.env.NICK_PREFIX || "User";

// ---------------------
// 全局存储
// ---------------------
const userMap = new Map();          // telegramId => 匿名编号
const userHistory = new Map();      // 匿名编号 => 历史消息
const messageMap = new Map();       // 原始消息ID => 转发消息ID
const pendingMessages = new Map();  // `${origMsgId}` => { ctx, userId, notifMsgIds: [msgId], chatIds: [adminId] }
const usedNicknames = new Set();
const adCountMap = new Map();
const adminSet = new Set();         // 所有已私聊机器人管理员 ID
let blockedKeywords = [];
let roundRobinIndex = 0;            // 多机器人轮询

// ---------------------
// 屏蔽词逻辑
// ---------------------
function loadBlockedKeywords() {
  try {
    const data = fs.readFileSync('./blocked.txt', 'utf8');
    blockedKeywords = data.split('\n').map(w => w.trim()).filter(Boolean);
    console.log(`Blocked keywords loaded: ${blockedKeywords.length}`);
  } catch (err) {
    console.log("Failed to load blocked keywords:", err.message);
  }
}
loadBlockedKeywords();
fs.watchFile('./blocked.txt', () => loadBlockedKeywords());

// ---------------------
// 工具函数
// ---------------------
function generateRandomNickname() {
  let nickname;
  do {
    const letters = String.fromCharCode(65 + Math.floor(Math.random() * 26)) +
                    String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const numbers = Math.floor(Math.random() * 10).toString() +
                    Math.floor(Math.random() * 10).toString();
    nickname = `${prefix}${letters}${numbers}`;
  } while (usedNicknames.has(nickname));
  usedNicknames.add(nickname);
  return nickname;
}

function getUserId(userId) {
  if (!userMap.has(userId)) userMap.set(userId, generateRandomNickname());
  return userMap.get(userId);
}

function saveUserMessage(userId, msg) {
  if (!userHistory.has(userId)) userHistory.set(userId, []);
  userHistory.get(userId).push(msg);
}

function containsBlockedKeyword(text) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return blockedKeywords.some(word => lowerText.includes(word.toLowerCase()));
}

function containsLinkOrMention(text) {
  if (!text) return false;
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
  const mentionRegex = /@[a-zA-Z0-9_]+/;
  return urlRegex.test(text) || mentionRegex.test(text);
}

function formatUserIdentity(user) {
  if (user.username) return `@${user.username}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return `${name || "Unknown User"} (no username)`;
}

// ---------------------
// 消息转发
// ---------------------
async function forwardMessage(bot, ctx, userId, targetChatId = chatId, replyTargetId = null) {
  const msg = ctx.message;
  let caption = msg.caption || msg.text || "";
  caption = `【${userId}】 ${caption}`;

  try {
    let sendPromises = [];
    if (msg.photo) sendPromises.push(ctx.api.sendPhoto(targetChatId, msg.photo[msg.photo.length - 1].file_id, { caption, reply_to_message_id: replyTargetId || undefined }));
    else if (msg.video) sendPromises.push(ctx.api.sendVideo(targetChatId, msg.video.file_id, { caption, reply_to_message_id: replyTargetId || undefined }));
    else if (msg.document) sendPromises.push(ctx.api.sendDocument(targetChatId, msg.document.file_id, { caption, reply_to_message_id: replyTargetId || undefined }));
    else if (msg.audio) sendPromises.push(ctx.api.sendAudio(targetChatId, msg.audio.file_id, { caption, reply_to_message_id: replyTargetId || undefined }));
    else if (msg.voice) sendPromises.push(ctx.api.sendVoice(targetChatId, msg.voice.file_id, { caption, reply_to_message_id: replyTargetId || undefined }));
    else if (msg.animation) sendPromises.push(ctx.api.sendAnimation(targetChatId, msg.animation.file_id, { caption, reply_to_message_id: replyTargetId || undefined }));
    else if (msg.sticker) sendPromises.push(ctx.api.sendSticker(targetChatId, msg.sticker.file_id, { reply_to_message_id: replyTargetId || undefined }));
    else if (msg.location) sendPromises.push(ctx.api.sendMessage(targetChatId, `【${userId}】 sent location: [${msg.location.latitude}, ${msg.location.longitude}]`, { reply_to_message_id: replyTargetId || undefined }));
    else if (msg.poll) sendPromises.push(ctx.api.sendPoll(targetChatId, msg.poll.question, msg.poll.options.map(o => o.text), { type: msg.poll.type, is_anonymous: true, reply_to_message_id: replyTargetId || undefined }));
    else sendPromises.push(ctx.api.sendMessage(targetChatId, caption, { reply_to_message_id: replyTargetId || undefined }));

    const results = await Promise.all(sendPromises);
    if (results.length) messageMap.set(msg.message_id, results[0].message_id);
    saveUserMessage(userId, msg.text || msg.caption || "[Non-text]");
  } catch (err) {
    console.log("Forward message error:", err.message);
  }
}

// ---------------------
// 创建机器人实例
// ---------------------
const bots = BOT_TOKENS.map(token => new Bot(token));
await Promise.all(bots.map(b => b.init()));

// ---------------------
// 群消息处理
// ---------------------
bots.forEach(bot => {
  bot.on("message", async ctx => {
    const msg = ctx.message;
    if (ctx.chat.type === "private" || ctx.from.is_bot) {
      // 私聊机器人 -> 保存管理员ID
      adminSet.add(ctx.from.id);
      return;
    }

    const member = await bot.api.getChatMember(chatId, ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    const userId = getUserId(ctx.from.id);

    // 管理员消息不匿名转发
    if (isAdmin) return;

    const textToCheck = msg.text || msg.caption;

    // 屏蔽词或链接/mention → 审核流程
    if (containsBlockedKeyword(textToCheck) || containsLinkOrMention(textToCheck)) {
      const key = `${msg.message_id}`;
      if (!pendingMessages.has(key)) {
        const notifMsgIds = [];
        const chatIds = [];
        for (const adminId of adminSet) {
          try {
            const keyboard = new InlineKeyboard()
              .text("✅ Approve", `approve:${msg.message_id}:${ctx.from.id}`)
              .text("❌ Reject", `reject:${msg.message_id}:${ctx.from.id}`);
            const sentMsg = await bot.api.sendMessage(adminId,
              `User ${ctx.from.first_name} (${userId}) sent a message containing a link, mention, or blocked word.\nContent: ${textToCheck || "[Non-text]"}\nApprove to forward or reject.`,
              { reply_markup: keyboard }
            );
            notifMsgIds.push(sentMsg.message_id);
            chatIds.push(adminId);
          } catch (err) { /* 机器人无法发起私聊则忽略 */ }
        }
        pendingMessages.set(key, { ctx, userId, notifMsgIds, chatIds });
      }
      try { await ctx.deleteMessage(); } catch {}
      return;
    }

    // 正常消息 → 轮询机器人转发
    const robot = bots[roundRobinIndex % bots.length];
    roundRobinIndex++;
    try { await ctx.deleteMessage(); } catch {}
    await forwardMessage(robot, ctx, userId);
  });
});

// ---------------------
// 回调查询（审批按钮）
// ---------------------
bots.forEach(bot => {
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data.split(":");
    const action = data[0];
    const origMsgId = data[1];
    const origUserId = data[2];

    if (!pendingMessages.has(origMsgId)) {
      return ctx.answerCallbackQuery({ text: "This message has been processed", show_alert: true });
    }

    const pending = pendingMessages.get(origMsgId);
    const member = await bot.api.getChatMember(chatId, ctx.from.id);
    if (!(member.status === "administrator" || member.status === "creator")) {
      return ctx.answerCallbackQuery({ text: "Only admins can approve/reject", show_alert: true });
    }

    try {
      if (action === "approve") {
        const robot = bots[roundRobinIndex % bots.length];
        roundRobinIndex++;
        await forwardMessage(robot, pending.ctx, pending.userId);
        await ctx.answerCallbackQuery({ text: "Message approved and forwarded", show_alert: true });
      } else {
        await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
      }

      // 编辑所有通知消息 → 已处理
      await Promise.all(pending.chatIds.map((adminId, idx) =>
        bot.api.editMessageReplyMarkup(adminId, pending.notifMsgIds[idx], { reply_markup: new InlineKeyboard().text("✅ Processed", "processed") })
          .catch(() => {})
      ));
      pendingMessages.delete(origMsgId);
    } catch (err) { console.log("Callback handling error:", err.message); }
  });
});

// ---------------------
// 用户退群清理
// ---------------------
bots.forEach(bot => {
  bot.on("chat_member", async ctx => {
    const status = ctx.chatMember.new_chat_member.status;
    const userId = ctx.chatMember.new_chat_member.user.id;
    if (status === "left" || status === "kicked") {
      const nickname = userMap.get(userId);
      if (nickname) usedNicknames.delete(nickname);
      userMap.delete(userId);
      userHistory.delete(userId);
      adCountMap.delete(userId);
    }
  });
});

// ---------------------
// Express Webhook
// ---------------------
const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

bots.forEach(bot => {
  const webhookPath = `/bot${bot.token}`;
  app.post(webhookPath, (req, res) => { bot.handleUpdate(req.body).catch(console.error); res.sendStatus(200); });
});

app.get("/", (req, res) => res.send("Bot running"));

app.listen(port, async () => {
  console.log(`Listening on port ${port}`);
  if (!process.env.RENDER_EXTERNAL_URL) return;

  await Promise.all(bots.map(async bot => {
    const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/bot${bot.token}`;
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
      await bot.api.setWebhook(webhookUrl);
      console.log(`Webhook set for bot ${bot.token}: ${webhookUrl}`);
    } catch (err) {
      console.log(`Webhook setup failed for bot ${bot.token}:`, err.message);
    }
  }));
});
