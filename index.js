import { Bot, InlineKeyboard } from "grammy";
import fs from "fs";
import express from "express";

// ---------------- 配置 ----------------
const BOT_TOKENS = [
  process.env.BOT_TOKEN_1,
  process.env.BOT_TOKEN_2,
  process.env.BOT_TOKEN_3,
].filter(Boolean); // 支持多个机器人
const PORT = process.env.PORT || 3000;
const BLOCKED_FILE = "./blocked.txt";
const REFRESH_INTERVAL = 60 * 1000; // 60秒刷新屏蔽词

// ---------------- 初始化 ----------------
const bots = BOT_TOKENS.map(token => new Bot(token));
let blockedWords = [];
let currentBotIndex = 0;
const processedMessages = new Set(); // 已处理消息
const adminMap = new Map(); // 群管理员 user_id => true
const approvalMap = new Map(); // 消息id => { approved: bool, notifiedAdmins: [] }

// ---------------- 加载屏蔽词 ----------------
function loadBlockedWords() {
  try {
    blockedWords = fs.readFileSync(BLOCKED_FILE, "utf-8")
      .split("\n")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    console.log("✅ 屏蔽词已加载：", blockedWords);
  } catch (err) {
    console.log("⚠️ 无法加载屏蔽词文件:", err.message);
  }
}
loadBlockedWords();
setInterval(loadBlockedWords, REFRESH_INTERVAL);

// ---------------- 工具函数 ----------------
function messageHasBlocked(content) {
  const lower = content.toLowerCase();
  return blockedWords.some(word => lower.includes(word));
}

function messageHasLinkOrMention(content) {
  return /(https?:\/\/|www\.|@)/i.test(content);
}

function getNextBot() {
  const bot = bots[currentBotIndex];
  currentBotIndex = (currentBotIndex + 1) % bots.length;
  return bot;
}

// ---------------- 消息处理 ----------------
bots.forEach(bot => {
  bot.on("message", async ctx => {
    try {
      const msg = ctx.message;
      const chatId = msg.chat.id;
      const msgId = msg.message_id;

      // 避免重复处理
      if (processedMessages.has(msgId)) return;
      processedMessages.add(msgId);

      const text = msg.text || "";

      // 更新管理员列表
      if (msg.chat.type.endsWith("group")) {
        try {
          const admins = await ctx.getChatAdministrators();
          admins.forEach(a => adminMap.set(a.user.id, true));
        } catch {}
      }

      const isBlocked = messageHasBlocked(text);
      const hasLinkOrMention = messageHasLinkOrMention(text);

      if (isBlocked || hasLinkOrMention) {
        // 删除消息
        try { await ctx.deleteMessage(msgId); } catch {}

        // 通知所有已私聊管理员等待审批
        const notifiedAdmins = [];
        for (let adminId of adminMap.keys()) {
          try {
            const keyboard = new InlineKeyboard()
              .text("同意", `approve:${chatId}:${msgId}`)
              .text("拒绝", `reject:${chatId}:${msgId}`);
            await ctx.api.sendMessage(adminId,
              `用户 ${msg.from.first_name} 在群 ${msg.chat.title} 发送了一条消息，包含违规内容或链接。\n内容: ${text}`,
              { reply_markup: keyboard });
            notifiedAdmins.push(adminId);
          } catch {}
        }
        approvalMap.set(`${chatId}:${msgId}`, { approved: null, notifiedAdmins });
        return;
      }

      // 普通消息 → 匿名转发
      const botToUse = getNextBot();
      try {
        await botToUse.api.sendMessage(chatId, text, { reply_to_message_id: msgId });
      } catch (err) {}
    } catch (err) {
      console.error(err);
    }
  });

  // 审批按钮回调
  bot.on("callback_query:data", async ctx => {
    try {
      const data = ctx.callbackQuery.data;
      const [action, chatId, msgId] = data.split(":");
      const key = `${chatId}:${msgId}`;
      const approval = approvalMap.get(key);
      if (!approval || approval.approved !== null) {
        await ctx.answerCallbackQuery("消息已处理或不存在");
        return;
      }

      if (action === "approve") {
        approval.approved = true;
        // 匿名转发
        const botToUse = getNextBot();
        try {
          await botToUse.api.sendMessage(chatId, "消息经管理员审批通过转发", { reply_to_message_id: Number(msgId) });
        } catch {}
      } else if (action === "reject") {
        approval.approved = false;
      }

      // 通知所有管理员已处理
      for (let adminId of approval.notifiedAdmins) {
        try {
          await ctx.api.sendMessage(adminId,
            `违规消息已被 ${action === "approve" ? "批准转发" : "拒绝"}处理`);
        } catch {}
      }
      await ctx.answerCallbackQuery("操作完成");
    } catch (err) {
      console.error(err);
    }
  });
});

// ---------------- Express Webhook (可选) ----------------
const app = express();
app.get("/", (req, res) => res.send("Bot is running"));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ---------------- 启动机器人 ----------------
(async () => {
  for (let bot of bots) {
    await bot.init();
    bot.start();
  }
})();
