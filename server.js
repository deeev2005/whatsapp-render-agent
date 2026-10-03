const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Enable CORS for all MCP requests
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Request logger
app.use((req, res, next) => {
    if (req.originalUrl !== '/ping' && req.originalUrl !== '/health') {
        console.log(`📡 [HTTP] ${req.method} ${req.originalUrl}`);
    }
    next();
});

let currentQR = null;
let clientStatus = 'STARTING';
let sock = null;

const receivedMessages = [];
const sseSessions = new Map();

// Workflow webhook config (set in Render env vars)
const AGENT_WEBHOOK_URL = (process.env.AGENT_WEBHOOK_URL || '').trim();
const AGENT_API_KEY = (process.env.AGENT_API_KEY || '').trim();

// Debug startup info
console.log(`🔍 [DEBUG] Node ${process.version} | fetch available: ${typeof fetch === 'function'}`);
console.log(`🔍 [DEBUG] AGENT_WEBHOOK_URL set: ${!!AGENT_WEBHOOK_URL}${AGENT_WEBHOOK_URL ? ` -> ${AGENT_WEBHOOK_URL}` : ''}`);
console.log(`🔍 [DEBUG] AGENT_API_KEY set: ${!!AGENT_API_KEY}`);

// Media config (set in Render env vars)
const MEDIA_DIR = process.env.MEDIA_DIR || './media';
const MAX_MEDIA_BYTES = (Number(process.env.MAX_MEDIA_MB) || 20) * 1024 * 1024;
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Media helpers
const MEDIA_TYPES = {
    imageMessage: 'image',
    videoMessage: 'video',
    audioMessage: 'audio',
    documentMessage: 'document'
};

const MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
};

const EXT_MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime',
    ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', opus: 'audio/ogg',
    pdf: 'application/pdf', txt: 'text/plain', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function extFor(mimeType, fileName) {
    const fromName = fileName ? path.extname(fileName).slice(1).toLowerCase() : '';
    if (fromName) return fromName.replace(/[^a-z0-9]/g, '') || 'bin';
    const base = String(mimeType || '').split(';')[0].trim();
    return MIME_EXT[base] || 'bin';
}

// 🆕 JID helpers (self-chat detection + message age)
function jidDigits(jid) {
    return String(jid || '').split('@')[0].split(':')[0];
}

function isSelfChat(jid) {
    const other = jidDigits(jid);
    const me = jidDigits(sock?.user?.id);
    const meLid = jidDigits(sock?.user?.lid);
    return !!other && (other === me || (!!meLid && other === meLid));
}

function tsToSeconds(ts) {
    if (!ts) return 0;
    if (typeof ts === 'object' && typeof ts.toNumber === 'function') return ts.toNumber();
    return Number(ts) || 0;
}

// Download an incoming media message and save it to disk
async function saveIncomingMedia(msg, mediaMsg, type) {
    const info = {
        type,
        mimeType: mediaMsg.mimetype || null,
        fileName: mediaMsg.fileName || null
    };
    const sizeBytes = Number(mediaMsg.fileLength || 0);
    if (sizeBytes > MAX_MEDIA_BYTES) {
        return { ...info, error: 'file_too_large' };
    }
    try {
        const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
        );
        const name = `${crypto.randomUUID()}.${extFor(info.mimeType, info.fileName)}`;
        await fs.promises.writeFile(path.join(MEDIA_DIR, name), buffer);
        return { ...info, url: `${RENDER_URL}/media/${name}` };
    } catch (err) {
        console.error('❌ Media download failed:', err.message);
        return { ...info, error: err.message };
    }
}

function getISTDate() {
    return new Date();
}

