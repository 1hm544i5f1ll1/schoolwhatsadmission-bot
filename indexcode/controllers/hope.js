// controllers/whatsappController.js

const sanitizer = require('../utils/sanitizer');
const { sendMessage, client } = require('../services/whatsappService');
const aiService = require('../services/aiService');
const userMessageModel = require('../models/userMessageModel');
const logger = require('../utils/logger');
const rateLimiter = require('../utils/rateLimiter');
const pool = require('../config/db');
const path = require('path');
const fs = require('fs');
const { getAvailableSlots, saveAppointment, checkExistingAppointment } = require('../services/appointmentService');
const botStartTime = new Date(); 



// Load FAQ text from input.txt
const inputPath = path.join(__dirname, '../input.txt');
let inputContent = '';
try {
    inputContent = fs.readFileSync(inputPath, 'utf-8');
} catch (err) {
    console.error('Error loading input.txt:', err.message);
}

// Session storage
const userSessions = new Map();

/**
 * Utility: determine user role from DB
 * If found in guardian => 'parent'
 * If found in student => 'student'
 * Otherwise => 'visitor'
 */
async function getUserRole(userPhone) {
    const phone = userPhone.split('@')[0];

    const [guardianRows] = await pool.query(
        'SELECT id FROM guardian WHERE mobile = ?', [phone]
    );
    if (guardianRows.length > 0) {
        return 'parent';
    }

    const [studentRows] = await pool.query(
        'SELECT id FROM studentcontactinfo WHERE mobile = ? OR mobile2 = ?', [phone, phone]
    );
    if (studentRows.length > 0) {
        return 'student';
    }

    return 'visitor';
}

/**
 * Provide user with allowed/restricted info depending on their role.
 */
function getUserInfoRestrictions(userType) {
    let allowedInfo = '';
    let restrictedInfo = '';

    if (userType === 'student') {
        allowedInfo =
            'You can provide information about class schedules, upcoming exams, school resources (e.g., library hours, study guides), extracurricular activities, and school events.';
        restrictedInfo =
            "Do not provide information about staff salaries, confidential school policies, administrative reports, other students' personal data, financial reports, or legal documents.";
    } else if (userType === 'parent') {
        allowedInfo =
            'You can provide public information such as admission procedures, school tour details, contact information, public events, and directions to the school.';
        restrictedInfo =
            'Do not provide any student-related information, financial data, internal policies, or administrative details.';
    } else {
        allowedInfo =
            'You can provide general information about the school, admission process, contact details, and location.';
        restrictedInfo = 'Do not provide any confidential or internal information.';
    }

    return { allowedInfo, restrictedInfo };
}

/**
 * On client ready, perform any necessary initialization.
 */
client.on('ready', async () => {
    console.log('IVY Help Bot is ready! Doing any needed initialization...');
    try {
        // Example: load partial user sessions from DB if needed, etc.
        console.log('Initialization complete.');
    } catch (err) {
        console.error('Error during context initialization:', err.message);
    }
});

/**
 * Utility: Get the prompt message based on the current state.
 */
function getPromptForState(state, sessionData) {
    switch (state) {
        case 'admission_displayname':
            return 'Please provide your full name.';
        case 'admission_email':
            return 'What is your email address?';
        case 'admission_grade':
            return 'For which grade are you applying? (e.g., Grade 3)';
        case 'admission_semester':
            return 'Which semester are you applying for? (1 or 2)';
        case 'admission_referral':
            return 'How did you hear about us? (Twitter, Facebook, Instagram, YouTube, Friend, Other)';
        case 'admission_confirm':
            return `Please review your details:
- **Name**: ${sessionData.displayname || 'Not provided'}
- **Email**: ${sessionData.email || 'Not provided'}
- **Grade**: ${sessionData.grade || 'Not provided'}
- **Semester**: ${sessionData.semester || 'Not provided'}
- **Referral**: ${sessionData.referral || 'Not provided'}

Are all details correct now? (Yes/No)`;

        case 'admission_change_or_cancel':
            return 'No problem! Would you like to change something or cancel the admission process? (Please reply with "Change" or "Cancel")';
        case 'admission_choose_detail_to_change':
            return 'Sure! Which detail would you like to change? (Name, Email, Grade, Semester, Referral)';
        case 'update_detail':
            return `Please provide the new value for ${sessionData.detailToUpdate.charAt(0).toUpperCase() + sessionData.detailToUpdate.slice(1)}.`;
        case 'meeting_offer':
            return 'Your admission is submitted. Would you like to schedule a meeting now? (Yes/No)';
        case 'meeting_show_slots':
            return `Available slots (8:00 AM–3:00 PM, every 30 min, Sun–Thu):
${sessionData.slotsList}
Please choose a slot number:`;
        case 'awaiting_continue':
            return 'How can I assist you further?';
    }
}

