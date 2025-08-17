// services/scheduleService.js
const { getUserInfo, getMissingFields } = require('./userService');
const { saveAppointment, getAvailableSlots, checkExistingAppointment } = require('./appointmentService');
const userSessions = new Map();

/**
 * Handle the collection of missing information from the user.
 * @param {string} userId - The WhatsApp user ID.
 * @param {string} userMessage - The user's message input.
 * @returns {Promise<string>} - The bot's response message.
 */
const handleMissingInfoCollection = async(userId, userMessage) => {
        const session = userSessions.get(userId);
        const currentField = session.current_missing_field;
        const userType = session.userType;

        if (!currentField) {
            if (!session.missingFields.length) {
                session.state = 'scheduling';
                userSessions.set(userId, session);
                const slots = getAvailableSlots();
                return `Here are the available slots:\n${slots.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nPlease reply with the slot number to confirm your appointment.`;
        }

        const nextField = session.missingFields.shift();
        session.current_missing_field = nextField;
        userSessions.set(userId, session);

        const fieldPrompts = {
            fullname: userType === 'parent' ? 'Could you provide your full name (Parent)?' : 'What is your full name?',
            childName: 'What is your child’s full name?',
            email: 'What is your email address?',
            gradeLevel: 'For which grade level are you applying? (e.g., Grade 10)',
            semester: 'Which semester are you applying for? (Semester 1 or Semester 2)',
            gender: 'What is your gender? (Male or Female)',
            referralSource: 'How did you hear about us? (Twitter, Facebook, Instagram, YouTube, Friend)',
        };

        return fieldPrompts[nextField] || `Could you provide your ${nextField}?`;
    }

    // Handle pleasantries or missing data
    if (/not sure|don’t know|idk/i.test(userMessage)) {
        return `No worries! Let me know when you have the information. Let’s move to the next step.`;
    }

    // Save user's input
    session.collectedData[currentField] = userMessage;
    session.current_missing_field = null;
    userSessions.set(userId, session);

    return await handleMissingInfoCollection(userId, '');
};

/**
 * Handle the scheduling of an appointment based on user input.
 * @param {string} userId - The WhatsApp user ID.
 * @param {string} userMessage - The user's message input.
 * @returns {Promise<string>} - The bot's response message.
 */
const handleScheduling = async (userId, userMessage) => {
    const session = userSessions.get(userId);
    const slots = getAvailableSlots();

    if (userMessage && /^\d+$/.test(userMessage)) {
        const slotIndex = parseInt(userMessage) - 1;
        if (slotIndex >= 0 && slotIndex < slots.length) {
            const selectedSlot = slots[slotIndex];
            const studentId = session.studentId;
            const existingAppointment = await checkExistingAppointment(studentId);

            if (existingAppointment) {
                return `You already have an appointment scheduled on ${existingAppointment.appdate}.`;
            }

            const success = await saveAppointment(studentId, selectedSlot, 'Admission Inquiry');
            userSessions.delete(userId);

            return success
                ? `Your appointment has been scheduled for ${selectedSlot}. Thank you! Let us know if you need any further assistance.`
                : 'Sorry, there was an error scheduling your appointment. Please try again.';
        }
        return `Invalid slot number. Please reply with a valid number.\n\nAvailable slots:\n${slots.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    }

    return `Here are the available slots:\n${slots.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nPlease reply with the slot number to confirm your appointment.`;
};

module.exports = { handleMissingInfoCollection, handleScheduling };