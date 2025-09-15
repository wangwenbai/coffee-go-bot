import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";

// =====================
// 环境变量
// =====================
const BOT_TOKENS = (process.env.BOT_TOKENS || "").split(",").map(t => t.trim());
const GROUP_ID = Number(process.env.GROUP_ID);
const NICK_PREFIX = process.env.NICK_PREFIX || "#";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = (process.env.RENDER_EXTERNAL_URL || "") + "/webhook";

if (!BOT_TOKENS.length || !GROUP_ID || !process.env.RENDER_EXTERNAL_URL) {
  console.error("❌ 缺少必要环境变量：BOT_TOKENS / GROUP_ID / RENDER_EXTERNAL_URL");
  process.exit(1);
}

// =====================
// 多语言同义词库
// =====================
const aliasMap = {
  "scam": ["骗局","欺诈","诈骗","estafa","fraude","faux","мошенничество","احتيال"],
  "fake": ["假货","伪造","falso","faux","подделка","fraude"],
  "fraud": ["诈骗","欺骗","estafa","fraude","faux","мошенничество","احتيال"],
  // 可以继续扩展更多屏蔽词
};

// =====================
// 屏蔽词热更新（仅在内容变化时）
// =====================
let blockedWordsRegex = null;
let blockedWordsMap = new Map(); // 保存 regex 对应的原始词，方便日志
let lastBlockedContent = "";

// 消息预处理（归一化）
function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFKC")                                      // Unicode归一化
    .replace(/[\u0300-\u036f]/g, "")                        // 去重音
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "") // 去emoji
    .replace(/(.)\1{2,}/g, "$1");                           // 压缩重复字符
}

// 将普通词扩展为更宽松的匹配规则
function buildFlexibleRegex(word) {
  const clean = word.toLowerCase().replace(/\s+/g, "");
  const map = {
    a: "[a@4]",
    i: "[i1!|]",
    l: "[l1!|]",
    o: "[o0]",
    s: "[s$5]",
    e: "[e3]",
    g: "[g9]",
    t: "[t7+]",
    f: "[fƒ]",
    c: "[cç]",
    r: "[r®]",
    u: "[uü]",
    d: "[dð]",
  };
  return clean.split("").map(ch => (map[ch] || ch) + "[\\W_]*").join("");
}

// 扩展同义词
function expandWithAliases(word) {
  const aliases = aliasMap[word.toLowerCase()] || [];
  return [word, ...aliases];
}

function loadBlockedWords() {
  if (!fs.existsSync("./blocked.txt")) {
    if (blockedWordsRegex !== null) {
      blockedWordsRegex = null;
      blockedWordsMap.clear();
      lastBlockedContent = "";
      console.log("⚠️ blocked.txt 不存在，屏蔽词清空");
    }
    return;
  }

  const content = fs.readFileSync("./blocked.txt", "utf-8").trim();
  if (content === lastBlockedContent) return;

  const words = content
    .split(/\r?\n/)
    .map(w => w.trim())
    .filter(Boolean);

  const expandedWords = words.flatMap(expandWithAliases);
  blockedWordsMap.clear();
  const regexParts = expandedWords.map(word => {
    const regexStr = buildFlexibleRegex(word);
    blockedWordsMap.set(regexStr, word);
    return regexStr;
  });

  blockedWordsRegex = regexParts.length ? new RegExp(regexParts.join("|"), "i") : null;
  lastBlockedContent = content;
  console.log("✅ 屏蔽词已更新:", words.length, "条 (扩展后共", expandedWords.length, "个匹配项)");
}

// 启动时加载一次
loadBlockedWords();

// 定时轮询更新，每 5 分钟
setInterval(loadBlockedWords, 5 * 60 * 1000);

// =====================
// 匿名昵称生成
// =====================
const nickMap = new Map();
const usedCodes = new Set();
const NICK_MAX_COUNT = 10000;

function generateNick(userId) {
  if (nickMap.has(userId)) {
    nickMap.get(userId).lastUsed = Date.now();
    return nickMap.get(userId).nick;
  }
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  while (true) {
    let code = Array.from({ length: 4 }, () =>
      letters.charAt(Math.floor(Math.random() * letters.length))
    ).join("");
    if (!usedCodes.has(code)) {
      usedCodes.add(code);
      const nick = `【${NICK_PREFIX}${code}】`;
      nickMap.set(userId, { nick, lastUsed: Date.now(), user: {} });
      return nick;
    }
  }
}

function releaseNick(userId) {
  if (nickMap.has(userId)) {
    const { nick } = nickMap.get(userId);
    const code = nick.slice(NICK_PREFIX.length + 1, -1);
    usedCodes.delete(code);
    nickMap.delete(userId);
  }
}