/**
 * Main session handler that manages different states and user interactions.
 */
async function handleSession(userId, userMessage, session) {
    // Prevent intent processing after confirmation
    if (session.intentDisabled) {
        await sendMessage(userId, 'Your admission process is complete. Let us know if you need anything else.');
        return;
    }

    // Prioritize state-specific handling before general intents
    switch (session.state) {
        //-------------------------------------
        // ADMISSION FLOW
        //-------------------------------------
        case 'admission_displayname':
        case 'admission_email':
        case 'admission_grade':
        case 'admission_semester':
        case 'admission_referral':
            {
                // Determine the type of validation based on state
                let validationType;
                switch (session.state) {
                    case 'admission_displayname':
                        validationType = 'name';
                        break;
                    case 'admission_email':
                        validationType = 'email';
                        break;
                    case 'admission_grade':
                        validationType = 'grade_level';
                        break;
                    case 'admission_semester':
                        validationType = 'semester';
                        break;
                    case 'admission_referral':
                        validationType = 'referral_source';
                        break;
                    default:
                        validationType = 'text';
                }

                const validationRes = await aiService.validateInput(validationType, userMessage);

                // Check if validation passed
                if (
                    (validationType === 'name' && validationRes.toLowerCase() === 'valid') ||
                    (validationType === 'email' && validationRes.toLowerCase() === 'valid') ||
                    (validationType === 'grade_level' && validationRes.toLowerCase().includes('grade')) ||
                    (validationType === 'semester' && validationRes.toLowerCase().includes('semester')) ||
                    (validationType === 'referral_source' && !validationRes.toLowerCase().includes('error'))
                ) {
                    // Save validated input
                    if (validationType === 'grade_level') {
                        session.data.grade = validationRes; // e.g., "Grade 3"
                    } else if (validationType === 'semester') {
                        session.data.semester = validationRes; // e.g., "Semester 1"
                    } else if (validationType === 'referral_source') {
                        session.data.referral = validationRes;
                    } else if (validationType === 'name') {
                        session.data.displayname = userMessage.trim(); // Consistent naming
                    } else {
                        session.data[validationType] = userMessage.trim();
                    }

                    // Determine next state
                    const nextStateMap = {
                        'name': 'admission_email',
                        'email': 'admission_grade',
                        'grade_level': 'admission_semester',
                        'semester': 'admission_referral',
                        'referral_source': 'admission_confirm',
                    };
                    session.state = nextStateMap[validationType];

                    // Send next prompt
                    await sendMessage(userId, getPromptForState(session.state, session.data));
                } else {
                    // Validation failed
                    let validationMessage = '';
                    switch (validationType) {
                        case 'name':
                            validationMessage = 'Please enter a valid full name (at least two words).';
                            break;
                        case 'email':
                            validationMessage = 'Please enter a valid email address.';
                            break;
                        case 'grade_level':
                            validationMessage = 'Please enter a valid grade (e.g., Grade 3).';
                            break;
                        case 'semester':
                            validationMessage = 'Please enter a valid semester (1 or 2).';
                            break;
                        case 'referral_source':
                            validationMessage = 'Please select a valid referral source from the options provided.';
                            break;
                        default:
                            validationMessage = `Please enter a valid ${validationType.replace('_', ' ')}.`;
                    }
                    await sendMessage(userId, `${validationMessage} ${validationRes}`);
                }

                userSessions.set(userId, session);
                break;
            }
        case 'admission_confirm':
            {
                let yesNo = await aiService.interpretYesNo(userMessage);
                yesNo = yesNo.toLowerCase(); // Normalize to lowercase

                if (yesNo === 'yes') {
                    try {
                        // Insert into DB
                        const [studentRows] = await pool.query('SELECT MAX(id) AS maxId FROM student');
                        const newStudentId = (studentRows[0].maxId || 0) + 1;

                        await pool.query(
                            `INSERT INTO student (id, displayname, grade, semester, referral, regdate, enrolled)
                         VALUES (?, ?, ?, ?, ?, NOW(), 0)`, [
                                newStudentId,
                                session.data.displayname,
                                session.data.grade,
                                session.data.semester.replace(/\D/g, ''), // "1" or "2"
                                session.data.referral,
                            ]
                        );

                        const [contactRows] = await pool.query('SELECT MAX(id) AS maxId FROM studentcontactinfo');
                        const newContactId = (contactRows[0].maxId || 0) + 1;

                        await pool.query(
                            `INSERT INTO studentcontactinfo (id, student_id, email, mobile)
                         VALUES (?, ?, ?, ?)`, [newContactId, newStudentId, session.data.email, userId.split('@')[0]]
                        );

                        session.state = 'meeting_offer';
                        session.data.studentId = newStudentId;

                        await sendMessage(
                            userId,
                            getPromptForState(session.state, session.data)
                        );
                        userSessions.set(userId, session);
                    } catch (err) {
                        console.error('Error during admission DB insert:', err.message);
                        await sendMessage(userId, 'There was a problem saving your data. Please try again later.');
                        userSessions.delete(userId);
                    }
                } else if (yesNo === 'no') {
                    session.state = 'admission_choose_detail_to_change';
                    await sendMessage(userId, getPromptForState(session.state, session.data));
                    userSessions.set(userId, session);
                } else {
                    await sendMessage(userId, 'I didn’t catch that. Are all details correct now? (Yes/No)');
                }
                break;
            }
        case 'admission_choose_detail_to_change':
            {
                const detail = userMessage.trim().toLowerCase();
                const validDetails = ['name', 'email', 'grade', 'semester', 'referral'];
                if (validDetails.includes(detail)) {
                    session.data.detailToUpdate = detail;
                    session.state = 'update_detail';
                    await sendMessage(userId, `Alright! Please provide your new ${detail.charAt(0).toUpperCase() + detail.slice(1)}.`);
                } else {
                    await sendMessage(userId, 'Please choose a valid detail to change: Name, Email, Grade, Semester, Referral.');
                }
                userSessions.set(userId, session);
                break;
            }
        case 'update_detail':
            {
                const detailToUpdate = session.data.detailToUpdate;
                let validationType;
                switch (detailToUpdate) {
                    case 'name':
                        validationType = 'name';
                        break;
                    case 'email':
                        validationType = 'email';
                        break;
                    case 'grade':
                        validationType = 'grade_level';
                        break;
                    case 'semester':
                        validationType = 'semester';
                        break;
                    case 'referral':
                        validationType = 'referral_source';
                        break;
                    default:
                        validationType = 'text';
                }

                const validationRes = await aiService.validateInput(validationType, userMessage);

                // Check if validation passed
                if (
                    (validationType === 'name' && validationRes.toLowerCase() === 'valid') ||
                    (validationType === 'email' && validationRes.toLowerCase() === 'valid') ||
                    (validationType === 'grade_level' && validationRes.toLowerCase().includes('grade')) ||
                    (validationType === 'semester' && validationRes.toLowerCase().includes('semester')) ||
                    (validationType === 'referral_source' && !validationRes.toLowerCase().includes('error'))
                ) {
                    // Save validated input
                    if (validationType === 'grade_level') {
                        session.data.grade = validationRes; // e.g., "Grade 3"
                    } else if (validationType === 'semester') {
                        session.data.semester = validationRes; // e.g., "Semester 1"
                    } else if (validationType === 'referral_source') {
                        session.data.referral = validationRes;
                    } else if (validationType === 'name') {
                        session.data.displayname = userMessage.trim(); // Consistent naming
                    } else {
                        session.data[validationType] = userMessage.trim();
                    }

                    session.data.detailToUpdate = null;
                    session.state = 'admission_confirm';

                    // Send updated confirmation
                    await sendMessage(userId, `Thank you! Your ${detailToUpdate} has been updated to ${session.data[detailToUpdate]}.`);
                    await sendMessage(userId, getPromptForState(session.state, session.data));
                } else {
                    // Validation failed
                    let validationMessage = '';
                    switch (validationType) {
                        case 'name':
                            validationMessage = 'Please enter a valid full name (at least two words).';
                            break;
                        case 'email':
                            validationMessage = 'Please enter a valid email address.';
                            break;
                        case 'grade_level':
                            validationMessage = 'Please enter a valid grade (e.g., Grade 3).';
                            break;
                        case 'semester':
                            validationMessage = 'Please enter a valid semester (1 or 2).';
                            break;
                        case 'referral_source':
                            validationMessage = 'Please select a valid referral source from the options provided.';
                            break;
                        default:
                            validationMessage = `Please enter a valid ${validationType.replace('_', ' ')}.`;
                    }
                    await sendMessage(userId, `${validationMessage} ${validationRes}`);
                }

                userSessions.set(userId, session);
                break;
            }
            case 'meeting_offer':
                {
                    let yesNo = await aiService.interpretYesNo(userMessage);
                    yesNo = yesNo.toLowerCase(); // Normalize to lowercase
                
                    if (yesNo === 'yes') {
                        session.state = 'meeting_show_slots';
                        userSessions.set(userId, session);
                
                        const gradeForSlots = session.data.grade || 'Grade 4';
                        const slots = await getAvailableSlots(gradeForSlots);
                        if (slots.length === 0) {
                            await sendMessage(userId, 'No available slots in the next three day (Sun–Thu, 8:00–15:00).');
                            userSessions.delete(userId);
                        } else {
                            // Build the user-facing message with month name, day, and time
                            let slotMsg = 'Available slots (Tomorrow and the next 2 days, 8:00 AM–3:00 PM, every 30 min, Sun–Thu):\n';
                            const slotsList = slots.map((s, i) => {
                                const dateStr = s.slotDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
                                const timeStr = s.slotDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });
                                return `${i + 1}. ${dateStr}, ${timeStr}`;
                            }).join('\n');
                            // Store the formatted slots list if needed for prompting
                            session.data.slotsList = slotsList;
                            slotMsg += `${slotsList}\nPlease choose a slot number:`;
                            await sendMessage(userId, slotMsg);
                        }
                    } else if (yesNo === 'no') {
                        await sendMessage(userId, 'No worries! Let me know if you need anything else.');
                        userSessions.delete(userId);
                    } else {
                        await sendMessage(userId, 'I didn’t catch that. Would you like to schedule a meeting? (Yes/No)');
                    }
                    break;
                }
                
        case 'meeting_show_slots':
            {
                const chosenNum = parseInt(userMessage.trim(), 10);
                const gradeForSlots = session.data.grade || 'Grade 4';
                const sessionSlots = await getAvailableSlots(gradeForSlots);

                if (!isNaN(chosenNum) && chosenNum > 0 && chosenNum <= sessionSlots.length) {
                    const chosenSlot = sessionSlots[chosenNum - 1];
                    const existing = await checkExistingAppointment(session.data.studentId);
                    if (existing) {
                        // They already have a scheduled appointment
                        await sendMessage(
                            userId,
                            `You already have an appointment on ${new Date(existing.appdate).toLocaleString()}.`
                        );
                        // Optionally, offer to reschedule or end
                        userSessions.delete(userId);
                    } else {
                        // Attempt to save the chosen slot
                        const success = await saveAppointment(
                            session.data.studentId,
                            chosenSlot.slotDate,
                            'Admission Inquiry'
                        );
                        if (success) {
                            await sendMessage(
                                userId,
                                `Your meeting is scheduled for ${chosenSlot.slotDate.toLocaleString()}.`
                            );
                            // Re-enable intents after completing the flow
                            session.intentDisabled = false;
                            userSessions.set(userId, session);
                        } else {
                            // If for some reason it just got booked
                            await sendMessage(
                                userId,
                                'Sorry, that slot got booked just now. Please choose another slot number.'
                            );
                            // Re-display available slots
                            const updatedSlots = await getAvailableSlots(gradeForSlots);
                            if (updatedSlots.length === 0) {
                                await sendMessage(userId, 'No available slots remaining in the next  three day.');
                                userSessions.delete(userId);
                            } else {
                                let slotMsg = 'Here are the updated available slots:\n';
                                const updatedSlotsList = updatedSlots.map((s, i) => {
                                    const dateStr = s.slotDate.toLocaleString('en-GB', {
                                        year: 'numeric',
                                        month: '2-digit',
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                    });
                                    return `${i + 1}. ${dateStr} (${s.section})`;
                                }).join('\n');
                                session.data.slotsList = updatedSlotsList; // Update slots list
                                slotMsg += `${updatedSlotsList}\nPlease choose a slot number:`;
                                await sendMessage(userId, slotMsg);
                            }
                        }
                    }
                } else {
                    await sendMessage(
                        userId,
                        'Invalid slot number. Please choose one of the listed options.'
                    );
                }
                break;
            }
            case 'awaiting_continue':
                {
                    // Process the user message for intent first
                    const intent = await aiService.determineIntent(userMessage, session.state);
                    console.log(`Determined intent: ${intent} for user: ${userId}`);
                
                    // If the user's message matches an intent like "AskFAQ", handle it directly
                    if (intent === 'AskFAQ') {
                        const answer = await aiService.answerQuestion(userMessage, inputContent);
                        await sendMessage(userId, answer || 'Could you please rephrase your question?');
                    } else {
                        // Automatically assume "yes" and continue
                        if (session.previousState) {
                            const restoredState = session.previousState;
                            session.state = restoredState;
                            delete session.previousState;
                            userSessions.set(userId, session);
                
                            // Re-ask the prompt based on the restored state
                            await sendMessage(userId, getPromptForState(restoredState, session.data));
                        } else {
                            await sendMessage(userId, 'Let’s continue. How can I assist you?');
                            userSessions.delete(userId);
                        }
                    }
                    break;
                }                         
        default:
            // Handle global intents if no specific state is matched
            const intent = await aiService.determineIntent(userMessage, session.state);
            console.log(`Determined intent: ${intent} for user: ${userId}`);

            if (intent === 'AdmissionFlow') {
                // Possibly check DB for partial data
                const [rows] = await pool.query(
                    `SELECT s.*, sci.mobile, sci.email 
                       FROM student s
                       JOIN studentcontactinfo sci ON s.id = sci.student_id
                      WHERE (sci.mobile = ? OR sci.mobile2 = ?)
                        AND s.enrolled = 0`, [userId.split('@')[0], userId.split('@')[0]]
                );
                if (rows.length > 0) {
                    // Resume from confirm
                    session = { state: 'admission_confirm', data: {} };
                    session.data.studentId = rows[0].id;
                    session.data.displayname = rows[0].displayname;
                    session.data.email = rows[0].email;
                    session.data.grade = `Grade ${rows[0].grade}`;
                    session.data.semester = `Semester ${rows[0].semester}`;
                    session.data.referral = rows[0].referral || 'Unknown';
                    userSessions.set(userId, session);

                    await sendMessage(
                        userId,
                        getPromptForState(session.state, session.data)
                    );
                } else {
                    // Start new admission flow
                    session = { state: 'admission_displayname', data: {} };
                    userSessions.set(userId, session);
                    await sendMessage(userId, getPromptForState(session.state, session.data));
                }
            } else if (intent === 'AskFAQ') {
                // Handle FAQ interruption
                // Save current state if any
                if (session && session.state) {
                    session.previousState = session.state;
                    session.state = 'awaiting_continue';
                    userSessions.set(userId, session);
                } else {
                    session = { state: 'awaiting_continue', data: {} };
                    userSessions.set(userId, session);
                }

                const answer = await aiService.answerQuestion(userMessage, inputContent);
                console.log(`FAQ Answer: ${answer}`);
                await sendMessage(userId, answer || 'Could you please rephrase your question?');
                // After answering FAQ, ask if user wants to continue
                await sendMessage(userId, getPromptForState(session.state, session.data));

                if (session.previousState === 'admission_confirm') {
                    session.intentDisabled = true;
                    userSessions.set(userId, session);
                }

                // Return to prevent falling through
                return;
            }

            // If no matching state and no general intent, prompt the user
            await sendMessage(
                userId,
                'Hello! You can ask about admissions or any general question about the school.'
            );
            userSessions.delete(userId);
            break;
    }
}

