// services/userService.js
const pool = require('../config/db');

// Retrieve guardian information based on user_id (assuming user_id corresponds to guardian_id)
const getGuardianInfo = async(userId) => {
    try {
        const [rows] = await pool.query('SELECT firstname, lastname, email FROM `guardian` WHERE id = ?', [userId]);
        return rows.length > 0 ? rows[0] : null;
    } catch (error) {
        console.error('getGuardianInfo error:', error.message);
        return null;
    }
};

// Update or insert guardian information
const updateGuardianInfo = async(userId, firstname, lastname, email) => {
    try {
        const [rows] = await pool.query('SELECT * FROM `guardian` WHERE id = ?', [userId]);
        if (rows.length > 0) {
            // Update existing guardian
            await pool.query(
                'UPDATE `guardian` SET firstname = ?, lastname = ?, email = ? WHERE id = ?', [firstname, lastname, email, userId]
            );
        } else {
            // Insert new guardian
            await pool.query(
                'INSERT INTO `guardian` (id, firstname, lastname, email) VALUES (?, ?, ?, ?)', [userId, firstname, lastname, email]
            );
        }
    } catch (error) {
        console.error('updateGuardianInfo error:', error.message);
    }
};

module.exports = {
    getGuardianInfo,
    updateGuardianInfo,
};