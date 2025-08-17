// models/faqsModel.js
const pool = require('../config/db');

const addFaq = async(question, answer, user_id) => {
    try {
        const [result] = await pool.query(
            'INSERT INTO `faqs` (question, answer, questioner_id) VALUES (?, ?, ?)', [question, answer, user_id]
        );
        return result.insertId;
    } catch (error) {
        console.error('addFaq error:', error.message);
        return null;
    }
};

const deleteFaq = async(faqId) => {
    try {
        await pool.query(
            'DELETE FROM `faqs` WHERE id = ?', [faqId]
        );
        return true;
    } catch (error) {
        console.error('deleteFaq error:', error.message);
        return false;
    }
};

const getAllFaqs = async() => {
    try {
        const [rows] = await pool.query('SELECT * FROM `faqs`');
        return rows;
    } catch (error) {
        console.error('getAllFaqs error:', error.message);
        return [];
    }
};

module.exports = {
    addFaq,
    deleteFaq,
    getAllFaqs,
};