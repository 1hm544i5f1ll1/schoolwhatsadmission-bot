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

// Mapping from validation type to session storage key.
const storeKeyMapping = {
  'name': 'displayname',
  'email': 'email',
  'grade_level': 'grade',
  'semester': 'semester',
  'referral_source': 'referral'
};

/**
 * Retrieve user info from the DB based on phone number.
 */
async function getUserInfo(userPhone) {
  const phone = userPhone.split('@')[0];
  // Try guardian first.
  const [guardianRows] = await pool.query('SELECT * FROM guardian WHERE mobile = ?', [phone]);
  if (guardianRows.length > 0) {
    return { role: 'parent', data: guardianRows[0] };
  }
  // Then check student.
  const [studentRows] = await pool.query(
    'SELECT * FROM studentcontactinfo WHERE mobile = ? OR mobile2 = ?',
    [phone, phone]
  );
  if (studentRows.length > 0) {
    return { role: 'student', data: studentRows[0] };
  }
  return null;
}

/**
 * Determine user role from the DB (fallback).
 */
async function getUserRole(userPhone) {
  const phone = userPhone.split('@')[0];
  const [guardianRows] = await pool.query('SELECT id FROM guardian WHERE mobile = ?', [phone]);
  if (guardianRows.length > 0) return 'parent';
  const [studentRows] = await pool.query(
    'SELECT id FROM studentcontactinfo WHERE mobile = ? OR mobile2 = ?',
    [phone, phone]
  );
  if (studentRows.length > 0) return 'student';
  return 'visitor';
}

/**
 * Provide allowed and restricted info based on user role.
 */
function getUserInfoRestrictions(userType) {
  let allowedInfo = '';
  let restrictedInfo = '';

  if (userType === 'student') {
    allowedInfo =
      'You can provide information about class schedules, upcoming exams, school resources, extracurricular activities, and school events.';
    restrictedInfo =
      "Do not provide details about staff salaries, internal policies, confidential reports, or other sensitive data.";
  } else if (userType === 'parent') {
    allowedInfo =
      'You can provide public info such as admission procedures, school tour details, contact info, public events, and directions.';
    restrictedInfo =
      'Do not provide student-related personal data, internal policies, or financial data.';
  } else {
    allowedInfo =
      'You can provide general information about the school, admission process, and contact details.';
    restrictedInfo = 'Do not share any confidential information.';
  }
  return { allowedInfo, restrictedInfo };
}

/**
 * Get prompt message based on session state.
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
- Name: ${sessionData.displayname || 'Not provided'}
- Email: ${sessionData.email || 'Not provided'}
- Grade: ${sessionData.grade || 'Not provided'}
- Semester: ${sessionData.semester || 'Not provided'}
- Referral: ${sessionData.referral || 'Not provided'}

Are all details correct now? (Yes/No)`;
    case 'admission_change_or_cancel':
      return 'Would you like to change any detail or cancel the admission process? (Reply "Change" or "Cancel")';
    case 'admission_choose_detail_to_change':
      return 'Which detail would you like to change? (Name, Email, Grade, Semester, Referral)';
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
    default:
      return '';
  }
}

/**
 * Check if the validation response is acceptable.
 */
function isValidValidation(result) {
  return result.toLowerCase() === 'valid' || !result.toLowerCase().endsWith('please try again.');
}

/**
 * Read an admission record from the DB.
 */
async function readAdmission(userPhone) {
  const phone = userPhone.split('@')[0];
  const query = `
    SELECT s.id, s.displayname, s.grade, s.semester, s.referral, s.regdate, s.enrolled,
           sci.email, sci.mobile
    FROM student s
    JOIN studentcontactinfo sci ON s.id = sci.student_id
    WHERE sci.mobile = ?`;
  const [rows] = await pool.query(query, [phone]);
  return rows;
}

/**
 * Remove an admission record from the DB.
 */
async function removeAdmission(userPhone) {
  const phone = userPhone.split('@')[0];
  const contactQuery = `SELECT student_id FROM studentcontactinfo WHERE mobile = ?`;
  const [contactRows] = await pool.query(contactQuery, [phone]);
  if (contactRows.length === 0) return false;
  const studentId = contactRows[0].student_id;
  await pool.query(`DELETE FROM studentcontactinfo WHERE student_id = ?`, [studentId]);
  await pool.query(`DELETE FROM student WHERE id = ?`, [studentId]);
  return true;
}

/**
 * Main session handler for admission and meeting flows.
 */
