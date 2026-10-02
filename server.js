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

// Universal Request Logger for incoming HTTP/MCP calls
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

// ==================================================================
// 📱 WhatsApp Engine (Baileys) - Restored to Your 100% Working Logic
// ==================================================================
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
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

    // 📩 Working Message Handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const senderJid = msg.key.remoteJid;
            if (senderJid === 'status@broadcast') continue;

            // Robust text extraction across message types
            const text = 
                msg.message.conversation || 
                msg.message.extendedTextMessage?.text || 
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                '';

            const senderName = msg.pushName || 'User';

            if (!text) continue;

            // Save to memory for MCP get_last_whatsapp_message tool
            const messageRecord = {
                id: msg.key.id,
                sender: senderJid,
                senderName: senderName,
                text: text,
                isFromMe: msg.key.fromMe || false,
                timestamp: new Date().toISOString()
            };
            receivedMessages.unshift(messageRecord);
            if (receivedMessages.length > 50) receivedMessages.pop();

            console.log(`📩 [WhatsApp Message from ${senderName} (${senderJid})]: "${text}"`);

            // 🏓 Reliable !ping reply (handles '!ping', '!ping ', case-insensitive)
            if (text.toLowerCase().trim() === '!ping') {
                try {
                    console.log(`🏓 Sending 'pong!' reply to ${senderJid}...`);
                    await sock.sendMessage(senderJid, { 
                        text: 'pong! 🏓 WhatsApp Connector is active and connected.' 
                    });
                    console.log(`✅ 'pong!' successfully sent to ${senderJid}`);
                } catch (sendErr) {
                    console.error('❌ Error sending pong reply:', sendErr);
                }
            }
        }
    });
}

startWhatsApp();

// ==================================================================
// 🛠️ MCP Tools Catalog (Used by AgenticOrg mcp_custom_whatsapp)
// ==================================================================
const mcpTools = [
    {
        name: "send_whatsapp_message",
        description: "Sends an outbound WhatsApp text message to a user or phone number.",
        inputSchema: {
            type: "object",
            properties: {
                to: {
                    type: "string",
                    description: "Phone number with country code (e.g. 919876543210)"
                },
                message: {
                    type: "string",
                    description: "The text message to send"
                }
            },
            required: ["to", "message"]
        }
    },
    {
        name: "get_last_whatsapp_message",
        description: "Retrieves the most recent incoming WhatsApp message.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    }
];

// MCP JSON-RPC Handler
async function handleMcpRpc(request) {
    const { method, params, id } = request;

    if (method === 'initialize') {
        return {
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: {
                    tools: { listChanged: false }
                },
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

        if (toolName === 'send_whatsapp_message') {
            try {
                const jid = args.to.includes('@s.whatsapp.net') ? args.to : `${args.to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
                if (!sock || clientStatus !== 'READY') {
                    throw new Error('WhatsApp is not connected yet.');
                }
                await sock.sendMessage(jid, { text: String(args.message) });
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: `Message sent to ${jid}` }],
                        isError: false
                    }
                };
            } catch (err) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: `Error: ${err.message}` }],
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
    }

    return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" }
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

    console.log(`📩 MCP Request:`, body?.method || body);

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

// Outbound REST endpoint: /send-message
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
        const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: String(message) });
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
