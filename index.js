import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const chatId = process.env.GROUP_ID;
const prefix = process.env.NICK_PREFIX || "User";

const userMap = new Map();
const userHistory = new Map();
const messageMap = new Map();
const pendingMessages = new Map();
const usedNicknames = new Set();
const adCountMap = new Map();
const notifiedUsers = new Set();

// ---------------------
// 屏蔽词逻辑
// ---------------------
let blockedKeywords = [];

function loadBlockedKeywords() {
  try {
    const data = fs.readFileSync('./blocked.txt', 'utf8');
    blockedKeywords = data.split("\n").map(w => w.trim()).filter(Boolean);
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
  if (!userMap.has(userId)) {
    const nickname = generateRandomNickname();
    userMap.set(userId, nickname);
  }
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

async function notifyAdminsOfSpammer(bot, user) {
  try {
    const admins = await bot.api.getChatAdministrators(chatId);
    const adminUsers = admins.filter(a => !a.user.is_bot);
    const userIdentity = formatUserIdentity(user);
    for (const admin of adminUsers) {
      await bot.api.sendMessage(
        admin.user.id,
        `🚨 User ${userIdentity} exceeded 3 link/mention messages!`
      );
    }
  } catch (err) {
    console.log("Failed to notify admins of spammer:", err.message);
  }
}

// ---------------------
// 消息转发函数
// ---------------------
async function forwardMessage(bot, ctx, userId, targetChatId = chatId, replyTargetId = null) {
  const msg = ctx.message;
  let sent;
  try {
    const caption = msg.caption ? `【${userId}】 ${msg.caption}` : msg.text ? `【${userId}】: ${msg.text}` : `【${userId}】`;

    if (msg.photo) sent = await ctx.api.sendPhoto(targetChatId, msg.photo[msg.photo.length - 1].file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.video) sent = await ctx.api.sendVideo(targetChatId, msg.video.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.document) sent = await ctx.api.sendDocument(targetChatId, msg.document.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.audio) sent = await ctx.api.sendAudio(targetChatId, msg.audio.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.voice) sent = await ctx.api.sendVoice(targetChatId, msg.voice.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.animation) sent = await ctx.api.sendAnimation(targetChatId, msg.animation.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.sticker) sent = await ctx.api.sendSticker(targetChatId, msg.sticker.file_id, { reply_to_message_id: replyTargetId || undefined });
    else if (msg.location) sent = await ctx.api.sendMessage(targetChatId, `【${userId}】 sent location: [${msg.location.latitude}, ${msg.location.longitude}]`, { reply_to_message_id: replyTargetId || undefined });
    else if (msg.poll) sent = await ctx.api.sendPoll(targetChatId, msg.poll.question, msg.poll.options.map(o => o.text), { type: msg.poll.type, is_anonymous: true, reply_to_message_id: replyTargetId || undefined });
    else sent = await ctx.api.sendMessage(targetChatId, caption, { reply_to_message_id: replyTargetId || undefined });

    if (sent) messageMap.set(msg.message_id, sent.message_id);
    saveUserMessage(userId, msg.text || msg.caption || "[Non-text]");
  } catch (err) {
    console.log("Forward message error:", err.message);
  }
}

// ---------------------
// 多机器人轮询
// ---------------------
for (const token of BOT_TOKENS) {
  const bot = new Bot(token);
  await bot.init();

  bot.on("message", async ctx => {
    const msg = ctx.message;
    if (ctx.chat.type === "private" || ctx.from.is_bot) return;

    const member = await bot.api.getChatMember(chatId, ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";

    const userId = getUserId(ctx.from.id);

    if (isAdmin) return; // 管理员消息不匿名

    try { await ctx.deleteMessage(); } catch {}

    const textToCheck = msg.text || msg.caption;
    if (containsBlockedKeyword(textToCheck)) return;

    if (containsLinkOrMention(textToCheck)) {
      const currentCount = (adCountMap.get(ctx.from.id) || 0) + 1;
      adCountMap.set(ctx.from.id, currentCount);

      if (currentCount > 3 && !notifiedUsers.has(ctx.from.id)) {
        notifiedUsers.add(ctx.from.id);
        await notifyAdminsOfSpammer(bot, ctx.from);
      }

      try {
        const admins = await bot.api.getChatAdministrators(chatId);
        const adminUsers = admins.filter(a => !a.user.is_bot);
        for (const admin of adminUsers) {
          const keyboard = new InlineKeyboard()
            .text("✅ Approve", `approve:${msg.message_id}:${ctx.from.id}`)
            .text("❌ Reject", `reject:${msg.message_id}:${ctx.from.id}`);
          const sentMsg = await bot.api.sendMessage(admin.user.id,
            `User ${ctx.from.first_name} (${userId}) sent a message containing a link or mention.\nContent: ${textToCheck || "[Non-text]"}\nApprove to forward or reject.`,
            { reply_markup: keyboard }
          );
          pendingMessages.set(`${msg.message_id}:${admin.user.id}`, { ctx, userId, notifMsgId: sentMsg.message_id, chatId: admin.user.id });
        }
      } catch (err) {
        console.log("Failed to send private review:", err.message);
      }
      return;
    }

    await forwardMessage(bot, ctx, userId);

    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      await forwardMessage(bot, ctx, userId, msg.chat.id);
    }
  });

  bot.on("callback_query:data", async ctx => {
    const userIdClicker = ctx.from.id;
    const member = await bot.api.getChatMember(chatId, userIdClicker);
    if (!(member.status === "administrator" || member.status === "creator")) {
      return ctx.answerCallbackQuery({ text: "Only admins can approve/reject", show_alert: true });
    }

    const data = ctx.callbackQuery.data.split(":");
    const action = data[0];
    const origMsgId = parseInt(data[1]);
    const origUserId = parseInt(data[2]);

    const pendingKeys = Array.from(pendingMessages.keys()).filter(key => key.startsWith(`${origMsgId}:`));

    if (pendingKeys.length === 0) {
      return ctx.answerCallbackQuery({ text: "This message has been processed", show_alert: true });
    }

    try {
      if (action === "approve") {
        await forwardMessage(bot, pendingMessages.get(pendingKeys[0]).ctx, pendingMessages.get(pendingKeys[0]).userId);
        await ctx.answerCallbackQuery({ text: "Message approved and forwarded", show_alert: true });
      } else if (action === "reject") {
        await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
      }

      for (const key of pendingKeys) {
        const pending = pendingMessages.get(key);
        try {
          await bot.api.editMessageReplyMarkup(pending.chatId, pending.notifMsgId,
            { reply_markup: new InlineKeyboard().text("✅ Processed", "processed") }
          );
        } catch (err) {
          console.log("Failed to edit notification message:", err.message);
        }
        pendingMessages.delete(key);
      }
    } catch (err) {
      console.log("Error handling callback:", err.message);
    }
  });

  bot.on("chat_member", async ctx => {
    const status = ctx.chatMember.new_chat_member.status;
    const userId = ctx.chatMember.new_chat_member.user.id;
    if (status === "left" || status === "kicked") {
      const nickname = userMap.get(userId);
      if (nickname) usedNicknames.delete(nickname);
      userMap.delete(userId);
      userHistory.delete(userId);
      adCountMap.delete(userId);
      notifiedUsers.delete(userId);
    }
  });

  bot.start();
}

console.log("All bots started using long polling.");
