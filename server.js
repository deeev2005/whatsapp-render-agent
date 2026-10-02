const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

let currentQR = null;
let clientStatus = 'STARTING';
let sock = null;

// In-memory store for messages
const receivedMessages = [];

function getISTDate() {
    return new Date();
}

// ==================================================================
// 📱 WhatsApp Engine (Baileys)
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
            console.log('📱 New QR code generated. Scan via web page.');
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

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const senderJid = msg.key.remoteJid;
            if (senderJid === 'status@broadcast') continue;

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const senderName = msg.pushName || 'User';
            const isFromMe = msg.key.fromMe;

            if (!text) continue;

            const record = {
                id: msg.key.id,
                sender: senderJid,
                senderName: senderName,
                text: text,
                isFromMe: isFromMe,
                timestamp: new Date().toISOString()
            };

            receivedMessages.unshift(record);
            if (receivedMessages.length > 50) receivedMessages.pop();

            console.log(`📩 [WhatsApp Message from ${senderName}]: ${text}`);

            if (text.toLowerCase() === '!ping') {
                await sock.sendMessage(senderJid, { text: 'pong! 🏓 WhatsApp MCP Server is running stably.' });
            }
        }
    });
}

startWhatsApp();

// ==================================================================
// 🔌 Model Context Protocol (MCP) & Tool Catalog Discovery
// (AgenticOrg calls these endpoints during connector registration)
// ==================================================================

// Tool Definitions Catalog
const toolsCatalog = [
    {
        name: "send_whatsapp_message",
        description: "Sends an outbound WhatsApp message to a customer, merchant, or phone number.",
        parameters: {
            type: "object",
            properties: {
                to: {
                    type: "string",
                    description: "Phone number with country code (e.g. '919876543210' or '919876543210@s.whatsapp.net')"
                },
                message: {
                    type: "string",
                    description: "The text content of the message to send."
                }
            },
            required: ["to", "message"]
        }
    },
    {
        name: "get_last_whatsapp_message",
        description: "Retrieves the most recent incoming message received from a user on WhatsApp.",
        parameters: {
            type: "object",
            properties: {
                sender_filter: {
                    type: "string",
                    description: "Optional phone number filter"
                }
            }
        }
    },
    {
        name: "list_whatsapp_messages",
        description: "Lists recent WhatsApp messages received by the agent.",
        parameters: {
            type: "object",
            properties: {
                limit: {
                    type: "integer",
                    description: "Number of messages to retrieve (default: 10)"
                }
            }
        }
    }
];

// 1. Tool Discovery Endpoints (MCP standard & OpenAPI formats)
app.get(['/tools', '/api/tools', '/mcp/tools'], (req, res) => {
    res.json({
        tools: toolsCatalog,
        count: toolsCatalog.length
    });
});

// 2. Standard MCP JSON-RPC Endpoint (POST /mcp or POST /rpc)
app.post(['/mcp', '/rpc'], async (req, res) => {
    const { jsonrpc, method, params, id } = req.body;

    // Handle MCP tools/list
    if (method === 'tools/list') {
        return res.json({
            jsonrpc: "2.0",
            result: { tools: toolsCatalog },
            id: id || 1
        });
    }

    // Handle MCP tools/call
    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};

        if (toolName === 'send_whatsapp_message') {
            try {
                const jid = args.to.includes('@s.whatsapp.net') ? args.to : `${args.to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
                if (!sock || clientStatus !== 'READY') {
                    throw new Error('WhatsApp client is not ready');
                }
                await sock.sendMessage(jid, { text: String(args.message) });
                return res.json({
                    jsonrpc: "2.0",
                    result: { content: [{ type: "text", text: `Message sent successfully to ${jid}` }] },
                    id: id || 1
                });
            } catch (err) {
                return res.json({
                    jsonrpc: "2.0",
                    error: { code: -32000, message: err.message },
                    id: id || 1
                });
            }
        }

        if (toolName === 'get_last_whatsapp_message') {
            const latest = receivedMessages.find(m => !m.isFromMe) || null;
            return res.json({
                jsonrpc: "2.0",
                result: { content: [{ type: "text", text: JSON.stringify(latest) }] },
                id: id || 1
            });
        }
    }

    // Default response
    res.json({ jsonrpc: "2.0", result: { status: "acknowledged" }, id: id || 1 });
});

// 3. REST Execution Endpoints (Direct tool invocation)
app.post(['/execute', '/api/execute', '/call', '/api/call'], async (req, res) => {
    const tool = req.body.tool || req.body.name;
    const params = req.body.parameters || req.body.args || req.body;

    if (tool === 'send_whatsapp_message' || req.path.includes('send')) {
        const to = params.to || params.phone_number;
        const message = params.message || params.text;

        if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });
        if (!sock || clientStatus !== 'READY') return res.status(503).json({ error: 'WhatsApp not ready' });

        try {
            const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
            await sock.sendMessage(jid, { text: String(message) });
            return res.json({ success: true, message: `Sent to ${jid}` });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    if (tool === 'get_last_whatsapp_message') {
        const latest = receivedMessages.find(m => !m.isFromMe) || null;
        return res.json({ success: true, message: latest });
    }

    res.json({ success: true, tools: toolsCatalog });
});

// 4. Backward-compatible /send-message route
app.post(['/send-message', '/api/send-message'], async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });
    if (!sock || clientStatus !== 'READY') return res.status(503).json({ error: 'WhatsApp not ready' });

    try {
        const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: String(message) });
        res.json({ success: true, status: 'sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================================================================
// 🩺 Health Checks & Ping (Keeps Render Awake 24/7)
// ==================================================================
app.get(['/health', '/status', '/ping'], (req, res) => {
    res.status(200).json({
        status: 'ok',
        whatsappStatus: clientStatus,
        mcp: 'enabled',
        tools: toolsCatalog.map(t => t.name),
        timeIST: getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    });
});

// ==================================================================
// 📱 Web Dashboard
// ==================================================================
app.get('/', (req, res) => {
    if (clientStatus === 'READY') {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2 style="color: #25D366;">✅ WhatsApp MCP Connector Server is Online!</h2>
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <p>MCP Tool Catalog: <code>GET /tools</code></p>
                    <p>MCP Endpoint: <code>POST /mcp</code></p>
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
    console.log(`🚀 WhatsApp MCP Connector Server running on port ${PORT}`);
});
