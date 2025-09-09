import { Bot, InlineKeyboard } from "grammy";
import fs from "fs";
import express from "express";

// ===================== 环境变量 =====================
const BOT_TOKENS = process.env.BOT_TOKENS.split(",").map(t => t.trim());
const GROUP_ID = process.env.GROUP_ID;
const NICK_PREFIX = process.env.NICK_PREFIX || "Anon";
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

// ===================== 屏蔽词 =====================
let blockedWords = [];
function loadBlockedWords() {
  try {
    const data = fs.readFileSync("./blocked.txt", "utf-8");
    blockedWords = data.split(/\r?\n/).map(w => w.trim()).filter(Boolean);
    console.log("✅ 屏蔽词已加载：", blockedWords);
  } catch (err) {
    console.error("❌ 加载 blocked.txt 失败:", err);
  }
}
loadBlockedWords();
setInterval(loadBlockedWords, 60 * 1000); // 每分钟刷新

// ===================== 多机器人 =====================
const bots = BOT_TOKENS.map(token => new Bot(token));
let currentBotIndex = 0;
function getNextBot() {
  const bot = bots[currentBotIndex];
  currentBotIndex = (currentBotIndex + 1) % bots.length;
  return bot;
}

// ===================== 匿名名生成 =====================
const anonMap = new Map(); // userId -> anonName
const usedCodes = new Set();

function generateAnonCode() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  let code;
  do {
    let arr = [];
    arr.push(...Array.from({ length: 2 }, () => letters[Math.floor(Math.random() * letters.length)]));
    arr.push(...Array.from({ length: 2 }, () => digits[Math.floor(Math.random() * digits.length)]));
    arr.sort(() => Math.random() - 0.5);
    code = arr.join("");
  } while (usedCodes.has(code));
  usedCodes.add(code);
  return code;
}

function getAnonName(userId) {
  if (anonMap.has(userId)) return anonMap.get(userId);
  const anonCode = generateAnonCode();
  const anonName = `【${NICK_PREFIX}${anonCode}】`;
  anonMap.set(userId, anonName);
  return anonName;
}

function releaseAnonName(userId) {
  const anonName = anonMap.get(userId);
  if (!anonName) return;
  const code = anonName.slice(NICK_PREFIX.length + 1, -1);
  usedCodes.delete(code);
  anonMap.delete(userId);
}

// ===================== 管理员列表 =====================
let adminIds = new Set(); // 私聊过机器人的管理员
function addAdmin(userId) {
  adminIds.add(userId);
}

// ===================== 待审批消息 =====================
const pendingMessages = new Map(); // msgId -> { userId, text, anonName }

// ===================== Express =====================
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Bot running"));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ===================== 消息处理 =====================
bots.forEach(bot => {
  bot.on("message", async ctx => {
    const msg = ctx.message;
    const userId = msg.from.id;
    const text = msg.text || "";

    // 管理员私聊机器人
    if (msg.chat.type === "private") {
      addAdmin(userId);
      return;
    }

    // 群消息
    if (msg.chat.id.toString() !== GROUP_ID.toString()) return;

    const anonName = getAnonName(userId);

    // 检查违规
    const isLinkOrMention = /\bhttps?:\/\/|@/i.test(text);
    const hasBlockedWord = blockedWords.some(word => text.toLowerCase().includes(word.toLowerCase()));

    if (isLinkOrMention || hasBlockedWord) {
      // 删除消息
      try { await ctx.deleteMessage(msg.message_id); } catch {}

      // 保存待审批
      pendingMessages.set(msg.message_id, { userId, text, anonName });

      // 通知所有私聊过的管理员
      adminIds.forEach(async adminId => {
        try {
          const keyboard = new InlineKeyboard()
            .text("✅ 同意", `approve_${msg.message_id}`)
            .text("❌ 拒绝", `reject_${msg.message_id}`);
          await getNextBot().api.sendMessage(
            adminId,
            `用户 ${anonName} 发送了违规消息。\n内容: ${text}\n请审批:`,
            { reply_markup: keyboard }
          );
        } catch {}
      });
      return;
    }

    // 正常匿名转发（异步快速处理，不阻塞）
    setImmediate(async () => {
      try {
        await getNextBot().api.sendMessage(GROUP_ID, `${anonName} ${text}`);
      } catch (err) {
        console.error("转发消息失败:", err);
      }
    });
  });

  // 审批回调
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data;
    const [action, msgId] = data.split("_");
    const pending = pendingMessages.get(Number(msgId));
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "消息已处理或不存在" });
      return;
    }

    if (action === "approve") {
      // 匿名转发
      setImmediate(async () => {
        try {
          await getNextBot().api.sendMessage(GROUP_ID, `${pending.anonName} ${pending.text}`);
        } catch (err) { console.error(err); }
      });
    }

    // 标记已处理
    pendingMessages.delete(Number(msgId));

    // 更新所有管理员按钮显示为已处理
    adminIds.forEach(async adminId => {
      try {
        await ctx.api.editMessageText(
          adminId,
          `消息 ${pending.anonName} 已处理`,
        );
      } catch {}
    });

    await ctx.answerCallbackQuery({ text: "已处理" });
  });

  // 成员退群
  bot.on("chat_member", ctx => {
    const member = ctx.chatMember;
    if (member.old_chat_member.status !== "left" && member.new_chat_member.status === "left") {
      releaseAnonName(member.old_chat_member.user.id);
    }
  });
});

// ===================== 启动 =====================
bots.forEach(bot => bot.start());