// Trigger the workflow with the incoming message (workflow sends the reply itself)
async function triggerWorkflow(record) {
    const headers = { 'Content-Type': 'application/json' };
    if (AGENT_API_KEY) headers['Authorization'] = `Bearer ${AGENT_API_KEY}`;

    const payload = {
        channel: 'whatsapp',
        message: record.text,
        sender: record.sender,
        senderName: record.senderName,
        session_id: record.sender,
        mediaType: record.mediaType,
        mediaUrl: record.mediaUrl,
        mimeType: record.mimeType,
        fileName: record.fileName
    };

    console.log(`🔍 [DEBUG] POST ${AGENT_WEBHOOK_URL}`);
    console.log(`🔍 [DEBUG] Payload: ${JSON.stringify(payload)}`);

    const resp = await fetch(AGENT_WEBHOOK_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    const respBody = await resp.text();
    console.log(`🔍 [DEBUG] Webhook response: HTTP ${resp.status} | ${respBody.slice(0, 300)}`);

    if (!resp.ok) throw new Error(`Workflow webhook responded with HTTP ${resp.status}: ${respBody.slice(0, 200)}`);
}

// ==================================================================
// 📱 WhatsApp Engine (Baileys)
// ==================================================================
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            clientStatus = 'AWAITING_SCAN';
            QRCode.toDataURL(qr, (err, url) => {
                if (!err) currentQR = url;
            });
            console.log('📱 New QR code generated. Scan via: https://whatsapp-render-agent.onrender.com');
        }

        if (connection === 'open') {
            clientStatus = 'READY';
            currentQR = null;
            console.log('✅ WhatsApp Agent is ONLINE and READY to receive/send messages!');
            console.log(`🔍 [DEBUG] Logged in as id=${sock?.user?.id} lid=${sock?.user?.lid || 'n/a'}`);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            clientStatus = 'DISCONNECTED';
            console.log(`⚠️ WhatsApp Connection closed. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                startWhatsApp();
            }
        }
    });

    // 📩 Bulletproof Message Handler
    sock.ev.on('messages.upsert', async (upsert) => {
        const messages = upsert.messages || [];
        console.log(`🔍 [DEBUG] messages.upsert type="${upsert.type}" count=${messages.length}`);

        for (const msg of messages) {
            if (!msg.message) {
                console.log('🔍 [DEBUG] Skipped: message has no content');
                continue;
            }

            const senderJid = msg.key.remoteJid;
            if (!senderJid || senderJid === 'status@broadcast') {
                console.log(`🔍 [DEBUG] Skipped: remoteJid is "${senderJid}"`);
                continue;
            }

            // Unwrap ephemeral / view-once / document-with-caption wrappers
            const content =
                msg.message.ephemeralMessage?.message ||
                msg.message.viewOnceMessage?.message ||
                msg.message.viewOnceMessageV2?.message ||
                msg.message.documentWithCaptionMessage?.message ||
                msg.message;

            // Extract message text across all possible WhatsApp message structures
            const text = 
                content.conversation || 
                content.extendedTextMessage?.text || 
                content.imageMessage?.caption ||
                content.videoMessage?.caption ||
                content.documentMessage?.caption ||
                '';

            const senderName = msg.pushName || 'User';

            // 🆕 Who sent it, and is it safe to process?
            const fromMe = !!msg.key.fromMe;
            const isGroup = senderJid.endsWith('@g.us');
            const selfChat = fromMe && isSelfChat(senderJid);
            const ts = tsToSeconds(msg.messageTimestamp);
            const ageSec = ts ? Math.round(Date.now() / 1000 - ts) : 0;
            // Bot's own replies echo back as type "append" in the self-chat, so only "notify" counts as typed by you
            const canProcess = !isGroup && (!fromMe || (selfChat && upsert.type === 'notify'));

            // Download media
            const mediaKey = Object.keys(MEDIA_TYPES).find(k => content[k]);
            let media = null;
            if (mediaKey && canProcess) {
                media = await saveIncomingMedia(msg, content[mediaKey], MEDIA_TYPES[mediaKey]);
            }

            // Print every incoming message to Render logs
            console.log(
                `📩 [WhatsApp RAW] From: ${senderJid} (${senderName}) | type: ${upsert.type} | fromMe: ${fromMe} | selfChat: ${selfChat} | age: ${ageSec}s | Text: "${text}"` +
                (media ? ` | Media: ${media.type} ${media.url || media.error}` : '')
            );

            if (!text && !media) {
                console.log('🔍 [DEBUG] Skipped: no text and no media');
                continue;
            }

            const record = {
                id: msg.key.id,
                sender: senderJid,
                senderName: senderName,
                text: text,
                timestamp: new Date().toISOString(),
                isFromMe: fromMe,
                processed: false,
                mediaType: media?.type || null,
                mimeType: media?.mimeType || null,
                fileName: media?.fileName || null,
                mediaUrl: media?.url || null,
                mediaError: media?.error || null
            };
            receivedMessages.unshift(record);
            if (receivedMessages.length > 50) receivedMessages.pop();

            // 🏓 Handle !ping command (handles '!ping', '!ping ', case-insensitive)
            if (text.toLowerCase().trim() === '!ping') {
                try {
                    console.log(`🏓 Triggering pong reply to ${senderJid}...`);
                    await sock.sendMessage(senderJid, { 
                        text: 'pong! 🏓 WhatsApp Connector is active and connected.' 
                    }, { quoted: msg });
                    console.log(`✅ Pong reply successfully delivered to ${senderJid}`);
                } catch (replyErr) {
                    console.error('❌ Error delivering pong reply with quote, trying unquoted:', replyErr.message);
                    try {
                        await sock.sendMessage(senderJid, { 
                            text: 'pong! 🏓 WhatsApp Connector is active and connected.' 
                        });
                    } catch (fallbackErr) {
                        console.error('❌ Fatal error sending pong:', fallbackErr.message);
                    }
                }
                console.log('🔍 [DEBUG] Not forwarding: !ping is handled locally');
                continue;
            }

            // Trigger workflow
            const skipReason =
                !AGENT_WEBHOOK_URL ? 'AGENT_WEBHOOK_URL is not set' :
                isGroup ? 'group chat' :
                fromMe && !selfChat ? 'your own message to another chat (only your self-chat is allowed)' :
                selfChat && upsert.type !== 'notify' ? `echo of a message sent by this server (type "${upsert.type}")` :
                upsert.type !== 'notify' && ageSec > 120 ? `old message (${ageSec}s old, type "${upsert.type}")` :
                null;

            if (skipReason) {
                console.log(`🔍 [DEBUG] Not forwarding: ${skipReason}`);
            } else {
                console.log(`🤖 Forwarding to workflow: "${text}"`);
                triggerWorkflow(record)
                    .then(() => console.log(`✅ Workflow triggered for ${senderJid}`))
                    .catch((err) => console.error(`❌ Workflow trigger failed: ${err.message}${err.cause ? ` | cause: ${err.cause.message || err.cause}` : ''}`));
            }
        }
    });
}

startWhatsApp();

// ==================================================================
// 🛠️ MCP Tools Catalog (All 7 Tools Explicitly Registered)
// ==================================================================
const mcpTools = [
    {
        name: "send_text_message",
        description: "Sends an outbound WhatsApp text message to a user or phone number.",
        inputSchema: {
            type: "object",
            properties: {
                to: {
                    type: "string",
                    description: "Phone number with country code (e.g. 919876543210 or 919876543210@s.whatsapp.net)"
                },
                message: {
                    type: "string",
                    description: "The text message content to send"
                }
            },
            required: ["to", "message"]
        }
    },
    {
        name: "send_whatsapp_message",
        description: "Alias for sending a WhatsApp message to a phone number.",
        inputSchema: {
            type: "object",
            properties: {
                to: {
                    type: "string",
                    description: "Phone number with country code (e.g. 919876543210)"
                },
                message: {
                    type: "string",
                    description: "The text message content to send"
                }
            },
            required: ["to", "message"]
        }
    },
    {
        name: "get_last_whatsapp_message",
        description: "Retrieves the most recent incoming message received from a user on WhatsApp. If the message has media, the result includes mediaType, mimeType, fileName and mediaUrl.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_business_profile",
        description: "Gets the WhatsApp business profile and health status.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_message_templates",
        description: "Retrieves message templates available for WhatsApp.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "send_media_message",
        description: "Sends a media message (image, video, audio or document) via WhatsApp from a public media URL.",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string" },
                media_url: { type: "string", description: "Public URL of the file to send" },
                caption: { type: "string" },
                media_type: { type: "string", enum: ["image", "video", "audio", "document"], description: "Optional. Guessed from the URL extension if omitted" },
                file_name: { type: "string", description: "Optional file name for documents" },
                mime_type: { type: "string", description: "Optional MIME type" }
            },
            required: ["to", "media_url"]
        }
    },
    {
        name: "send_template_message",
        description: "Sends a template notification message via WhatsApp.",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string" },
                text: { type: "string" }
            },
            required: ["to"]
        }
    }
];

// Core function to send WhatsApp messages
async function sendWhatsApp(to, message) {
    if (!sock || clientStatus !== 'READY') {
        throw new Error('WhatsApp is not connected yet. Please visit the web page and check QR code.');
    }
    const toStr = String(to);
    const cleanNumber = toStr.replace(/[^0-9]/g, '');
    // 🆕 Keep any full JID (@s.whatsapp.net, @lid, ...) as-is
    const jid = toStr.includes('@') ? toStr : `${cleanNumber}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: String(message) });
    console.log(`📤 Successfully sent WhatsApp message to ${jid}: "${message}"`);
    return jid;
}

