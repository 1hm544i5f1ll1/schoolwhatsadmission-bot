// config/db.js
const mysql = require('mysql2/promise');
const config = require('./index');

const pool = mysql.createPool(config.db);

module.exports = pool;