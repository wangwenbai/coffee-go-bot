import { Bot, GrammyError, HttpError } from "grammy";

// 配置
const BOT_TOKENS = (process.env.BOT_TOKENS || "").split(",");
const GROUP_ID = process.env.GROUP_ID ? Number(process.env.GROUP_ID) : -1001234567890;
const adminIds = new Set((process.env.ADMIN_IDS || "").split(",").map(id => Number(id)));

// 匿名码映射
const nickMap = new Map(); // userId -> { nick, username, fullName }
const usedCodes = new Set();

// 工具函数: 生成唯一匿名码
function generateAnonCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (usedCodes.has(code));
  usedCodes.add(code);
  return `【#${code}】`;
}

// 获取或创建匿名码
function getOrCreateNick(user) {
  if (!nickMap.has(user.id)) {
    const nick = generateAnonCode();
    nickMap.set(user.id, {
      nick,
      username: user.username || null,
      fullName: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
      lastActive: Date.now(),
    });
  } else {
    const data = nickMap.get(user.id);
    data.username = user.username || data.username;
    data.fullName = [user.first_name, user.last_name].filter(Boolean).join(" ") || data.fullName;
    data.lastActive = Date.now();
  }
  return nickMap.get(user.id).nick;
}

// 定时清理 (避免内存无限增长)
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of nickMap.entries()) {
    if (now - data.lastActive > 10 * 24 * 60 * 60 * 1000) { // 10天没活跃
      usedCodes.delete(data.nick.replace(/[【】#]/g, ""));
      nickMap.delete(userId);
    }
  }
}, 60 * 60 * 1000); // 每小时清理一次

// 创建多个 bot 实例
const bots = BOT_TOKENS.filter(Boolean).map(token => new Bot(token));

// 处理消息
async function handleMessage(bot, ctx) {
  const msg = ctx.message;
  if (!msg || !msg.from) return;

  // 忽略私聊，只处理群聊
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;

  const user = msg.from;

  // 管理员消息直接忽略
  if (adminIds.has(user.id)) return;

  const nick = getOrCreateNick(user);

  // 转发到群里（匿名）
  try {
    const text = msg.text || msg.caption || "";
    const forwardText = `${nick}:\n${text}`;
    await bot.api.sendMessage(GROUP_ID, forwardText);
  } catch (err) {
    console.error("转发失败:", err);
  }
}

// =============== 命令: /info_code ===============
bots.forEach(bot => {
  bot.command("info_code", async ctx => {
    const msg = ctx.message;
    if (!msg || !msg.from) return;

    if (!adminIds.has(msg.from.id)) return ctx.reply("❌ 你不是管理员。");
    if (!msg.chat || msg.chat.type !== "private") return;

    const args = (msg.text || "").split(" ").slice(1);
    if (args.length === 0) return ctx.reply("⚠️ 用法: /info_code <匿名码>");

    let code = args[0].replace(/[【】]/g, ""); // 去掉括号

    const entry = [...nickMap.entries()].find(([uid, data]) => data.nick === `【${code}】`);
    if (!entry) return ctx.reply("❌ 未找到该匿名码对应用户。");

    const [targetUserId, data] = entry;
    ctx.reply(
      `👤 用户ID: ${targetUserId}\n` +
      `匿名码: ${data.nick}\n` +
      `真实姓名: ${data.fullName || "未知"}\n` +
      `用户名: ${data.username ? "@" + data.username : "无"}`
    );
  });
});

// 监听消息
bots.forEach(bot => {
  bot.on("message", async ctx => handleMessage(bot, ctx));

  bot.catch(err => {
    console.error(`中间件出现错误:`, err.error);
    if (err.error instanceof GrammyError) {
      console.error("Grammy 错误:", err.error.description);
    } else if (err.error instanceof HttpError) {
      console.error("网络错误:", err.error);
    } else {
      console.error("未知错误:", err.error);
    }
  });

  bot.start();
});