// Core function to send WhatsApp media from a URL
async function sendWhatsAppMedia(to, mediaUrl, caption, mediaType, fileName, mimeType) {
    if (!sock || clientStatus !== 'READY') {
        throw new Error('WhatsApp is not connected yet. Please visit the web page and check QR code.');
    }
    const toStr = String(to);
    const cleanNumber = toStr.replace(/[^0-9]/g, '');
    // 🆕 Keep any full JID (@s.whatsapp.net, @lid, ...) as-is
    const jid = toStr.includes('@') ? toStr : `${cleanNumber}@s.whatsapp.net`;

    const urlPath = new URL(mediaUrl).pathname;
    const ext = path.extname(urlPath).slice(1).toLowerCase();

    let type = mediaType;
    if (!type) {
        if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) type = 'image';
        else if (['mp4', 'mov', 'mkv'].includes(ext)) type = 'video';
        else if (['ogg', 'mp3', 'm4a', 'wav', 'opus'].includes(ext)) type = 'audio';
        else type = 'document';
    }
    const mime = mimeType || EXT_MIME[ext] || 'application/octet-stream';

    let payload;
    if (type === 'image') {
        payload = { image: { url: mediaUrl }, caption: caption || undefined };
    } else if (type === 'video') {
        payload = { video: { url: mediaUrl }, caption: caption || undefined };
    } else if (type === 'audio') {
        payload = { audio: { url: mediaUrl }, mimetype: mime, ptt: false };
    } else {
        payload = {
            document: { url: mediaUrl },
            mimetype: mime,
            fileName: fileName || path.basename(urlPath) || 'file',
            caption: caption || undefined
        };
    }

    await sock.sendMessage(jid, payload);
    if (type === 'audio' && caption) {
        await sock.sendMessage(jid, { text: String(caption) });
    }
    console.log(`📤 Successfully sent WhatsApp ${type} to ${jid}: ${mediaUrl}`);
    return jid;
}

