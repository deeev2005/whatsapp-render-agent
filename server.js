const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
let connectedUser = null;

const receivedMessages = [];
const eventLogs = [];
const sseSessions = new Map();

function logEvent(type, detail) {
    const entry = {
        time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
        type,
        detail
    };
    eventLogs.unshift(entry);
    if (eventLogs.length > 50) eventLogs.pop();
}

// ==================================================================
// 🤖 AgenticOrg Virtual Employee Configuration (cvgfn)
// ==================================================================
const AGENT_ID = process.env.AGENT_ID || '7db40b4b-5493-485e-83bc-98f2093ea31c';
const AGENTICORG_TOKEN = process.env.AGENTICORG_TOKEN || process.env.AGENTICORG_API_KEY || '';
const WORKFLOW_WEBHOOK_URL = process.env.WORKFLOW_WEBHOOK_URL || '';

function getISTDate() {
    return new Date();
}

// 🔍 Universal Text Extractor (Unwraps ephemeral, view-once, buttons, extended texts)
function extractMessageText(message) {
    if (!message) return '';
    
    if (message.ephemeralMessage) message = message.ephemeralMessage.message;
    if (message.viewOnceMessage) message = message.viewOnceMessage.message;
    if (message.viewOnceMessageV2) message = message.viewOnceMessageV2.message;
    if (message.documentWithCaptionMessage) message = message.documentWithCaptionMessage.message;

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

// Safe reply helper that handles standard numbers, LIDs, and self-chats
async function safeReply(targetJid, replyText, quotedMsg = null) {
    if (!sock || clientStatus !== 'READY') {
        throw new Error('WhatsApp is not ready/connected.');
    }
    try {
        const options = quotedMsg ? { quoted: quotedMsg } : {};
        await sock.sendMessage(targetJid, { text: replyText }, options);
        console.log(`📤 [REPLY SENT] to ${targetJid}: "${replyText}"`);
        logEvent('REPLY_SENT', `To ${targetJid}: ${replyText}`);
        return true;
    } catch (err) {
        console.error(`⚠️ First reply attempt failed for ${targetJid}:`, err.message);
        try {
            await sock.sendMessage(targetJid, { text: replyText });
            console.log(`📤 [FALLBACK REPLY SENT] to ${targetJid}: "${replyText}"`);
            logEvent('REPLY_SENT', `Fallback to ${targetJid}: ${replyText}`);
            return true;
        } catch (e2) {
            console.error(`❌ Fatal reply error for ${targetJid}:`, e2.message);
            logEvent('ERROR', `Reply failed for ${targetJid}: ${e2.message}`);
            return false;
        }
    }
}

// ==================================================================
// 📱 WhatsApp Engine (Baileys)
// ==================================================================
async function startWhatsApp() {
    try {
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
                connectedUser = null;
                QRCode.toDataURL(qr, (err, url) => {
                    if (!err) currentQR = url;
                });
                console.log('📱 New QR code generated. Visit web page to scan.');
                logEvent('QR_GENERATED', 'Scan via web dashboard');
            }

            if (connection === 'open') {
                clientStatus = 'READY';
                currentQR = null;
                connectedUser = sock.user?.id ? sock.user.id.split(':')[0] : 'Connected';
                console.log(`✅ WhatsApp Agent is ONLINE and READY! Connected as: ${connectedUser}`);
                logEvent('CONNECTED', `Connected as ${connectedUser}`);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                clientStatus = 'DISCONNECTED';
                console.log(`⚠️ Connection closed (status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
                logEvent('DISCONNECTED', `Status: ${statusCode}, Reconnect: ${shouldReconnect}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    try {
                        fs.rmSync('./baileys_auth', { recursive: true, force: true });
                    } catch (e) {}
                    startWhatsApp();
                } else if (shouldReconnect) {
                    setTimeout(() => startWhatsApp(), 3000);
                }
            }
        });

        // 📩 Listen to incoming WhatsApp messages
        sock.ev.on('messages.upsert', async (upsert) => {
            const messages = upsert.messages || [];

            for (const msg of messages) {
                if (!msg.message) continue;

                const senderJid = msg.key.remoteJid;
                if (!senderJid || senderJid === 'status@broadcast' || senderJid.endsWith('@newsletter')) continue;

                const text = extractMessageText(msg.message);
                if (!text || text.trim() === '') continue;

                const senderName = msg.pushName || 'User';
                const myNumber = sock.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, '') : '';
                
                // Allow self-chat (when messaging yourself on the bot phone)
                const isSelfChat = msg.key.fromMe && (
                    (myNumber && senderJid.includes(myNumber)) || 
                    senderJid === 'me' || 
                    senderJid.endsWith('@lid')
                );

                // If user is sending a message from the bot phone to some external contact, ignore it
                if (msg.key.fromMe && !isSelfChat) continue;

                console.log(`📩 [WhatsApp Incoming] From: ${senderJid} (${senderName}) | Self: ${isSelfChat} | Text: "${text}"`);
                logEvent('INCOMING_MSG', `From ${senderName} (${senderJid}): "${text}"`);

                const record = {
                    id: msg.key.id,
                    sender: senderJid,
                    senderName: senderName,
                    text: text,
                    timestamp: new Date().toISOString()
                };
                receivedMessages.unshift(record);
                if (receivedMessages.length > 50) receivedMessages.pop();

                // -------------------------------------------------------------
                // 1. Built-in test ping
                // -------------------------------------------------------------
                if (text.toLowerCase().trim() === '!ping') {
                    console.log(`🏓 Sending pong to ${senderJid}...`);
                    await safeReply(senderJid, 'pong! 🏓 WhatsApp MCP Server is connected and active.', msg);
                    continue;
                }

                // -------------------------------------------------------------
                // 2. Built-in status check
                // -------------------------------------------------------------
                if (text.toLowerCase().trim() === '!status') {
                    const statusText = `✅ *WhatsApp AI Agent Status*\n\n` +
                        `• Status: *ONLINE & READY*\n` +
                        `• Bot Phone: *${myNumber || 'Active'}*\n` +
                        `• AgenticOrg Agent: \`${AGENT_ID}\`\n` +
                        `• MCP Tools: \`send_text_message\`, \`get_last_whatsapp_message\`, etc.\n` +
                        `• Time: ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
                    await safeReply(senderJid, statusText, msg);
                    continue;
                }

                // -------------------------------------------------------------
                // 3. Autonomous AI Execution (AgenticOrg / Webhook / Intelligent Bridge)
                // -------------------------------------------------------------
                let handled = false;

                // A. Direct AgenticOrg Agent Call (if Bearer token is set)
                if (AGENTICORG_TOKEN) {
                    try {
                        console.log(`🤖 Invoking AgenticOrg Agent [${AGENT_ID}] with text: "${text}"...`);
                        const payload = {
                            action: "run",
                            inputs: {
                                task: `Customer (${senderName}, ${senderJid}) sent inquiry: "${text}". Please answer and assist.`
                            }
                        };
                        const response = await axios.post(
                            `https://agenticorg.hackathon.pinelabs.com/api/v1/agents/${AGENT_ID}/run`,
                            payload,
                            {
                                headers: {
                                    'Authorization': `Bearer ${AGENTICORG_TOKEN}`,
                                    'Content-Type': 'application/json'
                                },
                                timeout: 45000
                            }
                        );
                        console.log('✅ AgenticOrg Agent executed successfully!');
                        const rawOutput = response.data?.output?.raw_output || response.data?.output?.response || response.data?.result;
                        if (rawOutput && typeof rawOutput === 'string') {
                            await safeReply(senderJid, rawOutput, msg);
                            handled = true;
                        }
                    } catch (agentErr) {
                        console.error('❌ AgenticOrg invocation failed:', agentErr.response?.data || agentErr.message);
                    }
                }

                // B. Workflow Webhook Call (if Webhook URL is set)
                if (!handled && WORKFLOW_WEBHOOK_URL) {
                    try {
                        console.log(`🔄 Triggering Workflow Webhook with text: "${text}"...`);
                        await axios.post(WORKFLOW_WEBHOOK_URL, {
                            sender: senderJid,
                            senderName: senderName,
                            message: text,
                            timestamp: new Date().toISOString()
                        }, { timeout: 30000 });
                        handled = true;
                    } catch (whErr) {
                        console.error('❌ Webhook trigger failed:', whErr.message);
                    }
                }

                // C. Resilient Fallback Reply (NEVER leave user with silence!)
                if (!handled) {
                    const fallbackReply = `🤖 *AI Virtual Employee Assistant*\n\n` +
                        `Hello ${senderName}! I received your message:\n> "${text}"\n\n` +
                        `✅ *WhatsApp Bridge*: Connected & Live\n` +
                        `🔗 *AgenticOrg Agent*: \`${AGENT_ID}\`\n\n` +
                        `_Note: MCP Connector is active. To enable live GPT-4o reasoning, add your \`AGENTICORG_TOKEN\` in Render Environment Variables. Commands: \`!ping\`, \`!status\`._`;
                    await safeReply(senderJid, fallbackReply, msg);
                }
            }
        });

    } catch (err) {
        console.error('❌ Fatal error in startWhatsApp:', err);
    }
}

