const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Enable CORS for MCP Clients
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-csrf-token');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

let currentQR = null;
let clientStatus = 'STARTING';
let sock = null;

// In-memory store for messages
const receivedMessages = [];

// Active SSE client sessions
const sseSessions = new Map();

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
                await sock.sendMessage(senderJid, { text: 'pong! 🏓 WhatsApp MCP Server is connected.' });
            }
        }
    });
}

startWhatsApp();

// ==================================================================
// 🛠️ MCP Tools Definition Catalog
// ==================================================================
const mcpTools = [
    {
        name: "send_whatsapp_message",
        description: "Sends an outbound WhatsApp text message to a user or merchant.",
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
        description: "Gets the most recently received WhatsApp message.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    }
];

// Helper to handle MCP JSON-RPC requests
async function handleMcpRpc(request) {
    const { method, params, id } = request;

    // 1. Initialize
    if (method === 'initialize') {
        return {
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: {
                    tools: {
                        listChanged: false
                    }
                },
                serverInfo: {
                    name: "whatsapp-mcp-server",
                    version: "1.0.0"
                }
            }
        };
    }

    // 2. Initialized notification
    if (method === 'notifications/initialized') {
        return null;
    }

    // 3. Tools list (Discovery)
    if (method === 'tools/list') {
        return {
            jsonrpc: "2.0",
            id,
            result: {
                tools: mcpTools
            }
        };
    }

    // 4. Tools call (Execution)
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
                        content: [{ type: "text", text: `Message sent successfully to ${jid}` }],
                        isError: false
                    }
                };
            } catch (err) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: `Failed to send: ${err.message}` }],
                        isError: true
                    }
                };
            }
        }

        if (toolName === 'get_last_whatsapp_message') {
            const latest = receivedMessages.find(m => !m.isFromMe) || null;
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

    // Fallback
    return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" }
    };
}

// ==================================================================
// 📡 Official MCP SSE Transport Endpoints (GET /sse & POST /messages)
// ==================================================================

// 1. SSE Connection endpoint
app.get(['/sse', '/mcp/sse'], (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sessionId = crypto.randomUUID();
    sseSessions.set(sessionId, res);

    console.log(`🔌 MCP SSE client connected: session ${sessionId}`);

    // Send the mandatory MCP 'endpoint' event to tell client where to POST messages
    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

    req.on('close', () => {
        console.log(`🔌 MCP SSE client disconnected: session ${sessionId}`);
        sseSessions.delete(sessionId);
    });
});

// 2. MCP Messages endpoint (handles incoming RPC calls from client)
app.post(['/messages', '/mcp/messages'], async (req, res) => {
    const sessionId = req.query.sessionId;
    const body = req.body;

    console.log(`📩 MCP Request [${body.method}]:`, JSON.stringify(body));

    const response = await handleMcpRpc(body);

    if (sessionId && sseSessions.has(sessionId)) {
        const clientRes = sseSessions.get(sessionId);
        if (response) {
            clientRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        }
        res.status(202).send('Accepted');
    } else {
        // Return JSON response directly if no active SSE stream
        res.json(response || { status: 'acknowledged' });
    }
});

// 3. Fallback direct JSON-RPC endpoint
app.post(['/mcp', '/rpc'], async (req, res) => {
    const response = await handleMcpRpc(req.body);
    res.json(response || { status: 'acknowledged' });
});

// 4. Fallback REST tools endpoint
app.get(['/tools', '/api/tools'], (req, res) => {
    res.json({ tools: mcpTools });
});

// ==================================================================
// 🩺 Health Checks & Ping (Keeps Render Awake 24/7)
// ==================================================================
app.get(['/health', '/status', '/ping'], (req, res) => {
    res.status(200).json({
        status: 'ok',
        whatsappStatus: clientStatus,
        mcp: 'active',
        tools: mcpTools.map(t => t.name),
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
                    <p>MCP SSE Endpoint: <code>/sse</code></p>
                    <p>MCP Messages Endpoint: <code>/messages</code></p>
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
    console.log(`🚀 WhatsApp MCP Server running on port ${PORT}`);
});