// MCP JSON-RPC Handler
async function handleMcpRpc(request) {
    const { method, params, id } = request;

    if (method === 'initialize') {
        return {
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: { listChanged: false } },
                serverInfo: {
                    name: "whatsapp_mcp_server",
                    version: "1.0.0"
                }
            }
        };
    }

    if (method === 'notifications/initialized') {
        return null;
    }

    if (method === 'tools/list') {
        return {
            jsonrpc: "2.0",
            id,
            result: { tools: mcpTools }
        };
    }

    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};

        console.log(`⚡ [MCP TOOL CALL] ${toolName} with args:`, JSON.stringify(args));

        if (toolName === 'send_text_message' || toolName === 'send_whatsapp_message' || toolName === 'send_template_message') {
            const to = args.to || args.recipient || args.phone_number || args.recipient_id;
            const message = args.message || args.text || args.body;

            if (!to || !message) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: "Error: Both 'to' and 'message' parameters are required." }],
                        isError: true
                    }
                };
            }

            try {
                const jid = await sendWhatsApp(to, message);
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: `WhatsApp message successfully delivered to ${jid}` }],
                        isError: false
                    }
                };
            } catch (err) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: `Failed to deliver WhatsApp message: ${err.message}` }],
                        isError: true
                    }
                };
            }
        }

        if (toolName === 'get_last_whatsapp_message') {
            // Oldest unprocessed incoming message (list is newest-first, so take the last match)
            const pending = receivedMessages.filter(
                m => !m.processed && !m.isFromMe && !m.sender.endsWith('@g.us')
            );
            const next = pending.length ? pending[pending.length - 1] : null;
            if (next) next.processed = true;
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{ type: "text", text: next ? JSON.stringify(next) : JSON.stringify({ no_new_message: true }) }],
                    isError: false
                }
            };
        }

        if (toolName === 'get_business_profile') {
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{ type: "text", text: JSON.stringify({ name: "WhatsApp Agent", status: clientStatus }) }],
                    isError: false
                }
            };
        }

        if (toolName === 'get_message_templates') {
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{ type: "text", text: JSON.stringify([{ name: "general_reply", language: "en" }]) }],
                    isError: false
                }
            };
        }

        if (toolName === 'send_media_message') {
            try {
                const to = args.to || args.recipient;
                const mediaUrl = args.media_url || args.url;
                const caption = args.caption || args.text || '';

                if (!to || !mediaUrl) {
                    return {
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: "Error: Both 'to' and 'media_url' parameters are required." }],
                            isError: true
                        }
                    };
                }

                const jid = await sendWhatsAppMedia(to, mediaUrl, caption, args.media_type, args.file_name, args.mime_type);
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: `Media message sent to ${jid}` }],
                        isError: false
                    }
                };
            } catch (err) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: err.message }],
                        isError: true
                    }
                };
            }
        }
    }

    return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
    };
}

// ==================================================================
// 📡 Official MCP SSE Transport
// ==================================================================
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://whatsapp-render-agent.onrender.com';