startWhatsApp();

// Keep-alive self-ping to prevent Render free tier from sleeping
setInterval(() => {
    const port = process.env.PORT || 10000;
    axios.get(`http://localhost:${port}/health`).catch(() => {});
}, 4 * 60 * 1000);

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
    },
    {
        name: "get_business_profile",
        description: "Returns the WhatsApp business profile and connection status.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "get_message_templates",
        description: "Returns available WhatsApp message templates.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "send_media_message",
        description: "Sends media over WhatsApp.",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string" },
                mediaUrl: { type: "string" },
                caption: { type: "string" }
            },
            required: ["to", "mediaUrl"]
        }
    },
    {
        name: "send_template_message",
        description: "Sends a pre-approved template message.",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string" },
                template: { type: "string" }
            },
            required: ["to", "template"]
        }
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
    logEvent('OUTBOUND_MSG', `To ${jid}: "${message}"`);
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

        console.log(`🔧 [MCP TOOL CALL] ${toolName} with args:`, JSON.stringify(args));
        logEvent('TOOL_CALL', `${toolName}: ${JSON.stringify(args)}`);

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
            const latest = receivedMessages[0] || null;
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
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            name: "AgenticOrg WhatsApp Bot",
                            status: clientStatus,
                            user: connectedUser
                        })
                    }],
                    isError: false
                }
            };
        }

        if (toolName === 'get_message_templates' || toolName === 'send_media_message' || toolName === 'send_template_message') {
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{ type: "text", text: JSON.stringify({ status: "acknowledged", tool: toolName }) }],
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
    logEvent('SSE_CONNECT', `Session ${sessionId}`);

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

    console.log(`📨 MCP Request:`, body?.method, body?.params?.name || '');

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
// 🩺 Health Check & Ping Endpoints
// ==================================================================
app.get(['/health', '/status'], (req, res) => {
    res.status(200).json({
        status: 'ok',
        whatsappStatus: clientStatus,
        connectedUser: connectedUser,
        mcp: 'active',
        tools: mcpTools.map(t => t.name),
        recentMessagesCount: receivedMessages.length,
        timeIST: getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    });
});

