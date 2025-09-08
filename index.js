import express from "express";
import { Bot } from "grammy";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());

// === 配置 ===
const BOT_TOKENS = process.env.BOT_TOKENS.split(",");
const GROUP_ID = parseInt(process.env.GROUP_ID, 10);

// === 管理员存储 ===
const ADMIN_FILE = "./admins.json";
let dynamicAdmins = new Set();

// 从文件加载管理员
function loadAdmins() {
  if (fs.existsSync(ADMIN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
      dynamicAdmins = new Set(data);
      console.log("已加载管理员:", [...dynamicAdmins]);
    } catch (err) {
      console.error("加载管理员失败:", err);
    }
  }
}

// 保存管理员到文件
function saveAdmins() {
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify([...dynamicAdmins], null, 2));
  } catch (err) {
    console.error("保存管理员失败:", err);
  }
}

loadAdmins(); // 启动时加载

// === 工具函数 ===
let botIndex = 0;
function getNextBot() {
  const bot = bots[botIndex];
  botIndex = (botIndex + 1) % bots.length;
  return bot;
}

function generateNickname(userId) {
  return "匿名用户" + String(userId).slice(-4);
}

const violationCount = new Map();

// 转发
async function forwardMessage(ctx, nickname, text) {
  const bot = getNextBot();
  try {
    await bot.api.sendMessage(GROUP_ID, `${nickname}：${text}`);
  } catch (err) {
    console.error("转发消息失败:", err.description);
  }
}

// 通知管理员
async function notifyAdmins(userId, reason) {
  for (const adminId of dynamicAdmins) {
    try {
      await bots[0].api.sendMessage(
        adminId,
        `⚠️ 用户 ${userId} 因 "${reason}" 已违规超过 3 次`
      );
    } catch (err) {
      if (err.error_code === 403) {
        console.warn(`管理员 ${adminId} 没有和机器人开启对话，跳过通知。`);
      } else {
        console.error("通知管理员失败:", err.description);
      }
    }
  }
}

// === 创建所有机器人实例 ===
const bots = BOT_TOKENS.map((token) => new Bot(token));

for (const bot of bots) {
  // 群消息处理
  bot.on("message", async (ctx) => {
    if (ctx.chat.id === GROUP_ID) {
      if (ctx.from.is_bot) return;

      // 1. 删除消息
      try {
        await ctx.deleteMessage();
      } catch (err) {
        console.error("删除消息失败:", err.description);
      }

      // 2. 违规检测
      const text = ctx.message.text || "";
      if (text.includes("http") || text.includes("@")) {
        const count = (violationCount.get(ctx.from.id) || 0) + 1;
        violationCount.set(ctx.from.id, count);

        if (count >= 3) {
          await notifyAdmins(ctx.from.id, "发送链接或 @ 过多");
        }
      }

      // 3. 匿名转发
      if (text.trim()) {
        const nickname = generateNickname(ctx.from.id);
        await forwardMessage(ctx, nickname, text);
      }
    }
  });

  // 私聊 /start 注册管理员
  bot.command("start", async (ctx) => {
    if (ctx.chat.type === "private") {
      dynamicAdmins.add(ctx.from.id);
      saveAdmins(); // ✅ 持久保存
      await ctx.reply("✅ 你已注册为管理员，将收到违规提醒。");
    }
  });

  // Webhook
  app.post(`/webhook/${bot.token}`, async (req, res) => {
    try {
      await bot.handleUpdate(req.body);
    } catch (err) {
      console.error("处理更新失败:", err);
    }
    res.sendStatus(200);
  });

  await bot.init();
}

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Bots are running with webhooks.");
});
