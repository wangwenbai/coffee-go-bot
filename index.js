import { Bot } from "grammy";

// 你的 BOT Token
const bot = new Bot(process.env.BOT_TOKEN);

// 群 ID（替换成你自己的群组 ID）
const GROUP_ID = -1001234567890;

// 匿名码映射（用户 ID => 匿名码）
const nickMap = new Map();
// 匿名码反查（匿名码 => 用户信息）
const codeToUser = new Map();

// 管理员 ID 列表（自动维护）
let adminIds = [];

// 生成匿名码
function generateCode(userId) {
  if (nickMap.has(userId)) return nickMap.get(userId);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const code =
    "#" +
    Array.from({ length: 4 }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length))
    ).join("");
  nickMap.set(userId, code);
  codeToUser.set(code, {
    id: userId,
    name: null,
    username: null,
  });
  return code;
}

// 每天更新一次管理员列表
async function updateAdmins() {
  try {
    const admins = await bot.api.getChatAdministrators(GROUP_ID);
    adminIds = admins.map((a) => a.user.id);
    console.log("管理员列表已更新:", adminIds);
  } catch (err) {
    console.error("获取管理员失败：", err.description || err.message);
  }
}

// 启动时更新一次
updateAdmins();
// 每 24 小时更新一次
setInterval(updateAdmins, 24 * 60 * 60 * 1000);

// 转发群消息并替换用户名为匿名码
bot.on("message", async (ctx) => {
  try {
    if (!ctx.message.chat || ctx.message.chat.id !== GROUP_ID) return;

    const user = ctx.from;
    if (!user) return;

    const code = generateCode(user.id);

    // 更新用户信息（名字、用户名）
    const displayName = [user.first_name, user.last_name]
      .filter(Boolean)
      .join(" ");
    codeToUser.set(code, {
      id: user.id,
      name: displayName || "无姓名",
      username: user.username || "无用户名",
    });

    // 转发到群里，替换为匿名码
    await ctx.copyMessage(GROUP_ID, {
      reply_markup: undefined, // 不加内联按钮
      caption: `匿名码【${code}】\n\n${ctx.message.text || ""}`,
    });
  } catch (err) {
    console.error("转发消息失败：", err.description || err.message);
  }
});

// 管理员查询匿名码对应的用户
bot.command("info_code", async (ctx) => {
  try {
    const isAdmin = adminIds.includes(ctx.from.id);
    if (!isAdmin) return; // 非管理员静默，不返回提示

    const parts = ctx.message.text.split(" ");
    if (parts.length < 2) {
      return ctx.reply("❌ 格式错误，用法：/info_code <匿名码>");
    }

    const code = parts[1].trim();
    if (!codeToUser.has(code)) {
      return ctx.reply("❌ 未找到该匿名码对应的用户。");
    }

    const user = codeToUser.get(code);
    await ctx.reply(
      `匿名码：【${code}】\n用户ID：${user.id}\n姓名：${user.name}\n用户名：${user.username}`
    );
  } catch (err) {
    console.error("查询匿名码失败：", err.description || err.message);
  }
});

// 启动机器人
bot.start();
console.log("✅ Bot 已启动");