app.get(['/sse', '/mcp/sse'], (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sessionId = crypto.randomUUID();
    sseSessions.set(sessionId, res);

    console.log(`🔌 MCP SSE client connected: session ${sessionId}`);

    const endpointUrl = `${RENDER_URL}/messages?sessionId=${sessionId}`;
    res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

    const heartbeat = setInterval(() => {
        res.write(`: ping\n\n`);
    }, 10000);

    req.on('close', () => {
        clearInterval(heartbeat);
        console.log(`🔌 MCP SSE client disconnected: session ${sessionId}`);
        sseSessions.delete(sessionId);
    });
});

app.post(['/messages', '/mcp/messages'], async (req, res) => {
    const sessionId = req.query.sessionId;
    const body = req.body;

    console.log(`📩 MCP Request:`, body?.method, body?.params?.name || '');

    const response = await handleMcpRpc(body);

    if (sessionId && sseSessions.has(sessionId)) {
        const clientRes = sseSessions.get(sessionId);
        if (response) {
            clientRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        }
        res.status(202).send('Accepted');
    } else {
        res.json(response || { status: 'acknowledged' });
    }
});

// REST Fallback for tools
app.all(['/tools', '/api/tools'], (req, res) => {
    res.json({ tools: mcpTools });
});

// Serve saved media files
app.get('/media/:name', (req, res) => {
    const name = path.basename(req.params.name);
    const filePath = path.resolve(MEDIA_DIR, name);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    res.sendFile(filePath);
});

// ==================================================================
// 🔍 Debug routes (only active when DEBUG_ROUTES=true in Render env)
// ==================================================================
function debugOnly(req, res, next) {
    if (process.env.DEBUG_ROUTES !== 'true') return res.status(404).send('Not found');
    next();
}

// Fires a fake message at the n8n webhook, no WhatsApp needed
app.get('/debug/webhook-test', debugOnly, async (req, res) => {
    if (!AGENT_WEBHOOK_URL) return res.json({ ok: false, error: 'AGENT_WEBHOOK_URL is not set' });
    try {
        await triggerWorkflow({
            id: 'debug-test',
            sender: '919999999999@s.whatsapp.net',
            senderName: 'Debug',
            text: 'debug test message',
            mediaType: null,
            mimeType: null,
            fileName: null,
            mediaUrl: null
        });
        res.json({ ok: true, url: AGENT_WEBHOOK_URL });
    } catch (err) {
        res.json({ ok: false, url: AGENT_WEBHOOK_URL, error: err.message, cause: err.cause?.message || null });
    }
});

app.get('/debug/config', debugOnly, (req, res) => {
    res.json({
        webhookConfigured: !!AGENT_WEBHOOK_URL,
        webhookUrl: AGENT_WEBHOOK_URL || null,
        apiKeySet: !!AGENT_API_KEY,
        whatsappStatus: clientStatus,
        loggedInAs: sock?.user?.id || null,
        nodeVersion: process.version,
        hasFetch: typeof fetch === 'function'
    });
});

app.get('/debug/messages', debugOnly, (req, res) => {
    res.json(receivedMessages);
});

// ==================================================================
// 🩺 Health Check & Ping Endpoints (Render Keep-Alive)
// ==================================================================
app.get(['/health', '/status'], (req, res) => {
    res.status(200).json({
        status: 'ok',
        whatsappStatus: clientStatus,
        mcp: 'active',
        tools: mcpTools.map(t => t.name),
        timeIST: getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    });
});

app.get('/ping', (req, res) => res.status(200).send('OK'));

// ==================================================================
// 📱 Web Dashboard
// ==================================================================
app.get('/', (req, res) => {
    if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
        return res.redirect(307, '/sse');
    }

    if (clientStatus === 'READY') {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2 style="color: #25D366;">✅ WhatsApp MCP Connector Server is Online!</h2>
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <p>All 7 MCP Tools Active & Registered.</p>
                </body>
            </html>
        `);
    } else if (currentQR) {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2>📱 Scan this QR Code with WhatsApp</h2>
                    <img src="${currentQR}" width="280" style="border: 1px solid #ccc; padding: 10px; border-radius: 8px;" />
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <script>setTimeout(() => location.reload(), 15000);</script>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2>⏳ WhatsApp Status: ${clientStatus}</h2>
                    <script>setTimeout(() => location.reload(), 3000);</script>
                </body>
            </html>
        `);
    }
});

// ==================================================================
// 🚀 SERVER START
// ==================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Server started on port ${PORT}`);
});
