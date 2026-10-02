const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const crypto = require('crypto');
const axios = require('axios');

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

// ==================================================================
// 🤖 AgenticOrg Virtual Employee Configuration (cvgfn)
// ==================================================================
const AGENT_ID = process.env.AGENT_ID || '7db40b4b-5493-485e-83bc-98f2093ea31c';
const AGENTICORG_URL = `https://agenticorg.hackathon.pinelabs.com/api/v1/agents/${AGENT_ID}/run`;

function getISTDate() {
    return new Date();
}

// 🔍 Universal Text Extractor (Unwraps ephemeral, view-once, and extended texts)
function extractMessageText(message) {
    if (!message) return '';
    
    if (message.ephemeralMessage) message = message.ephemeralMessage.message;
    if (message.viewOnceMessage) message = message.viewOnceMessage.message;
    if (message.viewOnceMessageV2) message = message.viewOnceMessageV2.message;

    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.buttonsResponseMessage?.selectedButtonId ||
        message.listResponseMessage?.singleSelectReply?.selectedRowId ||
        message.templateButtonReplyMessage?.selectedId ||
        ''
    );
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
            console.log('📱 New QR code generated. Scan via web page.');
        }

        if (connection === 'open') {
            clientStatus = 'READY';
            currentQR = null;
            console.log('✅ WhatsApp Agent is ONLINE and READY to receive/send messages!');
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

    // 📩 Listen to incoming WhatsApp messages & trigger cvgfn Agent
    sock.ev.on('messages.upsert', async (upsert) => {
        const messages = upsert.messages || [];

        for (const msg of messages) {
            if (!msg.message) continue;

            const senderJid = msg.key.remoteJid;
            if (!senderJid || senderJid === 'status@broadcast') continue;

            // Extract the real text using the universal extractor
            const text = extractMessageText(msg.message);
            const senderName = msg.pushName || 'User';

            console.log(`📩 [WhatsApp Incoming] From: ${senderJid} (${senderName}) | Text: "${text}"`);

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

            // 1. Built-in test ping
            if (text.toLowerCase().trim() === '!ping') {
                console.log(`🏓 Sending pong to ${senderJid}...`);
                await sock.sendMessage(senderJid, { text: 'pong! 🏓 WhatsApp MCP Server is connected.' });
                continue;
            }

            // 2. Trigger the AgenticOrg Agent directly!
            try {
                console.log(`🤖 Triggering Agent [${AGENT_ID}] with text: "${text}"...`);

                const payload = {
                    action: "run",
                    inputs: {
                        task: `Customer (${senderName}) sent this inquiry: "${text}". Answer their question and send the reply back to ${senderJid} using your send_whatsapp_message tool.`
                    }
                };

                const response = await axios.post(AGENTICORG_URL, payload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 45000
                });

                console.log('✅ AgenticOrg Agent executed successfully!');

                // If agent returned text directly instead of tool call, send it as reply
                const rawOutput = response.data?.output?.raw_output || response.data?.output?.response;
                if (rawOutput && typeof rawOutput === 'string') {
                    await sock.sendMessage(senderJid, { text: rawOutput });
                }

            } catch (err) {
                console.error('❌ Error triggering Agent directly:', err.response?.data || err.message);
            }
        }
    });
}

startWhatsApp();

// ==================================================================
// 🛠️ MCP Tools Catalog
// ==================================================================
const mcpTools = [
    {
        name: "send_text_message",
        description: "Sends an outbound WhatsApp text message to a user or phone number.",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string", description: "Phone number with country code" },
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
                to: { type: "string", description: "Phone number with country code" },
                message: { type: "string", description: "The text message content to send" }
            },
            required: ["to", "message"]
        }
    },
    {
        name: "get_last_whatsapp_message",
        description: "Retrieves the most recent incoming message received from a user on WhatsApp.",
        inputSchema: { type: "object", properties: {} }
    }
];

// Core function to send WhatsApp messages
async function sendWhatsApp(to, message) {
    if (!sock || clientStatus !== 'READY') {
        throw new Error('WhatsApp is not connected yet.');
    }
    let jid = to;
    if (!to.includes('@')) {
        const cleanNumber = String(to).replace(/[^0-9]/g, '');
        jid = `${cleanNumber}@s.whatsapp.net`;
    }
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

        if (toolName === 'send_text_message' || toolName === 'send_whatsapp_message') {
            const to = args.to || args.recipient || args.phone_number;
            const message = args.message || args.text || args.body;

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
                    <h2 style="color: #25D366;">✅ WhatsApp AI Agent Bridge is Online!</h2>
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <p>Connected to Agent: <code>${AGENT_ID}</code></p>
                    <p>Send any message on WhatsApp to chat with the agent!</p>
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
    console.log(`🚀 Server running on port ${PORT}`);
});