// 定时清理 nickMap
setInterval(() => {
  const now = Date.now();
  for (const [userId, { lastUsed }] of nickMap.entries()) {
    if (now - lastUsed > 10 * 24 * 60 * 60 * 1000) releaseNick(userId);
  }
  if (nickMap.size > NICK_MAX_COUNT) {
    const sorted = [...nickMap.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < nickMap.size - NICK_MAX_COUNT; i++) releaseNick(sorted[i][0]);
  }
}, 24 * 60 * 60 * 1000);

// =====================
// 初始化机器人
// =====================
const bots = BOT_TOKENS.map(token => new Bot(token));
let botIndex = 0;
function getNextBot() {
  const bot = bots[botIndex];
  botIndex = (botIndex + 1) % bots.length;
  return bot;
}

// =====================
// 管理员缓存
// =====================
const adminIds = new Set();
async function loadGroupAdmins(bot) {
  try {
    const admins = await bot.api.getChatAdministrators(GROUP_ID);
    const newAdminIds = new Set();
    for (const a of admins) newAdminIds.add(a.user.id);
    adminIds.clear();
    for (const id of newAdminIds) adminIds.add(id);
    console.log("✅ 管理员列表更新:", [...adminIds]);
  } catch (e) {
    console.error("❌ 获取管理员失败:", e.message);
  }
}

// 每天更新一次
setInterval(() => {
  bots.forEach(bot => loadGroupAdmins(bot));
}, 24 * 60 * 60 * 1000);

// =====================
// 违规消息处理
// =====================
const pendingReviews = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [reviewId, review] of pendingReviews) {
    if (now - review.reviewTime > 24 * 60 * 60 * 1000) pendingReviews.delete(reviewId);
  }
}, 60 * 60 * 1000);

// =====================
// 已处理消息
// =====================
const processedMessages = new Set();
const processedQueue = [];
function markProcessed(msgKey) {
  processedMessages.add(msgKey);
  processedQueue.push(msgKey);
  if (processedQueue.length > 1000) {
    const oldKey = processedQueue.shift();
    processedMessages.delete(oldKey);
  }
}

// =====================
// 消息处理函数（私聊不转发）
// =====================
async function handleMessage(ctx) {
  const msg = ctx.message;
  if (!msg || !msg.from) return;

  const userId = msg.from.id;
  if (!nickMap.has(userId)) {
    const nick = generateNick(userId);
    nickMap.get(userId).user = msg.from;
  }

  if (!msg.chat || (msg.chat.type !== "group" && msg.chat.type !== "supergroup")) return;

  const msgKey = `${msg.chat.id}_${msg.message_id}`;
  if (processedMessages.has(msgKey)) return;
  markProcessed(msgKey);

  if (msg.from.is_bot) return;
  const nick = generateNick(userId);

  if (adminIds.has(userId)) return;

  const textRaw = msg.text || msg.caption || "";
  const text = normalizeText(textRaw);
  const hasLinkOrMention = /\bhttps?:\/\/\S+|\@\w+/i.test(text);

  let hasBlockedWord = false;
  let triggeredWord = null;
  if (blockedWordsRegex) {
    const match = text.match(blockedWordsRegex);
    if (match) {
      hasBlockedWord = true;
      // 查找匹配的原始词
      for (const [regexStr, original] of blockedWordsMap.entries()) {
        const r = new RegExp(regexStr, "i");
        if (r.test(text)) {
          triggeredWord = original;
          break;
        }
      }
      console.log(`⚠️ 消息触发屏蔽词: "${triggeredWord}" | 用户ID: ${userId} | 内容: ${textRaw}`);
    }
  }

  if (hasLinkOrMention || hasBlockedWord) {
    try { await ctx.api.deleteMessage(ctx.chat.id, msg.message_id); } catch {}
    const reviewId = `${msg.chat.id}_${msg.message_id}`;
    const adminMsgIds = [];
    pendingReviews.set(reviewId, { user: msg.from, msg, adminMsgIds, reviewTime: Date.now() });

    const fullName = `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
    for (const adminId of adminIds) {
      try {
        const kb = new InlineKeyboard()
          .text("✅ 同意", `approve_${reviewId}`)
          .text("❌ 拒绝", `reject_${reviewId}`);
        const m = await ctx.api.sendMessage(
          adminId,
          `⚠️ 用户违规消息待审核\n\n👤 用户: ${fullName} (${msg.from.username ? '@'+msg.from.username : '无用户名'})\n🆔 ID: ${msg.from.id}\n\n内容: ${textRaw}`,
          { reply_markup: kb }
        ).catch(() => {});
        if (m && m.message_id) adminMsgIds.push(m.message_id);
      } catch {}
    }
    return;
  }

  // 正常消息删除 + 匿名转发
  try { await ctx.api.deleteMessage(ctx.chat.id, msg.message_id); } catch {}

  const forwardBot = getNextBot();
  try {
    if (msg.photo) await forwardBot.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, { caption: `${nick}${msg.caption ? ' ' + msg.caption : ''}` }).catch(() => {});
    else if (msg.video) await forwardBot.api.sendVideo(GROUP_ID, msg.video.file_id, { caption: `${nick}${msg.caption ? ' ' + msg.caption : ''}` }).catch(() => {});
    else if (msg.sticker) await forwardBot.api.sendSticker(GROUP_ID, msg.sticker.file_id).catch(() => {});
    else if (msg.text) await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${msg.text}`).catch(() => {});
    else await forwardBot.api.sendMessage(GROUP_ID, `${nick} [不支持的消息类型]`).catch(() => {});
  } catch {}
}

