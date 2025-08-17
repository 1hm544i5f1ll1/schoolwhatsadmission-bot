// utils/fileLoader.js
const fs = require('fs');
const path = require('path');
const { extractAddressUsingAI } = require('../services/aiService');

const loadTextDocument = async(filePath) => {
    try {
        const textDocumentContent = fs.readFileSync(filePath, 'utf-8');
        console.log('Text document loaded successfully.');

        const schoolAddress = await extractAddressUsingAI(textDocumentContent);

        if (schoolAddress) {
            console.log('School Address Extracted:', schoolAddress);
        } else {
            console.warn('No address found in the text document.');
        }

        return { textDocumentContent, schoolAddress };
    } catch (error) {
        console.error('Error loading text document:', error.message);
        throw error;
    }
};

module.exports = { loadTextDocument };