async function handleSession(userId, userMessage, session) {
  if (session.intentDisabled) {
    await sendMessage(userId, 'Your admission process is complete. Let us know if you need anything else.');
    return;
  }

  switch (session.state) {
    // Admission flow data collection
    case 'admission_displayname':
    case 'admission_email':
    case 'admission_grade':
    case 'admission_semester':
    case 'admission_referral': {
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

      // Local check for grade and semester
      if (validationType === 'grade_level') {
        const gradeMatch = userMessage.match(/(\d+)/);
        if (!gradeMatch) {
          await sendMessage(userId, 'Invalid grade. Please try again.');
          userSessions.set(userId, session);
          break;
        }
        session.data.grade = `Grade ${gradeMatch[1]}`;
        session.state = 'admission_semester';
        await sendMessage(userId, getPromptForState(session.state, session.data));
        userSessions.set(userId, session);
        break;
      }
      if (validationType === 'semester') {
        const semMatch = userMessage.match(/([12])/);
        if (!semMatch) {
          await sendMessage(userId, 'Invalid semester. Please try again.');
          userSessions.set(userId, session);
          break;
        }
        session.data.semester = `Semester ${semMatch[1]}`;
        session.state = 'admission_referral';
        await sendMessage(userId, getPromptForState(session.state, session.data));
        userSessions.set(userId, session);
        break;
      }

      const validationRes = await aiService.validateInput(validationType, userMessage);
      if (isValidValidation(validationRes)) {
        const storeKey = storeKeyMapping[validationType] || validationType;
        session.data[storeKey] = userMessage.trim();
        const nextStateMap = {
          'name': 'admission_email',
          'email': 'admission_grade',
          'grade_level': 'admission_semester',
          'semester': 'admission_referral',
          'referral_source': 'admission_confirm',
        };
        session.state = nextStateMap[validationType] || session.state;
        await sendMessage(userId, getPromptForState(session.state, session.data));
      } else {
        await sendMessage(userId, validationRes);
      }
      userSessions.set(userId, session);
      break;
    }
    case 'admission_confirm': {
      let yesNo = await aiService.interpretYesNo(userMessage);
      yesNo = yesNo.toLowerCase();
      if (yesNo === 'yes') {
        try {
          // Insert new admission record
          const [studentRows] = await pool.query('SELECT MAX(id) AS maxId FROM student');
          const newStudentId = (studentRows[0].maxId || 0) + 1;
          await pool.query(
            `INSERT INTO student (id, displayname, grade, semester, referral, regdate, enrolled)
             VALUES (?, ?, ?, ?, ?, NOW(), 0)`,
            [
              newStudentId,
              session.data.displayname,
              session.data.grade,
              session.data.semester.replace(/\D/g, ''),
              session.data.referral,
            ]
          );
          const [contactRows] = await pool.query('SELECT MAX(id) AS maxId FROM studentcontactinfo');
          const newContactId = (contactRows[0].maxId || 0) + 1;
          await pool.query(
            `INSERT INTO studentcontactinfo (id, student_id, email, mobile)
             VALUES (?, ?, ?, ?)`,
            [newContactId, newStudentId, session.data.email, userId.split('@')[0]]
          );
          session.state = 'meeting_offer';
          session.data.studentId = newStudentId;
          await sendMessage(userId, getPromptForState(session.state, session.data));
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
        await sendMessage(userId, 'I did not understand. Are all details correct? (Yes/No)');
      }
      break;
    }
    case 'admission_choose_detail_to_change': {
      const detail = userMessage.trim().toLowerCase();
      const validDetails = ['name', 'email', 'grade', 'semester', 'referral'];
      if (validDetails.includes(detail)) {
        session.data.detailToUpdate = detail;
        session.state = 'update_detail';
        await sendMessage(userId, `Please provide your new ${detail.charAt(0).toUpperCase() + detail.slice(1)}.`);
      } else {
        await sendMessage(userId, 'Please choose a valid detail: Name, Email, Grade, Semester, or Referral.');
      }
      userSessions.set(userId, session);
      break;
    }
    case 'update_detail': {
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
      if (isValidValidation(validationRes)) {
        const storeKey = storeKeyMapping[validationType] || validationType;
        session.data[storeKey] = userMessage.trim();
        session.data.detailToUpdate = null;
        session.state = 'admission_confirm';
        await sendMessage(userId, `Thank you! Your ${detailToUpdate} has been updated to ${session.data[storeKey]}.`);
        await sendMessage(userId, getPromptForState(session.state, session.data));
      } else {
        await sendMessage(userId, validationRes);
      }
      userSessions.set(userId, session);
      break;
    }
    case 'meeting_offer': {
      let yesNo = await aiService.interpretYesNo(userMessage);
      yesNo = yesNo.toLowerCase();
      if (yesNo === 'yes') {
        session.state = 'meeting_show_slots';
        userSessions.set(userId, session);
        const gradeForSlots = session.data.grade || 'Grade 4';
        const slots = await getAvailableSlots(gradeForSlots);
        if (slots.length === 0) {
          await sendMessage(userId, 'No available slots in the next three days (Sun–Thu, 8:00–15:00).');
          userSessions.delete(userId);
        } else {
          let slotMsg = 'Available slots (Tomorrow and the next 2 days, 8:00 AM–3:00 PM, every 30 min, Sun–Thu):\n';
          const slotsList = slots.map((s, i) => {
            const dateStr = s.slotDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
            const timeStr = s.slotDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });
            return `${i + 1}. ${dateStr}, ${timeStr}`;
          }).join('\n');
          session.data.slotsList = slotsList;
          slotMsg += `${slotsList}\nPlease choose a slot number:`;
          await sendMessage(userId, slotMsg);
        }
      } else if (yesNo === 'no') {
        await sendMessage(userId, 'No worries! Let us know if you need anything else.');
        userSessions.delete(userId);
      } else {
        await sendMessage(userId, 'I did not understand. Would you like to schedule a meeting? (Yes/No)');
      }
      break;
    }
    case 'meeting_show_slots': {
      const chosenNum = parseInt(userMessage.trim(), 10);
      const gradeForSlots = session.data.grade || 'Grade 4';
      const sessionSlots = await getAvailableSlots(gradeForSlots);
      if (!isNaN(chosenNum) && chosenNum > 0 && chosenNum <= sessionSlots.length) {
        const chosenSlot = sessionSlots[chosenNum - 1];
        const existing = await checkExistingAppointment(session.data.studentId);
        if (existing) {
          await sendMessage(userId, `You already have an appointment on ${new Date(existing.appdate).toLocaleString()}.`);
          userSessions.delete(userId);
        } else {
          const success = await saveAppointment(session.data.studentId, chosenSlot.slotDate, 'Admission Inquiry');
          if (success) {
            await sendMessage(userId, `Your meeting is scheduled for ${chosenSlot.slotDate.toLocaleString()}.`);
            session.intentDisabled = true;
            userSessions.set(userId, session);
          } else {
            await sendMessage(userId, 'Sorry, that slot just got booked. Please choose another slot number.');
            const updatedSlots = await getAvailableSlots(gradeForSlots);
            if (updatedSlots.length === 0) {
              await sendMessage(userId, 'No available slots remaining in the next three days.');
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
                return `${i + 1}. ${dateStr}`;
              }).join('\n');
              session.data.slotsList = updatedSlotsList;
              slotMsg += `${updatedSlotsList}\nPlease choose a slot number:`;
              await sendMessage(userId, slotMsg);
            }
          }
        }
      } else {
        await sendMessage(userId, 'Invalid slot number. Please choose one of the listed options.');
      }
      break;
    }
    case 'awaiting_continue': {
      const intent = await aiService.determineIntent(userMessage, session.state);
      console.log(`Determined intent: ${intent} for user: ${userId}`);
      if (intent === 'AskFAQ') {
        const answer = await aiService.answerQuestion(userMessage, inputContent);
        await sendMessage(userId, answer || 'Could you please rephrase your question?');
      } else {
        if (session.previousState) {
          const restoredState = session.previousState;
          session.state = restoredState;
          delete session.previousState;
          userSessions.set(userId, session);
          await sendMessage(userId, getPromptForState(restoredState, session.data));
        } else {
          await sendMessage(userId, 'Let’s continue. How can I assist you?');
          userSessions.delete(userId);
        }
      }
      break;
    }
    default: {
      // Global intent handling
      const intent = await aiService.determineIntent(userMessage, session.state);
      console.log(`Determined intent: ${intent} for user: ${userId}`);
      if (intent === 'AdmissionFlow') {
        // Check for partial admission data to resume flow
        const [rows] = await pool.query(
          `SELECT s.*, sci.mobile, sci.email 
           FROM student s
           JOIN studentcontactinfo sci ON s.id = sci.student_id
           WHERE (sci.mobile = ? OR sci.mobile2 = ?)
             AND s.enrolled = 0`,
          [userId.split('@')[0], userId.split('@')[0]]
        );
        if (rows.length > 0) {
          session = { state: 'admission_confirm', data: {} };
          session.data.studentId = rows[0].id;
          session.data.displayname = rows[0].displayname;
          session.data.email = rows[0].email;
          session.data.grade = `Grade ${rows[0].grade}`;
          session.data.semester = `Semester ${rows[0].semester}`;
          session.data.referral = rows[0].referral || 'Unknown';
          userSessions.set(userId, session);
          await sendMessage(userId, getPromptForState(session.state, session.data));
        } else {
          session = { state: 'admission_displayname', data: {} };
          userSessions.set(userId, session);
          await sendMessage(userId, getPromptForState(session.state, session.data));
        }
      } else if (intent === 'AskFAQ') {
        if (session && session.state) {
          session.previousState = session.state;
          session.state = 'awaiting_continue';
          userSessions.set(userId, session);
        } else {
          session = { state: 'awaiting_continue', data: {} };
          userSessions.set(userId, session);
        }
        const answer = await aiService.answerQuestion(userMessage, inputContent);
        await sendMessage(userId, answer || 'Could you please rephrase your question?');
        await sendMessage(userId, getPromptForState(session.state, session.data));
      } else {
        await sendMessage(userId, 'Hello! You can ask about admissions or any general question about the school.');
        userSessions.delete(userId);
      }
      break;
    }
  }
}