// =====================
// 审核回调
// =====================
bots.forEach(bot => {
  bot.on("callback_query", async ctx => {
    const data = ctx.callbackQuery.data;
    const match = data.match(/^(approve|reject)_(.+)$/);
    if (!match) return;
    const [_, action, reviewId] = match;

    const review = pendingReviews.get(reviewId);
    if (!review) return ctx.answerCallbackQuery({ text: "该消息已处理或过期", show_alert: true }).catch(() => {});

    const { user, msg, adminMsgIds } = review;
    pendingReviews.delete(reviewId);

    for (const adminId of adminIds) {
      for (const messageId of adminMsgIds) {
        try {
          await ctx.api.editMessageReplyMarkup(adminId, messageId, {
            inline_keyboard: [[{ text: action === "approve" ? "✅ 已同意" : "❌ 已拒绝", callback_data: "done" }]]
          }).catch(() => {});
        } catch {}
      }
    }

    if (action === "approve") {
      const nick = generateNick(user.id);
      const forwardBot = getNextBot();
      try {
        if (msg.photo) await forwardBot.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, { caption: `${nick}${msg.caption ? ' ' + msg.caption : ''}` }).catch(() => {});
        else if (msg.video) await forwardBot.api.sendVideo(GROUP_ID, msg.video.file_id, { caption: `${nick}${msg.caption ? ' ' + msg.caption : ''}` }).catch(() => {});
        else if (msg.sticker) await forwardBot.api.sendSticker(GROUP_ID, msg.sticker.file_id).catch(() => {});
        else if (msg.text) await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${msg.text}`).catch(() => {});
      } catch {}
    }

    await ctx.answerCallbackQuery().catch(() => {});
  });
});

// =====================
// 管理员查询匿名码
// =====================
bots.forEach(bot => {
  bot.command("info_code", async ctx => {
    const fromId = ctx.from?.id;
    if (!fromId) return;
    if (!adminIds.has(fromId)) return;

    const args = ctx.message.text.trim().split(/\s+/);
    if (args.length < 2) return ctx.reply("请输入匿名码，例如：/info_code #AB12").catch(() => {});

    const code = args[1].replace(/【|】/g, "");
    let foundUser = null;

    for (const [userId, { nick, user }] of nickMap.entries()) {
      if (nick.includes(code)) {
        foundUser = { userId, nick, user };
        break;
      }
    }

    if (!foundUser) return ctx.reply("未找到该匿名码对应的用户").catch(() => {});

    const { userId, nick, user } = foundUser;
    const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
    const username = user.username ? '@' + user.username : "无用户名";

    ctx.reply(`匿名码：${nick}\n用户ID：${userId}\n姓名：${fullName}\n用户名：${username}`).catch(() => {});
  });
});

// =====================
// 绑定消息事件
// =====================
bots.forEach(bot => bot.on("message", handleMessage));

// =====================
// Express Webhook
// =====================
const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const updates = Array.isArray(req.body) ? req.body : [req.body];
  await Promise.all(bots.map(async bot => {
    for (const update of updates) {
      try { await bot.handleUpdate(update); } catch (e) { console.error(e.message); }
    }
  }));
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  for (const bot of bots) {
    try {
      await bot.init().catch(e => console.error("bot.init失败:", e.message));
      await bot.api.setWebhook(`${WEBHOOK_URL}`).catch(e => console.error("setWebhook失败:", e.message));
      await loadGroupAdmins(bot);
      console.log(`✅ Webhook 已设置: ${bot.botInfo.username}`);
    } catch (e) {
      console.error("启动失败:", e.message);
    }
  }
});

// =====================
// 机器人可用性检测
// =====================
async function checkBots() {
  let aliveCount = 0;
  for (const bot of bots) {
    try {
      const me = await bot.api.getMe();
      console.log(`🤖 Bot 正常: ${me.username} (ID: ${me.id})`);
      aliveCount++;
    } catch (err) {
      console.error(`❌ Bot 不可用: ${bot.token.slice(0, 10)}...`, err.message);
    }
  }

  if (aliveCount === 0) {
    console.error("🚨 所有 Bot 都不可用，程序即将退出！");
    process.exit(1);
  }
}

// 启动时检测一次
checkBots();

// 每 10 分钟检测一次
setInterval(checkBots, 10 * 60 * 1000);