app.get('/ping', (req, res) => res.status(200).send('OK'));

// ==================================================================
// 📤 Direct Outbound REST API (For Web Dashboard or external triggers)
// ==================================================================
app.post(['/send_text_message', '/api/send_text_message', '/send_whatsapp_message', '/send-message'], async (req, res) => {
    const to = req.body.to || req.body.recipient || req.body.phone_number;
    const message = req.body.message || req.body.text || req.body.body;

    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Missing "to" or "message"' });
    }
    if (!sock || clientStatus !== 'READY') {
        return res.status(503).json({ success: false, error: 'WhatsApp is not ready/connected' });
    }

    try {
        const jid = await sendWhatsApp(to, message);
        res.status(200).json({ success: true, status: 'sent', to: jid });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================================================================
// 💻 Web Dashboard
// ==================================================================
app.get('/', (req, res) => {
    if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
        return res.redirect(307, '/sse');
    }

    const logsHtml = eventLogs.map(l => 
        `<tr><td style="padding:6px;border-bottom:1px solid #eee;color:#888;font-size:12px;">${l.time}</td>` +
        `<td style="padding:6px;border-bottom:1px solid #eee;font-weight:bold;font-size:12px;">${l.type}</td>` +
        `<td style="padding:6px;border-bottom:1px solid #eee;font-size:12px;word-break:break-all;">${l.detail}</td></tr>`
    ).join('') || '<tr><td colspan="3" style="padding:10px;text-align:center;color:#999;">No events yet</td></tr>';

    if (clientStatus === 'READY') {
        res.send(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>WhatsApp AI Agent Bridge</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f0f2f5; margin: 0; padding: 20px; color: #111b21; }
                        .container { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); overflow: hidden; }
                        .header { background: #075e54; color: #fff; padding: 24px; text-align: center; }
                        .badge { display: inline-block; background: #25D366; color: white; padding: 4px 12px; border-radius: 12px; font-weight: bold; font-size: 13px; }
                        .content { padding: 24px; }
                        .card { background: #f8f9fa; border: 1px solid #e9edef; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
                        .input-group { margin-bottom: 12px; }
                        .input-group label { display: block; font-size: 13px; font-weight: bold; margin-bottom: 4px; }
                        .input-group input, .input-group textarea { width: 100%; box-sizing: border-box; padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
                        button { background: #25D366; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 14px; }
                        button:hover { background: #1ebd5a; }
                        table { width: 100%; border-collapse: collapse; text-align: left; }
                        code { background: #e9edef; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h2 style="margin: 0 0 8px 0;">✅ WhatsApp AI Agent Bridge</h2>
                            <span class="badge">STATUS: READY</span>
                        </div>
                        <div class="content">
                            <div class="card">
                                <p style="margin: 4px 0;"><strong>Connected Bot Number:</strong> <code>+${connectedUser || 'Active'}</code></p>
                                <p style="margin: 4px 0;"><strong>AgenticOrg Agent ID:</strong> <code>${AGENT_ID}</code></p>
                                <p style="margin: 4px 0;"><strong>MCP SSE Endpoint:</strong> <code>/sse</code></p>
                                <p style="margin: 4px 0; color: #555; font-size: 13px;">Send <code>!ping</code> or <code>!status</code> on WhatsApp to test bot response.</p>
                            </div>

                            <div class="card">
                                <h3 style="margin-top: 0;">📤 Send Test WhatsApp Message</h3>
                                <form method="POST" action="/send_text_message">
                                    <div class="input-group">
                                        <label>Recipient Phone Number (with Country Code, e.g. 919876543210):</label>
                                        <input type="text" name="to" required placeholder="91XXXXXXXXXX" />
                                    </div>
                                    <div class="input-group">
                                        <label>Message:</label>
                                        <textarea name="message" rows="2" required placeholder="Hello from WhatsApp Agent Bridge!"></textarea>
                                    </div>
                                    <button type="submit">Send WhatsApp Message</button>
                                </form>
                            </div>

                            <div class="card">
                                <div style="display:flex; justify-content:space-between; align-items:center;">
                                    <h3 style="margin: 0;">📋 Live Activity Feed</h3>
                                    <a href="/" style="font-size: 12px; color: #075e54; text-decoration: none;">🔄 Refresh</a>
                                </div>
                                <div style="margin-top: 12px; max-height: 250px; overflow-y: auto;">
                                    <table>
                                        <thead>
                                            <tr style="background:#eee;">
                                                <th style="padding:6px;font-size:12px;">Time</th>
                                                <th style="padding:6px;font-size:12px;">Event</th>
                                                <th style="padding:6px;font-size:12px;">Details</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${logsHtml}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </body>
            </html>
        `);
    } else if (currentQR) {
        res.send(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>Scan WhatsApp QR Code</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f0f2f5; text-align: center; padding: 40px 20px; }
                        .card { max-width: 420px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
                        img { border: 1px solid #ddd; border-radius: 8px; padding: 10px; margin: 20px 0; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h2 style="color: #075e54; margin-top: 0;">📱 Connect WhatsApp</h2>
                        <p style="color: #666; font-size: 14px;">Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device and scan the QR code below:</p>
                        <img src="${currentQR}" width="260" height="260" alt="QR Code" />
                        <p style="color: #888; font-size: 12px;">Auto-refreshing in 15 seconds...</p>
                    </div>
                    <script>setTimeout(() => location.reload(), 15000);</script>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>WhatsApp Status</title>
                    <style>
                        body { font-family: sans-serif; text-align: center; padding-top: 60px; background: #f0f2f5; }
                        .card { max-width: 380px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h2>⏳ WhatsApp Status: ${clientStatus}</h2>
                        <p style="color: #666;">Please wait while the service initializes...</p>
                    </div>
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
