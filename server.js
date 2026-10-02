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
// 🤖 AgenticOrg Virtual Employee Configuration (piiriya)
// ==================================================================
const AGENT_ID = process.env.AGENT_ID || 'abd04322-db21-4d01-a937-941ef9c68a30';
const AGENTICORG_URL = `https://agenticorg.hackathon.pinelabs.com/api/v1/agents/${AGENT_ID}/run`;

// Session credentials from your environment or defaults
const AGENTICORG_SESSION = process.env.AGENTICORG_SESSION || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ2ZXJtYWRlZXBlc2gxNUBnbWFpbC5jb20iLCJhZ2VudGljb3JnOnRlbmFudF9pZCI6ImFiYjYxYmNhLWEzZjUtNGFiYS1iMzBlLTk0NjAxNmIxMzEyMCIsImFnZW50aWNvcmc6dXNlcl9pZCI6ImU1ZjA3MDU2LWYxNmEtNGExZC04YzFmLTY0ZTIzNTUyNGFhNyIsImdyYW50ZXg6c2NvcGVzIjpbImFnZW50czpyZWFkIiwiYWdlbnRzOndyaXRlIiwid29ya2Zsb3dzOnJlYWQiLCJ3b3JrZmxvd3M6d3JpdGUiLCJhdWRpdDpyZWFkIiwiY29ubmVjdG9yczpyZWFkIiwiY29ubmVjdG9yczpjcmVhdGUiLCJjb25uZWN0b3JzOnVwZGF0ZSIsImNvbm5lY3RvcnM6ZGVsZXRlIl0sIm5hbWUiOiJkZWVwZXNoIiwicm9sZSI6ImRldmVsb3BlciIsImRvbWFpbiI6ImJhY2tvZmZpY2UiLCJhZ2VudGljb3JnOmRvbWFpbnMiOlsiYmFja29mZmljZSJdLCJpc3MiOiJhZ2VudGljb3JnLWxvY2FsIiwiYXVkIjoiYWdlbnRpY29yZy10b29sLWdhdGV3YXkiLCJpYXQiOjE3OTA5NDMwNjYsImV4cCI6MTc5MDk0NjY2Nn0.sM7uEAHMpWIRdi3zW4pen6NbMD69LR3dlPP-bwcLIOY';
const CSRF_TOKEN = process.env.CSRF_TOKEN || 'QJE9aot3_2sADzJaR4Rx2nKWsxqnJqyul7Lh-7dKhxM';

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

    // Handle incoming WhatsApp messages
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
            if (isFromMe && text.toLowerCase() !== '!ping') continue;

            console.log(`📩 [WhatsApp Message from ${senderName} (${senderJid})]: ${text}`);

            // 1. Built-in test ping
            if (text.toLowerCase() === '!ping') {
                await sock.sendMessage(senderJid, { text: 'pong! 🏓 WhatsApp Agent piiriya is online and connected.' });
                continue;
            }

            // 2. Call AgenticOrg Virtual Employee (piiriya)
            try {
                console.log(`🤖 Forwarding message to AgenticOrg Agent [${AGENT_ID}]...`);

                const payload = {
                    action: "run",
                    csrf_token: CSRF_TOKEN,
                    inputs: {
                        task: text
                    }
                };

                const response = await axios.post(AGENTICORG_URL, payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/plain, */*',
                        'x-csrf-token': CSRF_TOKEN,
                        'Cookie': `agenticorg_session=${AGENTICORG_SESSION}; agenticorg_csrf=${CSRF_TOKEN}`,
                        'Authorization': `Bearer ${AGENTICORG_SESSION}`,
                        'Origin': 'https://agenticorg.hackathon.pinelabs.com',
                        'Referer': `https://agenticorg.hackathon.pinelabs.com/dashboard/agents/${AGENT_ID}`
                    },
                    timeout: 45000
                });

                console.log('✅ AgenticOrg Response:', JSON.stringify(response.data, null, 2));

                // Extract reply text from AgenticOrg response
                const rawOutput = response.data?.output?.raw_output || response.data?.output?.response || response.data?.output;
                const replyText = typeof rawOutput === 'object' ? JSON.stringify(rawOutput) : rawOutput;

                if (replyText) {
                    await sock.sendMessage(senderJid, { text: String(replyText) });
                } else {
                    await sock.sendMessage(senderJid, { text: 'Hello! I received your message, but the agent returned an empty response.' });
                }

            } catch (err) {
                console.error('❌ Error executing AgenticOrg Agent:', err.response?.data || err.message);
                await sock.sendMessage(senderJid, { 
                    text: 'Sorry, I am having trouble connecting to the AgenticOrg AI engine right now.' 
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
        agentId: AGENT_ID,
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
                    <h2 style="color: #25D366;">✅ WhatsApp Virtual Employee (piiriya) is Online!</h2>
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <p>Connected Agent ID: <code>${AGENT_ID}</code></p>
                    <p>Send a message on WhatsApp to chat with piiriya!</p>
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
