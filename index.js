import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";

dotenv.config();

// 多个机器人 Token（用 , 分隔）
const TOKENS = process.env.BOT_TOKENS.split(",");
const GROUP_ID = process.env.GROUP_ID; // 群ID
const ADMIN_IDS = process.env.ADMIN_IDS.split(",").map(id => id.trim()); // 管理员ID

// 屏蔽词列表
const BLOCKED_WORDS = ["广告", "微信", "QQ"];

// 初始化多个机器人
const bots = TOKENS.map(token => new Bot(token));

// 消息轮询分配计数器
let roundRobinIndex = 0;

// 存储待审批消息
const pendingMessages = new Map(); // key: messageId, value: { text, userId }

// 工具函数：检查消息是否违规
function checkViolation(text) {
  if (!text) return false;
  if (BLOCKED_WORDS.some(word => text.includes(word))) return true;
  if (text.match(/https?:\/\/\S+/)) return true; // 链接
  if (text.match(/@\w+/)) return true; // @用户名
  return false;
}

// 工具函数：通知所有管理员审批
async function notifyAdmins(bot, msgId, userId, text) {
  const keyboard = new InlineKeyboard()
    .text("✅ 同意", `approve_${msgId}`)
    .text("❌ 拒绝", `reject_${msgId}`);

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.api.sendMessage(
        adminId,
        `⚠️ 检测到违规消息：\n\n${text}\n\n是否允许匿名转发？`,
        { reply_markup: keyboard }
      );
    } catch (err) {
      console.error("通知管理员失败：", err.message);
    }
  }
}

// 给消息分配机器人
function getNextBot() {
  const bot = bots[roundRobinIndex];
  roundRobinIndex = (roundRobinIndex + 1) % bots.length;
  return bot;
}

// 处理每个机器人消息
bots.forEach(bot => {
  bot.on("message", async ctx => {
    try {
      if (ctx.chat.id.toString() !== GROUP_ID) return;

      const msgId = ctx.message.message_id;
      const userId = ctx.from.id;
      const text = ctx.message.text || ctx.message.caption || "";

      const assignedBot = getNextBot();

      if (checkViolation(text)) {
        // 删除违规消息
        await ctx.deleteMessage();

        // 存储待审批
        pendingMessages.set(msgId, { text, userId });

        // 通知管理员
        await notifyAdmins(assignedBot, msgId, userId, text);
      } else {
        // 删除消息并匿名转发
        await ctx.deleteMessage();
        await assignedBot.api.sendMessage(GROUP_ID, `匿名消息：\n${text}`);
      }
    } catch (err) {
      console.error("消息处理出错：", err.message);
    }
  });

  // 管理员审批回调
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data;
    const [action, msgId] = data.split("_");
    const pending = pendingMessages.get(Number(msgId));

    if (!pending) {
      await ctx.answerCallbackQuery({ text: "该消息已处理" });
      return;
    }

    if (action === "approve") {
      await bots[0].api.sendMessage(GROUP_ID, `匿名消息：\n${pending.text}`);
      await ctx.answerCallbackQuery({ text: "✅ 已同意并转发" });
    } else if (action === "reject") {
      await ctx.answerCallbackQuery({ text: "❌ 已拒绝" });
    }

    // 所有管理员共享处理结果 → 删除待审批
    pendingMessages.delete(Number(msgId));
  });

  bot.start();
});

console.log(`🤖 已启动 ${bots.length} 个机器人`);
