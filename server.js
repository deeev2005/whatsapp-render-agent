const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const crypto = require('crypto');

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

// 🆕 Workflow webhook config (set in Render env vars)
const AGENT_WEBHOOK_URL = process.env.AGENT_WEBHOOK_URL || '';
const AGENT_API_KEY = process.env.AGENT_API_KEY || '';

function getISTDate() {
    return new Date();
}

// 🆕 Trigger the workflow with the incoming message (workflow sends the reply itself)
async function triggerWorkflow(record) {
    const headers = { 'Content-Type': 'application/json' };
    if (AGENT_API_KEY) headers['Authorization'] = `Bearer ${AGENT_API_KEY}`;

    const resp = await fetch(AGENT_WEBHOOK_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            channel: 'whatsapp',
            message: record.text,
            sender: record.sender,
            senderName: record.senderName,
            session_id: record.sender
        })
    });

    if (!resp.ok) throw new Error(`Workflow webhook responded with HTTP ${resp.status}`);
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

        for (const msg of messages) {
            if (!msg.message) continue;

            const senderJid = msg.key.remoteJid;
            if (!senderJid || senderJid === 'status@broadcast') continue;

            // Extract message text across all possible WhatsApp message structures
            const text = 
                msg.message.conversation || 
                msg.message.extendedTextMessage?.text || 
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                msg.message.documentMessage?.caption ||
                '';

            const senderName = msg.pushName || 'User';

            // Print every incoming message to Render logs
            console.log(`📩 [WhatsApp RAW] From: ${senderJid} (${senderName}) | Text: "${text}"`);

            if (!text) continue;

            const record = {
                id: msg.key.id,
                sender: senderJid,
                senderName: senderName,
                text: text,
                timestamp: new Date().toISOString()
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
                continue;
            }

            // 🆕 Trigger workflow (skip own messages, groups, and old synced messages)
            if (
                AGENT_WEBHOOK_URL &&
                upsert.type === 'notify' &&
                !msg.key.fromMe &&
                !senderJid.endsWith('@g.us')
            ) {
                console.log(`🤖 Forwarding to workflow: "${text}"`);
                triggerWorkflow(record)
                    .then(() => console.log(`✅ Workflow triggered for ${senderJid}`))
                    .catch((err) => console.error('❌ Workflow trigger failed:', err.message));
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
        description: "Retrieves the most recent incoming message received from a user on WhatsApp.",
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
        description: "Sends a media message (image/document) via WhatsApp.",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string" },
                media_url: { type: "string" },
                caption: { type: "string" }
            },
            required: ["to"]
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
    const cleanNumber = String(to).replace(/[^0-9]/g, '');
    const jid = to.includes('@s.whatsapp.net') ? to : `${cleanNumber}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: String(message) });
    console.log(`📤 Successfully sent WhatsApp message to ${jid}: "${message}"`);
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
            const latest = receivedMessages.find(m => !m.isFromMe) || receivedMessages[0] || null;
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{ type: "text", text: JSON.stringify(latest) }],
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
                const caption = args.caption || args.text || '';
                const jid = await sendWhatsApp(to, caption);
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
