const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

let currentQR = null;
let clientStatus = 'STARTING';
let sock = null;

// In-memory store for messages (for demo purposes)
const receivedMessages = [];

// Helper function for IST Date
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

    // Capture incoming WhatsApp messages
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

            const messageRecord = {
                id: msg.key.id,
                sender: senderJid,
                senderName: senderName,
                text: text,
                isFromMe: isFromMe,
                timestamp: new Date().toISOString()
            };

            // Store in memory (keep last 50 messages)
            receivedMessages.unshift(messageRecord);
            if (receivedMessages.length > 50) receivedMessages.pop();

            console.log(`[WhatsApp Message from ${senderName}]: ${text}`);

            // Built-in test ping
            if (text.toLowerCase() === '!ping') {
                await sock.sendMessage(senderJid, { text: 'pong! 🏓 WhatsApp Connector is active and connected.' });
            }
        }
    });
}

startWhatsApp();

// ==================================================================
// 🔌 Connector Endpoints (Used by AgenticOrg Custom Connector)
// ==================================================================

/**
 * 1. Send WhatsApp Message
 * AgenticOrg agents call this endpoint to send an answer or alert.
 * Accepts: { "to": "919876543210", "message": "Hello from Agent!" }
 */
app.post(['/send-message', '/api/send-message'], async (req, res) => {
    const { to, message } = req.body;
    
    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Missing required fields: "to" and "message"' });
    }
    if (!sock || clientStatus !== 'READY') {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not ready/connected' });
    }

    try {
        const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: String(message) });
        console.log(`📤 Sent message to ${jid}: ${message}`);
        res.json({ success: true, status: 'sent', to: jid, message: message });
    } catch (err) {
        console.error('Error sending WhatsApp message:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 2. Get Last Received Message
 * Allows the agent to poll or read the latest incoming message.
 */
app.get(['/last-message', '/api/last-message'], (req, res) => {
    const latest = receivedMessages.find(m => !m.isFromMe) || receivedMessages[0] || null;
    res.json({ success: true, message: latest });
});

/**
 * 3. List Recent Messages
 * Allows AgenticOrg to fetch conversation history.
 */
app.get(['/messages', '/api/messages'], (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    res.json({
        success: true,
        count: receivedMessages.length,
        messages: receivedMessages.slice(0, limit)
    });
});

// ==================================================================
// 🩺 Health Check & Ping (Keeps Render Awake 24/7)
// ==================================================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        whatsappStatus: clientStatus,
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
                    <h2 style="color: #25D366;">✅ WhatsApp Connector is Online & Ready!</h2>
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <p>Base URL: <code>https://whatsapp-render-agent.onrender.com</code></p>
                    <p>Available Endpoints: <code>POST /send-message</code>, <code>GET /last-message</code>, <code>GET /messages</code></p>
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
    console.log(`🚀 WhatsApp Connector Server running on port ${PORT}`);
});
