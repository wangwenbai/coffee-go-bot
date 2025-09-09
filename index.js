import { Bot, InlineKeyboard } from "grammy";
import fs from "fs";
import path from "path";

// ---------- 配置 ----------
const BOT_TOKENS = [
  process.env.BOT_TOKEN_1,
  process.env.BOT_TOKEN_2,
  process.env.BOT_TOKEN_3,
]; // 多机器人轮询
const blockedFile = path.resolve("./blocked.txt");
const BLOCKED_RELOAD_INTERVAL = 60 * 1000; // 1分钟刷新

// ---------- 初始化机器人 ----------
const bots = BOT_TOKENS.map(token => new Bot(token));
let botIndex = 0;
function getNextBot() {
  const bot = bots[botIndex];
  botIndex = (botIndex + 1) % bots.length;
  return bot;
}

// ---------- 屏蔽词 ----------
let blockedWords = [];
function loadBlockedWords() {
  try {
    blockedWords = fs.readFileSync(blockedFile, "utf-8")
      .split(/\r?\n/)
      .map(w => w.trim())
      .filter(Boolean);
    console.log("✅ 屏蔽词已加载：", blockedWords);
  } catch (err) {
    console.error("❌ 加载 blocked.txt 失败:", err);
  }
}
loadBlockedWords();
setInterval(loadBlockedWords, BLOCKED_RELOAD_INTERVAL);

function messageHasBlocked(text) {
  const lower = text.toLowerCase();
  return blockedWords.some(word => lower.includes(word));
}
function messageHasLinkOrMention(text) {
  return /https?:\/\/\S+|@\w+/i.test(text);
}

// ---------- 管理员 ----------
const adminMap = new Map(); // userId -> true，私聊过机器人即加入
function updateAdmin(userId) {
  adminMap.set(userId, true);
}

// ---------- 消息审批 ----------
const approvalMap = new Map(); // key = chatId:msgId -> {approved, notifiedAdmins}

// ---------- 已处理消息 ----------
const processedMessages = new Set();

// ---------- 消息队列 ----------
const messageQueue = [];
let processing = false;
async function processQueue() {
  if (processing) return;
  processing = true;

  while (messageQueue.length) {
    const { ctx, msg } = messageQueue.shift();
    const chatId = msg.chat.id;
    const msgId = msg.message_id;
    const text = msg.text || "";

    // 删除群成员消息
    try { await ctx.deleteMessage(msgId); } catch {}

    // 检查违规
    const isBlocked = messageHasBlocked(text);
    const hasLinkOrMention = messageHasLinkOrMention(text);

    if (isBlocked || hasLinkOrMention) {
      // 通知所有私聊过的管理员审批
      const notifiedAdmins = [];
      for (let adminId of adminMap.keys()) {
        try {
          const keyboard = new InlineKeyboard()
            .text("同意", `approve:${chatId}:${msgId}`)
            .text("拒绝", `reject:${chatId}:${msgId}`);
          await ctx.api.sendMessage(adminId,
            `用户 ${msg.from.first_name} 在群 ${msg.chat.title} 发送违规内容。\n内容: ${text}\n请审批：同意 → 匿名转发，拒绝 → 不转发`,
            { reply_markup: keyboard });
          notifiedAdmins.push(adminId);
        } catch {}
      }
      approvalMap.set(`${chatId}:${msgId}`, { approved: null, notifiedAdmins });
    } else {
      // 普通消息 → 匿名转发
      const botToUse = getNextBot();
      try { await botToUse.api.sendMessage(chatId, text); } catch {}
    }
  }

  processing = false;
}

// ---------- 监听消息 ----------
bots.forEach(bot => {
  bot.on("message", ctx => {
    const msg = ctx.message;
    const msgId = msg.message_id;
    const fromId = msg.from.id;

    // 如果是管理员私聊机器人 → 加入管理员列表
    if (msg.chat.type === "private") updateAdmin(fromId);

    // 群消息处理
    if (!processedMessages.has(msgId) && msg.chat.type.endsWith("group")) {
      processedMessages.add(msgId);
      messageQueue.push({ ctx, msg });
      processQueue();
    }
  });

  // 回调按钮处理
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data;
    const [action, chatIdStr, msgIdStr] = data.split(":");
    const key = `${chatIdStr}:${msgIdStr}`;
    const approval = approvalMap.get(key);
    if (!approval || approval.approved !== null) {
      await ctx.answerCallbackQuery({ text: "此消息已处理" });
      return;
    }

    const chatId = parseInt(chatIdStr);
    const msgId = parseInt(msgIdStr);

    if (action === "approve") {
      approval.approved = true;
      // 匿名转发
      const botToUse = getNextBot();
      try {
        const msgData = await ctx.api.getMessage(chatId, msgId);
        await botToUse.api.sendMessage(chatId, msgData.text);
      } catch {}
    } else if (action === "reject") {
      approval.approved = false;
    }

    // 所有管理员按钮变为已处理
    for (let adminId of approval.notifiedAdmins) {
      try {
        await ctx.api.editMessageReplyMarkup(adminId, undefined, { message_id: ctx.callbackQuery.message.message_id });
      } catch {}
    }

    await ctx.answerCallbackQuery({ text: "已处理" });
  });

  bot.start();
});

console.log("🚀 所有机器人已启动");
