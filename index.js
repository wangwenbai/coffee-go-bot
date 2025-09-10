async function handleMessage(ctx) {
  const msg = ctx.message;
  if (!msg || !msg.from) return;

  // ✅ 只处理群聊消息，私聊忽略
  if (!msg.chat || (msg.chat.type !== "group" && msg.chat.type !== "supergroup")) return;

  const msgKey = `${msg.chat.id}_${msg.message_id}`;
  if (processedMessages.has(msgKey)) return;
  markProcessed(msgKey);

  if (msg.from.is_bot) return;

  const userId = msg.from.id;
  const nick = generateNick(userId);

  // 管理员消息不处理
  if (adminIds.has(userId)) return;

  const text = msg.text || msg.caption || "";
  const hasLinkOrMention = /\bhttps?:\/\/\S+|\@\w+/i.test(text);
  const hasBlockedWord = blockedWordsRegex && blockedWordsRegex.test(text);

  if (hasLinkOrMention || hasBlockedWord) {
    try { await ctx.api.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}

    const reviewId = `${msg.chat.id}_${msg.message_id}`;
    const adminMsgIds = [];

    pendingReviews.set(reviewId, { user: msg.from, msg, adminMsgIds, reviewTime: Date.now() });

    // 用户全名
    const fullName = `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();

    for (const adminId of adminIds) {
      try {
        const kb = new InlineKeyboard()
          .text("✅ 同意", `approve_${reviewId}`)
          .text("❌ 拒绝", `reject_${reviewId}`);
        const m = await ctx.api.sendMessage(
          adminId,
          `⚠️ 用户违规消息待审核\n\n👤 用户: ${fullName} (${msg.from.username ? '@'+msg.from.username : '无用户名'})\n🆔 ID: ${msg.from.id}\n\n内容: ${text}`,
          { reply_markup: kb }
        );
        adminMsgIds.push(m.message_id);
      } catch (e) {}
    }
    return;
  }

  // 正常消息：删除 + 匿名转发
  try { await ctx.api.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}

  const forwardBot = getNextBot();
  try {
    if (msg.photo) {
      await forwardBot.api.sendPhoto(GROUP_ID, msg.photo[msg.photo.length - 1].file_id, {
        caption: `${nick}${msg.caption ? ' ' + msg.caption : ''}`
      });
    } else if (msg.video) {
      await forwardBot.api.sendVideo(GROUP_ID, msg.video.file_id, {
        caption: `${nick}${msg.caption ? ' ' + msg.caption : ''}`
      });
    } else if (msg.sticker) {
      await forwardBot.api.sendSticker(GROUP_ID, msg.sticker.file_id);
    } else if (msg.text) {
      await forwardBot.api.sendMessage(GROUP_ID, `${nick} ${msg.text}`);
    } else {
      await forwardBot.api.sendMessage(GROUP_ID, `${nick} [不支持的消息类型]`);
    }
  } catch (e) {
    console.error("转发失败:", e.message);
  }
}
