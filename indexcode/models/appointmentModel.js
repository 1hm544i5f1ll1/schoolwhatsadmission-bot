// models/appointmentModel.js
const pool = require('../config/db');

const saveAppointment = async(userId, slotDatetime, purpose, section) => {
    try {
        const userPhone = userId.split('@')[0];
        const [studentContactRows] = await pool.query(
            'SELECT student_id FROM `studentcontactinfo` WHERE mobile = ? OR mobile2 = ?', [userPhone, userPhone]
        );
        if (studentContactRows.length === 0) {
            return false;
        }
        const studentId = studentContactRows[0].student_id;
        await pool.query(
            'INSERT INTO `appointments` (appdate, student_id, purpose, section) VALUES (?, ?, ?, ?)', [slotDatetime, studentId, purpose, section]
        );
        return true;
    } catch (error) {
        console.error('saveAppointment error:', error.message);
        return false;
    }
};

module.exports = {
    saveAppointment,
};