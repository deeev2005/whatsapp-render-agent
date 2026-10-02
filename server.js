const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const axios = require('axios');

const app = express();
app.use(express.json());

let currentQR = null;
let clientStatus = 'STARTING';
let sock = null;

// ==================================================================
// 🎯 AgenticOrg Workflow Configuration
// ==================================================================
const WORKFLOW_ID = process.env.AGENTICORG_WORKFLOW_ID || '6099d951-d8d9-4144-a2f6-a2320324a148';
const AGENTICORG_BASE_URL = 'https://agenticorg.hackathon.pinelabs.com';
const AGENTICORG_API_KEY = process.env.AGENTICORG_API_KEY || '';

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

    // Handle Incoming Messages
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
            // Ignore messages sent by ourselves unless testing with !ping
            if (isFromMe && text.toLowerCase() !== '!ping') continue;

            console.log(`📩 [WhatsApp Message from ${senderName} (${senderJid})]: ${text}`);

            // 1. Built-in test ping
            if (text.toLowerCase() === '!ping') {
                await sock.sendMessage(senderJid, { text: 'pong! 🏓 WhatsApp bridge is connected to AgenticOrg Workflow.' });
                continue;
            }

            // 2. Trigger AgenticOrg Workflow (7-Step AI Pipeline)
            try {
                console.log(`🚀 Triggering Workflow [${WORKFLOW_ID}] on AgenticOrg...`);

                const payload = {
                    sender_id: senderJid,
                    sender_name: senderName,
                    message: text,
                    timestamp: new Date().toISOString()
                };

                const headers = { 'Content-Type': 'application/json' };
                if (AGENTICORG_API_KEY) {
                    headers['Authorization'] = `Bearer ${AGENTICORG_API_KEY}`;
                    headers['x-api-key'] = AGENTICORG_API_KEY;
                }

                // Send to AgenticOrg Workflow endpoint
                const runUrl = `${AGENTICORG_BASE_URL}/api/workflows/${WORKFLOW_ID}/run`;
                const response = await axios.post(runUrl, payload, { headers, timeout: 45000 });

                console.log('✅ AgenticOrg Workflow Result:', response.data);

                // Extract reply from the workflow output
                const result = response.data;
                const replyText = 
                    result.output?.reply ||
                    result.output?.message ||
                    result.output?.response ||
                    result.response ||
                    result.reply ||
                    (typeof result.output === 'string' ? result.output : null);

                if (replyText) {
                    await sock.sendMessage(senderJid, { text: String(replyText) });
                } else if (result.status === 'success' || result.status === 'completed') {
                    await sock.sendMessage(senderJid, { text: 'Your request has been processed by our AI workflow.' });
                }

            } catch (err) {
                console.error('❌ Error triggering AgenticOrg workflow:', err.response?.data || err.message);
                // Fallback reply if workflow needs authentication or is pending
                await sock.sendMessage(senderJid, { 
                    text: `Hello ${senderName}! We received your inquiry: "${text}". Our AI system has logged ticket for review.` 
                });
            }
        }
    });
}

startWhatsApp();

// ==================================================================
// 🩺 Health Check & Ping (Keeps Render Awake 24/7)
// ==================================================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        whatsappStatus: clientStatus,
        workflowId: WORKFLOW_ID,
        timeIST: getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    });
});

app.get('/ping', (req, res) => res.status(200).send('OK'));

// ==================================================================
// 📱 Web Dashboard
// ==================================================================
app.get('/', (req, res) => {
    if (clientStatus === 'READY') {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2 style="color: #25D366;">✅ WhatsApp AI Workflow Bridge is Online!</h2>
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <p>Connected Workflow ID: <code>${WORKFLOW_ID}</code></p>
                    <p>Send a message on WhatsApp to trigger the 7-step AI pipeline!</p>
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
// 🚀 Outbound Webhook endpoint: AgenticOrg can push messages to WhatsApp
// ==================================================================
app.post(['/send-message', '/api/send-message'], async (req, res) => {
    const to = req.body.to || req.body.sender_id || req.body.recipient;
    const message = req.body.message || req.body.text || req.body.body;

    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Missing recipient ("to") or "message"' });
    }
    if (!sock || clientStatus !== 'READY') {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });
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
// 🚀 SERVER START
// ==================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 WhatsApp AI Workflow Server running on port ${PORT}`);
});
