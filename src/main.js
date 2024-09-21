import { Telegraf } from "telegraf";
import { MongoClient, ServerApiVersion } from "mongodb";
const uri = "";

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
const myDB = client.db("businessbot");
console.log();
const bot = new Telegraf("");

async function sendSimilarMessage(ctx, message, chatid) {
  const chatId = chatid;

  if (message.text) {
    // Text message
    await ctx.telegram.sendMessage(chatId, message.text, {
      entities: message.entities,
    });
  } else if (message.photo) {
    // Photo message
    const photo = message.photo[message.photo.length - 1];
    await ctx.telegram.sendPhoto(chatId, photo.file_id, {
      caption: message.caption,
      caption_entities: message.caption_entities,
    });
  } else if (message.document) {
    // Document message
    await ctx.telegram.sendDocument(chatId, message.document.file_id, {
      caption: message.caption,
      caption_entities: message.caption_entities,
    });
  } else if (message.video) {
    // Video message
    await ctx.telegram.sendVideo(chatId, message.video.file_id, {
      caption: message.caption,
      caption_entities: message.caption_entities,
    });
  } else if (message.video_note) {
    // Video Note message
    ctx.telegram.sendVideoNote(chatId, message.video_note.file_id);
  } else if (message.sticker) {
    // Sticker message
    await ctx.telegram.sendSticker(chatId, message.sticker.file_id);
  } else if (message.audio) {
    // Audio message
    await ctx.telegram.sendAudio(chatId, message.audio.file_id, {
      caption: message.caption,
      caption_entities: message.caption_entities,
    });
  } else if (message.voice) {
    // Voice message
    await ctx.telegram.sendVoice(chatId, message.voice.file_id, {
      caption: message.caption,
      caption_entities: message.caption_entities,
    });
  } else if (message.animation) {
    // Animation message (GIF)
    await ctx.telegram.sendAnimation(chatId, message.animation.file_id, {
      caption: message.caption,
      caption_entities: message.caption_entities,
    });
  } else {
    await ctx.telegram.sendMessage(chatId, "Unsupported message type");
  }
}
function sendUserInfo(ctx, user, chatid) {
  // Function to escape special characters for MarkdownV2
  function escapeMarkdownV2(text) {
    if (!text) return "";
    return text.replace(/([_*[\]()~`>#+-=|{}.!])/g, "\\$1");
  }

  // Construct the message with general user information
  let message = `👤 User Information:\n`;
  message += `First Name: ${user.first_name}\n`;

  if (user.last_name) {
    message += `Last Name: ${user.last_name}\n`;
  }

  if (user.username) {
    message += `Username: @${user.username}\n`;
  }
  // For users without a username, use tg://user?id=USER_ID
  message += `Profile Link: tg://user?id=${user.id}\n`;

  if ("is_premium" in user) {
    message += `Telegram Premium User: ${user.is_premium ? "Yes" : "No"}\n`;
  }

  // Send the message with MarkdownV2 formatting
  ctx.telegram.sendMessage(chatid, escapeMarkdownV2(message), {
    parse_mode: "MarkdownV2",
  });
}

// Middleware to log every update
bot.use((ctx, next) => {
  //console.log("Received update:", ctx.update);
  return next();
});

bot.on("business_connection", async (ctx) => {
  await ctx.telegram.sendMessage(
    ctx.update.business_connection.user_chat_id,
    "Connection established or deleted",
  );
  const result = await myDB
    .collection("connections")
    .insertOne(ctx.update.business_connection);
});

bot.on("business_message", async (ctx) => {
  const result = await myDB
    .collection("messages")
    .insertOne(ctx.update.business_message);
  //await sendSimilarMessage(ctx, ctx.update.business_message, 1172111439);
});

bot.on("edited_business_message", async (ctx) => {
  try {
    const chatid = (
      await myDB.collection("connections").findOne({
        id: ctx.update.edited_business_message.business_connection_id,
      })
    ).user_chat_id;
    await ctx.telegram.sendMessage(chatid, `Message was edited in chat`);
    const message = await myDB.collection("messages").findOne({
      message_id: ctx.update.edited_business_message.message_id,
      business_connection_id:
        ctx.update.edited_business_message.business_connection_id,
    });
    sendUserInfo(ctx, ctx.update.edited_business_message.chat, chatid);
    if (message != null) {
      await sendSimilarMessage(ctx, message, chatid);
    }

    const deleteResult = await myDB.collection("messages").deleteOne({
      message_id: ctx.update.edited_business_message.message_id,
      business_connection_id:
        ctx.update.edited_business_message.business_connection_id,
    });
    const result = await myDB
      .collection("messages")
      .insertOne(ctx.update.edited_business_message);
  } catch (e) {}
});

bot.on("deleted_business_messages", async (ctx) => {
  try {
    const chatid = (
      await myDB.collection("connections").findOne({
        id: ctx.update.deleted_business_messages.business_connection_id,
      })
    ).user_chat_id;
    await ctx.telegram.sendMessage(chatid, `Message was deleted in chat`);
    for (const message_id of ctx.update.deleted_business_messages.message_ids) {
      const message = await myDB.collection("messages").findOne({
        message_id: message_id,
        business_connection_id:
          ctx.update.deleted_business_messages.business_connection_id,
      });
      if (message == null) {
        return;
      }
      sendUserInfo(ctx, ctx.update.deleted_business_messages.chat, chatid);
      await sendSimilarMessage(ctx, message, chatid);
    }
  } catch (e) {}
});

// Start the bot
bot.launch();

console.log("Bot started...");

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
