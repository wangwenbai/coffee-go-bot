import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import fs from "fs";
import express from "express";

dotenv.config();

// ---------------------
// 环境变量
// ---------------------
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim()).filter(Boolean);
const GROUP_ID = process.env.GROUP_ID;
const NICK_PREFIX = process.env.NICK_PREFIX || "User";

// ---------------------
// 全局存储
// ---------------------
const userMap = new Map<number, string>();
const userHistory = new Map<string, string[]>();
const messageMap = new Map<number, number>();
const pendingMessages = new Map<string, { ctx: any, userId: string, notifMsgId: number | null, chatId: number, msgData: any }>();
const usedNicknames = new Set<string>();

// ---------------------
// 屏蔽词
// ---------------------
let blockedKeywords: string[] = [];
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
  let nickname: string;
  do {
    const letters = String.fromCharCode(65 + Math.floor(Math.random() * 26)) +
                    String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const numbers = Math.floor(Math.random() * 10).toString() +
                    Math.floor(Math.random() * 10).toString();
    nickname = `${NICK_PREFIX}${letters}${numbers}`;
  } while (usedNicknames.has(nickname));
  usedNicknames.add(nickname);
  return nickname;
}

function getUserId(userId: number) {
  if (!userMap.has(userId)) userMap.set(userId, generateRandomNickname());
  return userMap.get(userId)!;
}

function saveUserMessage(userId: string, msg: string) {
  if (!userHistory.has(userId)) userHistory.set(userId, []);
  userHistory.get(userId)!.push(msg);
}

function containsBlockedKeyword(text?: string) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return blockedKeywords.some(word => lowerText.includes(word.toLowerCase()));
}

function containsLinkOrMention(text?: string) {
  if (!text) return false;
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
  const mentionRegex = /@[a-zA-Z0-9_]+/;
  return urlRegex.test(text) || mentionRegex.test(text);
}

function formatUserIdentity(user: any) {
  if (user.username) return `@${user.username}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return `${name || "Unknown User"} (no username)`;
}

// ---------------------
// 安全发送消息
// ---------------------
async function safeSendMessage(bot: Bot, chatId: number, text: string, options?: any) {
  try { await bot.api.sendMessage(chatId, text, options); } catch (err: any) {
    if (err.response && err.response.error_code === 403) {
      // 无法私聊管理员，忽略
      return;
    }
    console.log("sendMessage failed:", err.message);
  }
}

// ---------------------
// 转发消息
// ---------------------
async function forwardMessage(ctx: any, userId: string, targetChatId = GROUP_ID, replyTargetId: number | null = null) {
  const msg = ctx.message;
  let sent;
  try {
    const caption = msg.caption ? `【${userId}】 ${msg.caption}` : msg.text ? `【${userId}】 ${msg.text}` : `【${userId}】`;
    if (msg.photo) sent = await ctx.api.sendPhoto(targetChatId, msg.photo[msg.photo.length - 1].file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.video) sent = await ctx.api.sendVideo(targetChatId, msg.video.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else if (msg.document) sent = await ctx.api.sendDocument(targetChatId, msg.document.file_id, { caption, reply_to_message_id: replyTargetId || undefined });
    else sent = await ctx.api.sendMessage(targetChatId, caption, { reply_to_message_id: replyTargetId || undefined });

    if (sent) messageMap.set(msg.message_id, sent.message_id);
    saveUserMessage(userId, msg.text || msg.caption || "[Non-text]");
  } catch (err) {
    console.log("Forward message error:", err.message);
  }
}

// ---------------------
// 获取所有已私聊过的管理员
// ---------------------
async function getAdmins(bot: Bot) {
  try {
    const admins = await bot.api.getChatAdministrators(GROUP_ID);
    return admins.filter(a => !a.user.is_bot).map(a => a.user.id);
  } catch (err) {
    console.log("getAdmins failed:", err.message);
    return [];
  }
}

// ---------------------
// 创建机器人实例
// ---------------------
const bots = BOT_TOKENS.map(token => new Bot(token));
await Promise.all(bots.map(b => b.init()));

let robotIndex = 0; // 轮询索引

// ---------------------
// 群消息处理
// ---------------------
bots.forEach(bot => {
  bot.on("message", async ctx => {
    const msg = ctx.message;
    if (ctx.chat.type === "private" || ctx.from.is_bot) return;

    const member = await bot.api.getChatMember(GROUP_ID, ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    const userId = getUserId(ctx.from.id);

    if (isAdmin) return; // 管理员消息不处理

    // 删除消息
    try { await ctx.deleteMessage(); } catch {}

    const textToCheck = msg.text || msg.caption;
    const isBlocked = containsBlockedKeyword(textToCheck) || containsLinkOrMention(textToCheck);

    if (isBlocked) {
      // 违规 → 不转发，通知所有私聊过的管理员
      const admins = await getAdmins(bot);
      const keyboard = new InlineKeyboard()
        .text("✅ Approve", `approve:${msg.message_id}:${ctx.from.id}`)
        .text("❌ Reject", `reject:${msg.message_id}:${ctx.from.id}`);
      for (const adminId of admins) {
        await safeSendMessage(bot, adminId, `User ${formatUserIdentity(ctx.from)} (#${userId}) sent a blocked message.\nContent: ${textToCheck || "[Non-text]"}\nApprove or reject.`, { reply_markup: keyboard });
        pendingMessages.set(`${msg.message_id}:${adminId}`, { ctx, userId, notifMsgId: null, chatId: adminId, msgData: msg });
      }
      return;
    }

    // 普通消息 → 轮询机器人匿名转发
    const botToUse = bots[robotIndex % bots.length];
    robotIndex++;
    await forwardMessage(ctx, userId);
  });
});

// ---------------------
// 回调查询（审批按钮）
bots.forEach(bot => {
  bot.on("callback_query:data", async ctx => {
    const userIdClicker = ctx.from.id;
    const member = await bot.api.getChatMember(GROUP_ID, userIdClicker);
    if (!(member.status === "administrator" || member.status === "creator")) {
      return ctx.answerCallbackQuery({ text: "Only admins can approve/reject", show_alert: true });
    }

    const data = ctx.callbackQuery.data.split(":");
    const action = data[0];
    const origMsgId = parseInt(data[1]);
    const origUserId = parseInt(data[2]);

    const pendingKeys = Array.from(pendingMessages.keys())
      .filter(key => key.startsWith(`${origMsgId}:`));
    if (!pendingKeys.length) return ctx.answerCallbackQuery({ text: "This message has been processed", show_alert: true });

    const firstPending = pendingMessages.get(pendingKeys[0])!;
    const { ctx: originalCtx, userId, msgData } = firstPending;

    try {
      if (action === "approve") {
        // 审批同意 → 匿名转发
        const botToUse = bots[robotIndex % bots.length];
        robotIndex++;
        await forwardMessage(originalCtx, userId);
        await ctx.answerCallbackQuery({ text: "Message approved and forwarded", show_alert: true });
      } else if (action === "reject") {
        await ctx.answerCallbackQuery({ text: "Message rejected", show_alert: true });
      }

      // 更新所有管理员按钮为已处理
      await Promise.all(pendingKeys.map(async key => {
        const pending = pendingMessages.get(key)!;
        try {
          await bot.api.editMessageReplyMarkup(pending.chatId, pending.notifMsgId || undefined,
            { reply_markup: new InlineKeyboard().text("✅ Processed", "processed") }
          );
        } catch {}
        pendingMessages.delete(key);
      }));
    } catch (err) { console.log("Error handling callback:", err.message); }
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
