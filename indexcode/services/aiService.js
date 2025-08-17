const axios = require('axios');
const config = require('../config/index');

/**
 * Call OpenAI's API using model "gpt-4o-mini".
 */
async function callOpenAI(messages, maxTokens = 150, temperature = 0.7) {
    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',
                messages,
                max_tokens: maxTokens,
                temperature,
            },
            {
                headers: {
                    Authorization: `Bearer ${config.openaiApiKey}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        return response.data.choices[0].message.content.trim();
    } catch (err) {
        console.error('OpenAI error:', err.response ? err.response.data : err.message);
        return null;
    }
}

/**
 * Determine user's intent.
 */
async function determineIntent(userMessage, conversation = '') {
    const prompt = `You are Ivy Bot, a WhatsApp assistant for IVY International School. Classify the message as either AdmissionFlow (if it includes admission details like name, email, grade, semester) or AskFAQ (for general school queries). Message: "${userMessage}" Context: "${conversation}" Respond with JSON: {"intent": "AdmissionFlow"} or {"intent": "AskFAQ"} with no extra text.`;
    const messages = [
        { role: 'system', content: 'Interpret intent without hardcoded rules.' },
        { role: 'user', content: prompt },
    ];
    const result = await callOpenAI(messages, 100, 0.0);
    if (!result) {
        console.error('No response from OpenAI for intent determination.');
        return 'Unknown';
    }
    const cleanedResult = result.replace(/```json[\s\S]*?```/g, '').trim();
    try {
        const parsed = JSON.parse(cleanedResult);
        return parsed.intent || 'Unknown';
    } catch (error) {
        console.error('Failed to parse intent from OpenAI response:', result);
        return 'Unknown';
    }
}

/**
 * Answer FAQ using provided School Info.
 * Eve now has a friendly, witty personality.
 */
async function answerQuestion(userQuery, fileContent = '') {
    const prompt = `You are Eve, a cheerful and knowledgeable assistant at IVY International School. Using the School Info below, answer the query in concise bullet points.
School Info:
${fileContent}
Query: "${userQuery}"
Provide clear, relevant details and links if applicable.`;
    const messages = [
        { role: 'system', content: 'Answer FAQs with a friendly tone.' },
        { role: 'user', content: prompt },
    ];
    return (await callOpenAI(messages, 600, 0.5)) || "I'm not sure. Could the applicant please elaborate?";
}

/**
 * Generate a prompt for messages.
 */
async function generatePrompt(instruction) {
    const prompt = `You are Ivy Bot, a WhatsApp assistant for IVY International School. Instruction: ${instruction}. Generate a concise, user-friendly message.`;
    const messages = [
        { role: 'system', content: 'Generate concise user-facing messages.' },
        { role: 'user', content: prompt },
    ];
    return (await callOpenAI(messages, 100, 0.7)) || 'Please continue.';
}

/**
 * Interpret yes/no.
 */
async function interpretYesNo(userMessage) {
    const normalized = userMessage.trim().replace(/[^\w\s]|_/g, "").toLowerCase();
    if (normalized === 'yes') return 'yes';
    if (normalized === 'no') return 'no';

    const prompt = `Interpret "${userMessage}" as yes or no. Respond with only "yes", "no", or "unknown".`;
    const messages = [
        { role: 'system', content: 'Interpret confirmations (yes/no).' },
        { role: 'user', content: prompt },
    ];
    const response = await callOpenAI(messages, 20, 0.0);
    if (!response) return 'unknown';
    const normalizedResponse = response.trim().toLowerCase();
    if (normalizedResponse === 'yes') return 'yes';
    if (normalizedResponse === 'no') return 'no';
    return 'unknown';
}

/**
 * Validate inputs according to IVY School standards.
 */
async function validateInput(validationType, input) {
    let prompt = '';
    switch (validationType) {
        case 'name':
            prompt = `Validate "${input}" as a full name for a school application. If valid, output exactly "valid" followed by a space and then the name exactly as provided. If invalid, return an error message.`;
            break;
        case 'email':
            prompt = `Validate "${input}" as an email address. If valid, output exactly "valid" followed by a space and then the email in lowercase. If invalid, return an error message.`;
            break;
        case 'grade_level':
            prompt = `Validate "${input}" as a grade level (1-12). Accept variations like "Grade 3", "3rd grade", "three", "3", etc. If valid, output exactly "valid" followed by a space and then the grade as a number (e.g., for "three" output "valid 3", for "Grade 3" output "valid 3"). If invalid, return an error message.`;
            break;
        case 'semester':
            prompt = `Validate "${input}" as a semester (1 or 2). Accept variations like "Semester 1", "1st semester", "one", "1", "two", "2", etc. If valid, output exactly "valid" followed by a space and then the semester as a number (e.g., for "two" output "valid 2", for "2nd semester" output "valid 2"). If invalid, return an error message.`;
            break;
        case 'referral_source':
            prompt = `Validate "${input}" as a referral source. Accept variations of: Twitter, Facebook, Instagram, YouTube, Friend, or Other. If valid, output exactly "valid" followed by a space and then the standardized source name (e.g., for "from a friend" output "valid Friend", for "insta" output "valid Instagram"). If invalid, return an error message.`;
            break;
        default:
            prompt = `Validate "${input}" as ${validationType}. If valid, output exactly "valid". If invalid, return an error message.`;
            break;
    }
    const messages = [
        { role: 'system', content: 'You are a data validation and formatting assistant. For valid inputs, always return "valid" followed by a space and then the database-ready value. Convert all inputs to their proper database format (numbers for grades and semesters, lowercase for emails, standardized names for referrals). Never include any other text.' },
        { role: 'user', content: prompt },
    ];
    const result = await callOpenAI(messages, 150, 0.0);
    if (!result) return 'Validation service is unavailable. Please try again.';
    return result.replace(/```[\s\S]*?```/g, '').trim();
}

async function formatDataForDatabase(data) {
    const prompt = `Format the following data for database storage:
Name: ${data.displayname}
Email: ${data.email}
Grade: ${data.grade}
Semester: ${data.semester}
Referral: ${data.referral}

Please format the data according to these rules:
1. Name: Keep as is
2. Email: Convert to lowercase
3. Grade: Convert to number (e.g., "three" -> 3, "Grade 3" -> 3)
4. Semester: Convert to number (e.g., "two" -> 2, "2nd semester" -> 2)
5. Referral: Keep as is

Return the formatted data as a JSON object with these exact keys: displayname, email, grade, semester, referral`;

    const response = await callOpenAI([
        { role: 'system', content: 'You are a data formatting assistant. Format the input data according to the specified rules and return a valid JSON object.' },
        { role: 'user', content: prompt },
    ], 150, 0.1);

    try {
        const formattedData = JSON.parse(response);
        return formattedData;
    } catch (error) {
        console.error('Error parsing AI response:', error);
        throw new Error('Failed to format data for database');
    }
}

module.exports = {
    determineIntent,
    answerQuestion,
    generatePrompt,
    validateInput,
    interpretYesNo,
    callOpenAI,
    formatDataForDatabase,
};
