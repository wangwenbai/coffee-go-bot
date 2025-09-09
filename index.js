// index.js
import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";

// ===== 配置部分 =====
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim()); // 多个机器人 token
const GROUP_ID = process.env.GROUP_ID; // 群组 ID
const NICK_PREFIX = process.env.NICK_PREFIX || "User"; // 匿名前缀
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

// 屏蔽词动态加载
let bannedWords = [];
try {
  bannedWords = fs
    .readFileSync("blocked.txt", "utf-8")
    .split("\n")
    .map(w => w.trim())
    .filter(Boolean);
  console.log("✅ 屏蔽词已加载：", bannedWords);
} catch (err) {
  console.warn("⚠️ 未找到 blocked.txt，使用空屏蔽词列表");
}

// ===== 运行时状态 =====
let botIndex = 0; // 轮询机器人索引
const userMap = new Map(); // 用户 ID → 匿名代号
let userCount = 0;
const pendingApprovals = new Map(); // 消息ID → { text, from, adminsHandled }
let cachedAdmins = []; // 缓存的群管理员

// ===== 初始化多个机器人 =====
const bots = BOT_TOKENS.map((token, idx) => {
  const bot = new Bot(token);

  // 处理普通消息
  bot.on("message", async (ctx) => {
    const msg = ctx.message;
    if (!msg.text) return;

    // 检测违规内容
    const text = msg.text;
    const hasLinkOrMention = /(https?:\/\/|www\.|t\.me\/|@[\w_]+)/i.test(text);
    const hasBannedWord = bannedWords.some(w => text.includes(w));
    const fromId = msg.from.id;

    // 管理员身份检查（管理员消息不过滤）
    const admins = await getAdmins(bot);
    const isAdmin = admins.some(a => a.user.id === fromId);

    if (!isAdmin && (hasLinkOrMention || hasBannedWord)) {
      try {
        await ctx.deleteMessage();
      } catch (e) {
        console.warn("⚠️ 删除消息失败:", e.description);
      }

      // 违规消息需要管理员审批
      const anonName = getAnonName(fromId);
      const approvalId = `${msg.chat.id}_${msg.message_id}`;
      pendingApprovals.set(approvalId, { text, from: anonName, handled: false });

      const keyboard = new InlineKeyboard()
        .text("✅ 同意", `approve:${approvalId}`)
        .text("❌ 拒绝", `reject:${approvalId}`);

      for (const admin of admins) {
        try {
          await bot.api.sendMessage(
            admin.user.id,
            `用户 ${anonName} 发送了疑似违规内容：\n内容: ${text}\n是否允许转发？`,
            { reply_markup: keyboard }
          );
        } catch (err) {
          if (err.error_code === 403) {
            console.warn(`⚠️ 无法给管理员 ${admin.user.id} 发消息（未私聊机器人）`);
          } else {
            console.error("通知管理员失败：", err.description);
          }
        }
      }
      return;
    }

    // 正常消息 → 匿名转发
    if (!isAdmin) {
      try {
        await ctx.deleteMessage();
      } catch (e) {
        console.warn("⚠️ 删除消息失败:", e.description);
      }

      const anonName = getAnonName(fromId);
      const targetBot = getNextBot();
      await targetBot.api.sendMessage(GROUP_ID, `${anonName}: ${text}`);
    }
  });

  // 管理员审批
  bot.callbackQuery(/^(approve|reject):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const approvalId = ctx.match[2];
    const record = pendingApprovals.get(approvalId);

    if (!record || record.handled) {
      return ctx.answerCallbackQuery({ text: "该请求已处理", show_alert: true });
    }

    if (action === "approve") {
      const targetBot = getNextBot();
      await targetBot.api.sendMessage(GROUP_ID, `${record.from}: ${record.text}`);
    }

    record.handled = true;

    // 更新所有管理员的按钮 → 已处理
    const admins = await getAdmins(bot);
    for (const admin of admins) {
      try {
        await ctx.api.editMessageReplyMarkup(admin.user.id, ctx.callbackQuery.message.message_id, {
          reply_markup: new InlineKeyboard().text("✅ 已处理"),
        });
      } catch (err) {
        // 忽略已修改错误
      }
    }

    await ctx.answerCallbackQuery({ text: "处理完成" });
  });

  return bot;
});

// ===== 辅助函数 =====
function getAnonName(userId) {
  if (!userMap.has(userId)) {
    userCount++;
    userMap.set(userId, `${NICK_PREFIX}${userCount}`);
  }
  return userMap.get(userId);
}

function getNextBot() {
  const bot = bots[botIndex];
  botIndex = (botIndex + 1) % bots.length;
  return bot;
}

async function getAdmins(bot) {
  if (cachedAdmins.length === 0) {
    try {
      const res = await bot.api.getChatAdministrators(GROUP_ID);
      cachedAdmins = res;
    } catch (e) {
      console.error("获取管理员失败：", e.description);
    }
  }
  return cachedAdmins;
}

// ===== Express 适配 Render =====
const app = express();
app.use(express.json());

app.post(`/${BOT_TOKENS[0]}`, (req, res) => {
  bots[0].handleUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Bot is running");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  if (RENDER_EXTERNAL_URL) {
    bots.forEach((bot, idx) => {
      bot.api.setWebhook(`${RENDER_EXTERNAL_URL}/${BOT_TOKENS[idx]}`);
    });
  } else {
    bots.forEach(bot => bot.start());
  }
});
