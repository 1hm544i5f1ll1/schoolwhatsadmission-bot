// utils/logger.js
const fs = require('fs');
const sanitizer = require('./sanitizer');

function logInteraction(userId, userMessage, timestamp) {
    const sanitized = sanitizer.sanitizeInput(userMessage);
    const logLine = `${timestamp} - ${userId} => ${sanitized}\n`;
    fs.appendFile('user_interactions.log', logLine, (err) => {
        if (err) console.error('Log error:', err.message);
    });
}

module.exports = {
    logInteraction
};