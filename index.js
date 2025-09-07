import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";

dotenv.config();

// ---------------------
// Bot 初始化
// ---------------------
const bot = new Bot(process.env.BOT_TOKEN);
await bot.init();

const chatId = process.env.GROUP_ID;
const prefix = process.env.NICK_PREFIX || "User";

const userMap = new Map();          // telegramId => 匿名编号
const userHistory = new Map();      // 匿名编号 => 历史消息
const messageMap = new Map();       // 原始消息ID => 转发消息ID
const pendingMessages = new Map();  // key: `${origMsgId}:${adminId}` => { ctx, userId, notifMsgId, chatId }
const usedNicknames = new Set();    // 已分配的匿名码
const adCountMap = new Map();       // userId => 广告次数
const blockedCountMap = new Map();  // userId => 屏蔽词违规次数
const notifiedUsers = new Set();    // 已通知过的用户

// ---------------------
// 屏蔽词逻辑
// ---------------------
let blockedKeywords = [];

function loadBlockedKeywords() {
  try {
    const data = fs.readFileSync('./blocked.txt', 'utf8');
    blockedKeywords = data.split(',').map(w => w.trim()).filter(Boolean);
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

function getBlockedWordsInText(text) {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  return blockedKeywords.filter(word => lowerText.includes(word.toLowerCase()));
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

async function notifyAdminsOfViolation(user, violationContents, violationType) {
  try {
    const admins = await bot.api.getChatAdministrators(chatId);
    const adminUsers = admins.filter(a => !a.user.is_bot);
    const userIdentity = formatUserIdentity(user);
    for (const admin of adminUsers) {
      await bot.api.sendMessage(
        admin.user.id,
        `🚨 用户 ${userIdentity} 触发违规 (${violationType}) 已超过 3 次！\n触发内容：${violationContents.join(", ")}`
      );
    }
  } catch (err) {
    console.log("Failed to notify admins of violation:", err.message);
  }
}

// ---------------------
// 消息转发函数
// ---------------------
async function forwardMessage(ctx, userId, targetChatId = chatId, replyTargetId = null) {
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
// 群消息处理
// ---------------------
bot.on("message", async ctx => {
  const msg = ctx.message;
  if (ctx.chat.type === "private" || ctx.from.is_bot) return;

  const member = await bot.api.getChatMember(chatId, ctx.from.id);
  const isAdmin = member.status === "administrator" || member.status === "creator";

  const userId = getUserId(ctx.from.id);

  // 管理员消息不匿名
  if (isAdmin) return;

  // 删除普通用户消息
  try { await ctx.deleteMessage(); } catch {}

  const textToCheck = msg.text || msg.caption;

  // 屏蔽词检查
  const matchedBlockedWords = getBlockedWordsInText(textToCheck);
  if (matchedBlockedWords.length > 0) {
    const count = (blockedCountMap.get(ctx.from.id) || 0) + 1;
    blockedCountMap.set(ctx.from.id, count);

    if (count > 3 && !notifiedUsers.has(ctx.from.id)) {
      notifiedUsers.add(ctx.from.id);
      await notifyAdminsOfViolation(ctx.from, matchedBlockedWords, "blocked words");
    }
    return; // 触发屏蔽词直接不转发
  }

  // 广告逻辑
  if (containsLinkOrMention(textToCheck)) {
    const currentCount = (adCountMap.get(ctx.from.id) || 0) + 1;
    adCountMap.set(ctx.from.id, currentCount);

    if (currentCount > 3 && !notifiedUsers.has(ctx.from.id)) {
      notifiedUsers.add(ctx.from.id);
      await notifyAdminsOfViolation(ctx.from, [textToCheck], "link/mention");
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

  // 匿名转发到主群
  await forwardMessage(ctx, userId);
});
