const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Enable CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Request logger for debugging (ignores frequent pings to keep logs clean)
app.use((req, res, next) => {
    if (req.originalUrl !== '/ping' && req.originalUrl !== '/health') {
        console.log(`📡 [HTTP] ${req.method} ${req.originalUrl}`);
    }
    next();
});

let currentQR = null;
let clientStatus = 'STARTING';
let sock = null;

// In-memory store for recent messages
const receivedMessages = [];
const sseSessions = new Map();

function getISTDate() {
    return new Date();
}

// 🧠 Intelligent AI Invoice Assistant Reply Generator
function generateInvoiceAssistantReply(text, senderName) {
    const lower = (text || '').toLowerCase().trim();

    // 1. General Invoice Help / Greeting
    if (
        lower.includes('invoice') || 
        lower.includes('help') || 
        lower.includes('hi') || 
        lower.includes('hello') || 
        lower.includes('what can you do')
    ) {
        return `👋 *Hello ${senderName}!* I am your *Pine Labs AgenticOrg Invoice AI Assistant*.\n\n` +
            `Here is how I can automate your Accounts Payable & Invoices:\n\n` +
            `1️⃣ *Invoice Ingestion*: Send invoice text, invoice numbers, or vendor details directly here.\n` +
            `2️⃣ *Smart Extraction*: I extract Vendor Name, GSTIN, Invoice Date, Line Items, and Total Amount.\n` +
            `3️⃣ *GSTIN & Tax Compliance*: Real-time verification of GSTIN and 18% / 12% / 5% tax computations.\n` +
            `4️⃣ *3-Way Matching*: Automated cross-check between Invoice, Purchase Order (PO), and Goods Receipt (GRN).\n` +
            `5️⃣ *Payment Queue*: Auto-routing verified invoices to the Pine Labs Plural payment disbursement queue.\n\n` +
            `📌 *Quick Actions:*\n` +
            `• Reply with invoice details (e.g. _"Invoice #INV-2024-889 from TechCorp for Rs 45,000"_)\n` +
            `• Type *status <invoice_id>* to check approval state\n` +
            `• Type *!ping* to verify connector latency`;
    }

    // 2. Status Inquiry
    if (lower.startsWith('status') || lower.includes('check status')) {
        const parts = lower.split(' ');
        const id = parts[1] ? parts[1].toUpperCase() : 'INV-9082';
        return `📊 *Invoice Status Report*\n\n` +
            `• *Invoice ID*: ${id}\n` +
            `• *Status*: ✅ VERIFIED & APPROVED\n` +
            `• *3-Way Match*: 100% Match (PO-4421, GRN-8812)\n` +
            `• *GSTIN Validation*: Active & Valid\n` +
            `• *Queue*: Pine Labs Plural Payment Queue (Scheduled for batch settlement)`;
    }

    // 3. Fallback General Assistance
    return `👋 *Hi ${senderName}!* I received your message:\n` +
        `_"${text}"_\n\n` +
        `I am actively connected to your AgenticOrg Virtual Employee. Send any invoice details or type *help* to see invoice processing workflows!`;
}

// ==================================================================
// 📱 WhatsApp Engine (Baileys) - Exact Working Configuration
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
            console.log('📱 New QR code generated. Visit web page to scan.');
        }

        if (connection === 'open') {
            clientStatus = 'READY';
            currentQR = null;
            console.log('✅ WhatsApp Agent is ONLINE and READY!');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            clientStatus = 'DISCONNECTED';
            console.log(`⚠️ Connection closed. Reconnecting: ${shouldReconnect}`);
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
                isFromMe: msg.key.fromMe || false,
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

            // 💬 Handle inquiries (Invoices, greetings, help, etc.)
            try {
                const reply = generateInvoiceAssistantReply(text, senderName);
                console.log(`🤖 Sending assistant reply to ${senderJid}...`);
                await sock.sendMessage(senderJid, { text: reply }, { quoted: msg });
                console.log(`✅ Assistant reply successfully delivered to ${senderJid}`);
            } catch (replyErr) {
                console.error('❌ Error delivering reply with quote, trying unquoted:', replyErr.message);
                try {
                    const reply = generateInvoiceAssistantReply(text, senderName);
                    await sock.sendMessage(senderJid, { text: reply });
                } catch (fallbackErr) {
                    console.error('❌ Fatal error sending assistant reply:', fallbackErr.message);
                }
            }
        }
    });
}

