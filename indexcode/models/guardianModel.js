// models/guardianModel.js
const pool = require('../config/db');

const getGuardianByMobile = async(mobile) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM `guardian` WHERE mobile = ?', [mobile]
        );
        return rows[0] || null;
    } catch (error) {
        console.error('getGuardianByMobile error:', error.message);
        return null;
    }
};

const createGuardian = async(firstname, lastname, mobile, email) => {
    try {
        const [result] = await pool.query(
            'INSERT INTO `guardian` (firstname, lastname, mobile, email) VALUES (?, ?, ?, ?)', [firstname, lastname, mobile, email]
        );
        return result.insertId;
    } catch (error) {
        console.error('createGuardian error:', error.message);
        return null;
    }
};

const linkGuardianToStudent = async(relationship, studentId, guardianId) => {
    try {
        await pool.query(
            'INSERT IGNORE INTO `studentsguardians` (relationship, student_id, guardian_id) VALUES (?, ?, ?)', [relationship, studentId, guardianId]
        );
    } catch (error) {
        console.error('linkGuardianToStudent error:', error.message);
    }
};

module.exports = {
    getGuardianByMobile,
    createGuardian,
    linkGuardianToStudent,
};