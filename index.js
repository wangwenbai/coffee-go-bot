import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";

const PORT = process.env.PORT || 3000;
const BOT_TOKENS = (process.env.BOT_TOKENS || "")
  .split(",")
  .map(t => t.trim())
  .filter(Boolean);

if (!BOT_TOKENS.length) {
  console.error("❌ 请在 BOT_TOKENS 设置至少一个机器人 token");
  process.exit(1);
}

// 多机器人实例
const bots = BOT_TOKENS.map(token => new Bot(token));

// 屏蔽词动态加载
let bannedWords = [];
function loadBannedWords() {
  try {
    const data = fs.readFileSync("blocked.txt", "utf8");
    bannedWords = data
      .split(/\r?\n/)
      .map(line => line.trim().toLowerCase())
      .filter(Boolean);
    console.log("✅ 屏蔽词已加载：", bannedWords);
  } catch (e) {
    console.error("⚠️ blocked.txt 加载失败", e);
  }
}
loadBannedWords();
setInterval(loadBannedWords, 60 * 1000); // 每60秒更新一次

// 管理员私聊记录
const adminsMap = new Map(); // key: admin id, value: true

// 待审批消息
const pendingMessages = new Map(); // key: chatId_msgId, value: { text, from, keyboard }

// 消息轮询索引，轮流转发
let botIndex = 0;

// 创建 Express 服务器（Webhook 备用）
const app = express();
app.use(express.json());
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// 处理消息
async function handleMessage(ctx, bot) {
  const msg = ctx.message;
  if (!msg || !msg.from || msg.from.is_bot) return;

  const text = msg.text || msg.caption || "";
  const lowerText = text.toLowerCase();

  const containsLink = /(https?:\/\/)/i.test(text);
  const containsAt = /@\w+/.test(text);
  const containsBanned = bannedWords.some(word => lowerText.includes(word));

  const key = `${msg.chat.id}_${msg.message_id}`;

  // 违规消息：先删除
  if (containsLink || containsAt || containsBanned) {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.warn("⚠️ 删除消息失败", e);
    }

    // 准备审批消息
    const keyboard = new InlineKeyboard()
      .text("✅ 同意转发", `approve_${key}`)
      .text("❌ 拒绝", `reject_${key}`);

    pendingMessages.set(key, { text, from: msg.from, keyboard });

    // 通知所有已私聊过管理员
    for (const adminId of adminsMap.keys()) {
      try {
        await bot.api.sendMessage(
          adminId,
          `用户 ${msg.from.first_name} 发送违规消息：\n${text}\n请审批`,
          { reply_markup: keyboard }
        );
      } catch (e) {
        console.warn("⚠️ 通知管理员失败", adminId, e.description);
      }
    }

    return;
  }

  // 普通消息，轮流机器人匿名转发
  const currentBot = bots[botIndex % bots.length];
  botIndex++;

  try {
    await ctx.deleteMessage();
    await currentBot.api.sendMessage(
      msg.chat.id,
      text,
      { reply_to_message_id: msg.message_id }
    );
  } catch (e) {
    console.warn("⚠️ 普通消息转发失败", e.description);
  }
}

// 处理审批按钮
async function handleCallback(ctx) {
  const data = ctx.callbackQuery.data;
  const msgKey = data.split("_").slice(1).join("_");
  const pending = pendingMessages.get(msgKey);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: "消息已处理或不存在", show_alert: true });
    return;
  }

  if (data.startsWith("approve")) {
    const currentBot = bots[botIndex % bots.length];
    botIndex++;
    try {
      await currentBot.api.sendMessage(
        ctx.callbackQuery.message.chat.id,
        pending.text
      );
    } catch (e) {
      console.warn("⚠️ 审批转发失败", e.description);
    }
  }

  // 更新按钮状态
  const newKeyboard = new InlineKeyboard().text("已处理", "done");
  try {
    for (const adminId of adminsMap.keys()) {
      await bots[0].api.editMessageReplyMarkup(adminId, ctx.callbackQuery.message.message_id, { reply_markup: newKeyboard });
    }
  } catch (e) {
    console.warn("⚠️ 更新审批按钮失败", e.description);
  }

  pendingMessages.delete(msgKey);
  await ctx.answerCallbackQuery({ text: "已处理" });
}

// 所有机器人事件绑定
for (const bot of bots) {
  bot.on("message", ctx => handleMessage(ctx, bot));
  bot.on("callback_query:data", ctx => handleCallback(ctx));

  // 记录私聊管理员
  bot.on("message", ctx => {
    if (ctx.chat.type === "private") {
      adminsMap.set(ctx.chat.id, true);
    }
  });

  bot.start();
}
