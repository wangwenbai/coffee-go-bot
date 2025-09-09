// index.js
import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";
import path from "path";

const PORT = process.env.PORT || 3000;

// 机器人令牌列表，多机器人轮询使用
const BOT_TOKENS = (process.env.BOT_TOKENS || "").split(",").map(t => t.trim()).filter(Boolean);
if (!BOT_TOKENS.length) {
    console.error("请在环境变量 BOT_TOKENS 中设置至少一个机器人令牌");
    process.exit(1);
}

// 多机器人轮询索引
let botIndex = 0;

// 屏蔽词集合
let bannedWords = new Set();

// 定时刷新 blocked.txt
const BLOCKED_FILE = path.resolve("./blocked.txt");
function loadBlockedWords() {
    if (fs.existsSync(BLOCKED_FILE)) {
        const lines = fs.readFileSync(BLOCKED_FILE, "utf-8")
            .split("\n")
            .map(l => l.trim().toLowerCase())
            .filter(Boolean);
        bannedWords = new Set(lines);
        console.log("✅ 屏蔽词已加载：", Array.from(bannedWords));
    }
}
loadBlockedWords();
setInterval(loadBlockedWords, 60 * 1000); // 每分钟刷新

// 管理员列表：自动识别群里管理员
const adminSet = new Set();

// 违规消息记录
const pendingViolations = new Map(); // key: message_id, value: { content, chat_id, processed: false, approvers: Set }

// 创建多个机器人
const bots = BOT_TOKENS.map(token => {
    const bot = new Bot(token);

    bot.on("message", async ctx => {
        const message = ctx.message;
        if (!message) return;

        const chatId = message.chat.id;
        const userId = message.from.id;
        const text = message.text || "";

        // 自动识别群管理员
        try {
            const admins = await ctx.getChatAdministrators();
            admins.forEach(a => adminSet.add(a.user.id));
        } catch (err) {
            // 可能不是群，忽略
        }

        // 删除自己的消息不处理
        if (message.from.is_bot) return;

        // 检查违规
        const hasLinkOrMention = /https?:\/\/|@/.test(text);
        const hasBannedWord = [...bannedWords].some(word => text.toLowerCase().includes(word));

        if (hasLinkOrMention || hasBannedWord) {
            // 删除消息
            try { await ctx.deleteMessage(message.message_id); } catch {}

            // 添加到待处理列表
            pendingViolations.set(message.message_id, {
                chat_id: chatId,
                content: text,
                processed: false,
                approvers: new Set()
            });

            // 通知所有管理员
            adminSet.forEach(async adminId => {
                try {
                    await ctx.api.sendMessage(adminId,
                        `用户 ${message.from.first_name} 发送了违规消息:\n${text}\n请审批是否匿名转发`,
                        {
                            reply_markup: new InlineKeyboard()
                                .text("同意", `approve:${message.message_id}`)
                                .text("拒绝", `reject:${message.message_id}`)
                        });
                } catch (err) {
                    // 用户未私聊机器人，忽略
                }
            });

        } else {
            // 正常消息，轮询转发
            const currentBot = bots[botIndex];
            botIndex = (botIndex + 1) % bots.length;

            try {
                await currentBot.api.sendMessage(chatId, text);
                try { await ctx.deleteMessage(message.message_id); } catch {}
            } catch {}
        }
    });

    bot.on("callback_query:data", async ctx => {
        const data = ctx.callbackQuery.data;
        const fromId = ctx.from.id;

        if (!data) return;
        const [action, msgIdStr] = data.split(":");
        const msgId = parseInt(msgIdStr);

        const violation = pendingViolations.get(msgId);
        if (!violation || violation.processed) {
            await ctx.answerCallbackQuery({ text: "已处理" });
            return;
        }

        if (!adminSet.has(fromId)) {
            await ctx.answerCallbackQuery({ text: "你不是管理员" });
            return;
        }

        if (action === "approve") {
            // 标记已处理
            violation.processed = true;

            // 匿名转发
            try {
                await ctx.api.sendMessage(violation.chat_id,
                    violation.content);
            } catch {}

            // 更新所有管理员按钮为“已处理”
            adminSet.forEach(async adminId => {
                try {
                    await ctx.api.editMessageReplyMarkup(adminId, { inline_keyboard: [] });
                } catch {}
            });

            await ctx.answerCallbackQuery({ text: "已同意" });
        } else if (action === "reject") {
            violation.processed = true;
            await ctx.answerCallbackQuery({ text: "已拒绝" });
        }
    });

    return bot;
});

// 启动所有机器人
bots.forEach(bot => bot.start());

// Express server 保活
const app = express();
app.get("/", (req, res) => res.send("Bot is running"));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
