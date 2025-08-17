// config/index.js
require('dotenv').config();

module.exports = {
    port: process.env.PORT || 3000,
    db: {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'admission_db',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    },
    openaiApiKey: process.env.OPENAI_API_KEY
};