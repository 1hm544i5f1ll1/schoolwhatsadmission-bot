// services/whatsappService.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('IVY Help Bot is ready!');
});

client.initialize();

async function sendMessage(userId, content) {
    try {
        await client.sendMessage(userId, content);
    } catch (err) {
        console.error('sendMessage error:', err.message);
    }
}

module.exports = {
    client,
    sendMessage
};