// models/userMessageModel.js
const pool = require('../config/db');

async function saveUserMessage(userId, message, timestamp) {
    try {
        await pool.query(
            'INSERT INTO user_messages (user_id, message, timestamp) VALUES (?, ?, ?)', [userId, message, timestamp]
        );
    } catch (err) {
        console.error('saveUserMessage error:', err.message);
    }
}

async function getLastMessages(userPhone, limit = 20) {
    try {
        const [rows] = await pool.query(
            'SELECT message FROM user_messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?', [userPhone, limit]
        );
        return rows.map(r => r.message);
    } catch (err) {
        console.error('getLastMessages error:', err.message);
        return [];
    }
}

module.exports = {
    saveUserMessage,
    getLastMessages
};