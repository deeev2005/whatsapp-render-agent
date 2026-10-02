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

            receivedMessages.unshift(messageRecord);
            if (receivedMessages.length > 50) receivedMessages.pop();

            console.log(`[WhatsApp Message from ${senderName}]: ${text}`);

            if (text.toLowerCase() === '!ping') {
                await sock.sendMessage(senderJid, { text: 'pong! 🏓 WhatsApp Connector is active and connected.' });
            }
        }
    });
}

startWhatsApp();

// ==================================================================
// 🛠️ The 5 AgenticOrg Registered Tool Endpoints
// ==================================================================

/**
 * Tool 1: get_business_profile
 * (AgenticOrg calls this for "Health Check" / "Test Connection")
 */
app.all(['/get_business_profile', '/api/get_business_profile', '/business_profile'], (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        whatsapp_status: clientStatus,
        profile: {
            name: 'AgenticOrg WhatsApp Bot',
            description: 'AI Virtual Employee Assistant',
            status: clientStatus === 'READY' ? 'active' : 'connecting'
        }
    });
});

/**
 * Tool 2: get_message_templates
 */
app.all(['/get_message_templates', '/api/get_message_templates'], (req, res) => {
    res.json({
        success: true,
        templates: [
            { name: 'general_reply', language: 'en', components: [] },
            { name: 'invoice_alert', language: 'en', components: [] }
        ]
    });
});

/**
 * Tool 3: send_text_message
 * (Also handles /send-message)
 */
app.post(['/send_text_message', '/api/send_text_message', '/send-message', '/api/send-message'], async (req, res) => {
    const to = req.body.to || req.body.recipient || req.body.phone_number || req.body.recipient_id;
    const message = req.body.message || req.body.text || req.body.body;

    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Missing recipient ("to") or "message"' });
    }
    if (!sock || clientStatus !== 'READY') {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not ready/connected' });
    }

    try {
        const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: String(message) });
        console.log(`📤 Sent message to ${jid}: ${message}`);
        res.json({ success: true, status: 'sent', message_id: 'wa_' + Date.now(), to: jid });
    } catch (err) {
        console.error('Error sending message:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Tool 4: send_media_message
 */
app.post(['/send_media_message', '/api/send_media_message'], async (req, res) => {
    const to = req.body.to || req.body.recipient;
    const caption = req.body.caption || req.body.text || '';
    const mediaUrl = req.body.media_url || req.body.url;

    if (!to) {
        return res.status(400).json({ success: false, error: 'Missing "to"' });
    }
    if (!sock || clientStatus !== 'READY') {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });
    }

    try {
        const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        if (mediaUrl) {
            await sock.sendMessage(jid, { image: { url: mediaUrl }, caption: caption });
        } else {
            await sock.sendMessage(jid, { text: caption });
        }
        res.json({ success: true, status: 'sent' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Tool 5: send_template_message
 */
app.post(['/send_template_message', '/api/send_template_message'], async (req, res) => {
    // Template messages fallback to regular text message
    const to = req.body.to || req.body.recipient;
    const text = req.body.text || req.body.message || 'Notification from AgenticOrg';

    if (!sock || clientStatus !== 'READY') {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });
    }

    try {
        const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: String(text) });
        res.json({ success: true, status: 'sent' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================================================================
// 🩺 Standard Health Checks & Ping (Keeps Render Awake 24/7)
// ==================================================================
app.get(['/health', '/status'], (req, res) => {
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
                    <p>All 5 AgenticOrg tools registered and active.</p>
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