/**
 * Client ready event.
 */
client.on('ready', () => {
  console.log('IVY Help Bot is ready and connected to the database.');
});

/**
 * Main message handler.
 */
client.on('message', async (msg) => {
  try {
    const userId = msg.from;
    const userMessage = sanitizer.sanitizeInput(msg.body);
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (msg.timestamp * 1000 < botStartTime.getTime()) {
      console.log("Ignoring message from before the bot started");
      return;
    }
    if (rateLimiter.isRateLimited(userId)) {
      await sendMessage(userId, 'You are sending messages too quickly.');
      return;
    }
    // Log and save message
    await userMessageModel.saveUserMessage(userId, userMessage, timestamp);
    logger.logInteraction(userId, userMessage, timestamp);

    // Check for an active session.
    let session = userSessions.get(userId);
    if (session && session.state) {
      await handleSession(userId, userMessage, session);
      return;
    }

    // Determine intent first.
    const intent = await aiService.determineIntent(userMessage, '');
    console.log(`Determined intent: ${intent} for user: ${userId}`);

    if (intent === 'AdmissionFlow') {
      // Check for partial admission data to resume flow.
      const [rows] = await pool.query(
        `SELECT s.*, sci.mobile, sci.email 
         FROM student s
         JOIN studentcontactinfo sci ON s.id = sci.student_id
         WHERE (sci.mobile = ? OR sci.mobile2 = ?)
           AND s.enrolled = 0`,
        [userId.split('@')[0], userId.split('@')[0]]
      );
      if (rows.length > 0) {
        session = { state: 'admission_confirm', data: {} };
        session.data.studentId = rows[0].id;
        session.data.displayname = rows[0].displayname;
        session.data.email = rows[0].email;
        session.data.grade = `Grade ${rows[0].grade}`;
        session.data.semester = `Semester ${rows[0].semester}`;
        session.data.referral = rows[0].referral || 'Unknown';
        userSessions.set(userId, session);
        await sendMessage(userId, getPromptForState(session.state, session.data));
      } else {
        session = { state: 'admission_displayname', data: {} };
        userSessions.set(userId, session);
        await sendMessage(userId, getPromptForState(session.state, session.data));
      }
    } else if (intent === 'AskFAQ') {
      if (session && session.state) {
        session.previousState = session.state;
        session.state = 'awaiting_continue';
        userSessions.set(userId, session);
      } else {
        session = { state: 'awaiting_continue', data: {} };
        userSessions.set(userId, session);
      }
      const answer = await aiService.answerQuestion(userMessage, inputContent);
      await sendMessage(userId, answer || 'Could you please rephrase your question?');
      await sendMessage(userId, getPromptForState(session.state, session.data));
    } else {
      // For other intents, check for basic user info.
      const userInfo = await getUserInfo(userId);
      if (userInfo) {
        await sendMessage(
          userId,
          `We found your info as a ${userInfo.role}:\n${JSON.stringify(userInfo.data, null, 2)}`
        );
        session = { state: 'awaiting_continue', data: {} };
        userSessions.set(userId, session);
        await sendMessage(userId, getPromptForState(session.state, session.data));
      } else {
        await sendMessage(userId, 'Hello! You can ask about admissions or any general question about the school.');
      }
    }
  } catch (err) {
    console.error('Error handling message:', err.message);
  }
});

module.exports = {};
