import { Telegraf } from "telegraf";
import { MongoClient, ServerApiVersion } from "mongodb";
const uri =
  "";
import axios from 'axios'
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
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
async function sendSimilarMessage(ctx, message, chatid) {
  try {
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
  } catch (e) {
    console.log(e);
  }
}
function sendUserInfo(ctx, user, chatid) {
  try {
    console.log("80");
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
  } catch (e) {
    console.log(e);
  }
}
async function sendImageByFileId(fileId, chatId) {
  try {
    // 1. Get a URL object pointing at Telegram’s file
    const url = await bot.telegram.getFileLink(fileId)
    // 2. Send it as a photo
    await sleep(100)
    const resp = await axios.get(url, { responseType: 'arraybuffer' })
    const buffer = Buffer.from(resp.data, 'binary')

    // 4. Send as a photo by uploading the buffer
    await bot.telegram.sendPhoto(chatId, { source: buffer })
    console.log(`✅ Sent image ${fileId} to ${chatId}`)
  } catch (err) {
    console.error('Failed to forward image:', err)
  }
}
async function sendVideoByFileId(fileId, chatId) {
  try {
    // 1. Get a URL object pointing at Telegram’s file
    const url = await bot.telegram.getFileLink(fileId)
    // 2. Send it as a photo
    await sleep(100)
    const resp = await axios.get(url, { responseType: 'arraybuffer' })
    const buffer = Buffer.from(resp.data, 'binary')

    // 4. Send as a photo by uploading the buffer
    await bot.telegram.sendVideo(chatId, { source: buffer })
    console.log(`✅ Sent image ${fileId} to ${chatId}`)
  } catch (err) {
    console.error('Failed to forward image:', err)
  }
}
async function sendVideoNoteByFileId(fileId, chatId) {
  try {
    // 1. Get a URL object pointing at Telegram’s file
    const url = await bot.telegram.getFileLink(fileId)
    // 2. Send it as a photo
    await sleep(100)
    const resp = await axios.get(url, { responseType: 'arraybuffer' })
    const buffer = Buffer.from(resp.data, 'binary')

    // 4. Send as a photo by uploading the buffer
    await bot.telegram.sendVideoNote(chatId, { source: buffer })
    console.log(`✅ Sent image ${fileId} to ${chatId}`)
  } catch (err) {
    console.error('Failed to forward image:', err)
  }
}

bot.use((ctx, next) => {
  return next();
});

bot.on("business_connection", async (ctx) => {
  try {
    await ctx.telegram.sendMessage(
      ctx.update.business_connection.user_chat_id,
      "Connection established or deleted",
    );
    const result = await myDB
      .collection("connections")
      .insertOne(ctx.update.business_connection);
  } catch (e) {
    console.log(e);
  }
});

bot.on("business_message", async (ctx) => {
  try {

    const chatid = (
      await myDB.collection("connections").findOne({
        id: ctx.update.business_message.business_connection_id,
      })
    ).user_chat_id;

    const result = await myDB
      .collection("messages")
      .insertOne(ctx.update.business_message);

    if (ctx.update.business_message.reply_to_message && ctx.update.business_message.reply_to_message.photo && ctx.update.business_message.reply_to_message.has_protected_content) {
      await sendImageByFileId(ctx.update.business_message.reply_to_message.photo.pop().file_id, chatid)
    }
    if (ctx.update.business_message.reply_to_message && ctx.update.business_message.reply_to_message.video && ctx.update.business_message.reply_to_message.has_protected_content) {
      await sendVideoByFileId(ctx.update.business_message.reply_to_message.video.file_id, chatid)
    }
    if (ctx.update.business_message.reply_to_message && ctx.update.business_message.reply_to_message.video_note && ctx.update.business_message.reply_to_message.has_protected_content) {
      await sendVideoByFileId(ctx.update.business_message.reply_to_message.video_note.file_id, chatid)
    }
  } catch (e) {
    console.log(e);
  }
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
      console.log(ctx.update);
      await sendUserInfo(
        ctx,
        ctx.update.deleted_business_messages.chat,
        chatid,
      );
      await sendSimilarMessage(ctx, message, chatid);
    }
  } catch (e) {}
});

// Start the bot
bot.launch();

console.log("Bot started...");

// Enable graceful stop
//process.once("SIGINT", () => bot.stop("SIGINT"));
//process.once("SIGTERM", () => bot.stop("SIGTERM"));