/**
 * Main message handler
 */
client.on('message', async (msg) => {
        try {
            const userId = msg.from;
            const userMessage = sanitizer.sanitizeInput(msg.body);
            const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
        // 1. Ignore messages older than the bot start time
        if (msg.timestamp * 1000 < botStartTime.getTime()) {
            console.log("Ignoring message from before the bot started");
            return;
        }

        try {
            // ... the rest of your existing logic ...
        } catch (err) {
            console.error('Error handling message:', err.message);
        }
        // Rate limiting
        if (rateLimiter.isRateLimited(userId)) {
            await sendMessage(userId, 'You are sending messages too quickly.');
            return;
        }

        // Log/save message
        await userMessageModel.saveUserMessage(userId, userMessage, timestamp);
        logger.logInteraction(userId, userMessage, timestamp);

        // Check existing session first
        let session = userSessions.get(userId);
        if (session && session.state) {
            await handleSession(userId, userMessage, session);
            return;
        }

        // Not mid-flow, determine intent
        const userRole = await getUserRole(userId); // for role-based info if needed
        const { allowedInfo, restrictedInfo } = getUserInfoRestrictions(userRole);

        const intent = await aiService.determineIntent(userMessage, '');
        console.log(`Determined intent: ${intent} for user: ${userId}`);

        if (intent === 'AdmissionFlow') {
            // Possibly check DB for partial data
            const [rows] = await pool.query(
                `SELECT s.*, sci.mobile, sci.email 
                   FROM student s
                   JOIN studentcontactinfo sci ON s.id = sci.student_id
                  WHERE (sci.mobile = ? OR sci.mobile2 = ?)
                    AND s.enrolled = 0`, [userId.split('@')[0], userId.split('@')[0]]
            );
            if (rows.length > 0) {
                // Resume from confirm
                session = { state: 'admission_confirm', data: {} };
                session.data.studentId = rows[0].id;
                session.data.displayname = rows[0].displayname;
                session.data.email = rows[0].email;
                session.data.grade = `Grade ${rows[0].grade}`;
                session.data.semester = `Semester ${rows[0].semester}`;
                session.data.referral = rows[0].referral || 'Unknown';
                userSessions.set(userId, session);

                await sendMessage(
                    userId,
                    getPromptForState(session.state, session.data)
                );
            } else {
                // Start new admission flow
                session = { state: 'admission_displayname', data: {} };
                userSessions.set(userId, session);
                await sendMessage(userId, getPromptForState(session.state, session.data));
            }
        } else if (intent === 'AskFAQ') {
            // Handle FAQ interruption
            // Save current state if any
            if (session && session.state) {
                session.previousState = session.state;
                session.state = 'awaiting_continue';
                userSessions.set(userId, session);
            } else {
                session = { state: 'awaiting_continue', data: {} };
                userSessions.set(userId, session);
            }

            const answer = await aiService.answerQuestion(userMessage, inputContent);
            console.log(`FAQ Answer: ${answer}`);
            await sendMessage(userId, answer || 'Could you please rephrase your question?');
            // After answering FAQ, ask if user wants to continue
            await sendMessage(userId, getPromptForState(session.state, session.data));
        } else {
            // Unrecognized intent
            await sendMessage(
                userId,
                'Hello! You can ask about admissions or any general question about the school.'
            );
        }
    } catch (err) {
        console.error('Error handling message:', err.message);
    }
});

module.exports = {};