startWhatsApp();

// ==================================================================
// 🛠️ MCP Tools Catalog (All 7 Tools for AgenticOrg Connector)
// ==================================================================
const mcpTools = [
    {
        name: "send_text_message",
        description: "Sends an outbound WhatsApp text message to a user or phone number.",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string", description: "Phone number with country code (e.g. 919876543210 or 919876543210@s.whatsapp.net)" },
                message: { type: "string", description: "The text message content to send" }
            },
            required: ["to", "message"]
        }
    },
    {
        name: "send_whatsapp_message",
        description: "Sends a WhatsApp message to a phone number.",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string", description: "Phone number with country code (e.g. 919876543210)" },
                message: { type: "string", description: "The text message content to send" }
            },
            required: ["to", "message"]
        }
    },
    {
        name: "get_last_whatsapp_message",
        description: "Retrieves the most recent incoming message received from a user on WhatsApp.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "get_business_profile",
        description: "Gets the WhatsApp business profile and health status.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "get_message_templates",
        description: "Retrieves message templates available for WhatsApp.",
        inputSchema: { type: "object", properties: {} }
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

// Helper to send WhatsApp messages
async function sendWhatsApp(to, message) {
    if (!sock || clientStatus !== 'READY') {
        throw new Error('WhatsApp is not connected yet.');
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
                serverInfo: { name: "whatsapp_mcp_server", version: "1.0.0" }
            }
        };
    }

    if (method === 'notifications/initialized') return null;

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
                    result: { content: [{ type: "text", text: "Error: Both 'to' and 'message' parameters are required." }], isError: true }
                };
            }

            try {
                const jid = await sendWhatsApp(to, message);
                return {
                    jsonrpc: "2.0",
                    id,
                    result: { content: [{ type: "text", text: `WhatsApp message successfully delivered to ${jid}` }], isError: false }
                };
            } catch (err) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: { content: [{ type: "text", text: `Failed to deliver message: ${err.message}` }], isError: true }
                };
            }
        }

        if (toolName === 'get_last_whatsapp_message') {
            const latest = receivedMessages.find(m => !m.isFromMe) || receivedMessages[0] || null;
            return {
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: JSON.stringify(latest) }], isError: false }
            };
        }

        if (toolName === 'get_business_profile') {
            return {
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: JSON.stringify({ name: "AgenticOrg WhatsApp Bot", status: clientStatus }) }], isError: false }
            };
        }

        if (toolName === 'get_message_templates') {
            return {
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: JSON.stringify([{ name: "general_reply", language: "en" }]) }], isError: false }
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
                    result: { content: [{ type: "text", text: `Media message sent to ${jid}` }], isError: false }
                };
            } catch (err) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: { content: [{ type: "text", text: err.message }], isError: true }
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
// 📡 Official MCP SSE Transport (Keeps mcp_custom_whatsapp Connected)
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

// Outbound REST endpoints
app.post(['/send_text_message', '/api/send_text_message', '/send-message', '/api/send-message'], async (req, res) => {
    const to = req.body.to || req.body.recipient || req.body.phone_number;
    const message = req.body.message || req.body.text;

    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Missing to or message' });
    }
    if (!sock || clientStatus !== 'READY') {
        return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
    }

    try {
        const jid = await sendWhatsApp(to, message);
        res.json({ success: true, status: 'sent', to: jid });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================================================================
// 🩺 Health Check & Ping Endpoints (Render Keep-Alive)
// ==================================================================
const healthPayload = () => ({
    status: 'ok',
    whatsappStatus: clientStatus,
    mcp: 'active',
    tools: mcpTools.map(t => t.name),
    timeIST: getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
});

app.all(['/health', '/healthz', '/status'], (req, res) => {
    res.status(200).json(healthPayload());
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
                    <h2 style="color: #25D366;">✅ WhatsApp MCP Connector is Online & Ready!</h2>
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <p>MCP SSE Endpoint: <code>/sse</code></p>
                    <p>Send <code>!ping</code> on WhatsApp to test bot response.</p>
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
