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
const { getAvailableSlots, saveAppointment, checkExistingAppointment, getAllFutureAppointments } = require('../services/appointmentService');
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
      return 'Please provide your full name. You can type "exit" at any time to cancel the process.';
    case 'admission_email':
      return 'What is your email address? You can type "exit" at any time to cancel the process.';
    case 'admission_grade':
      return 'For which grade are you applying? (e.g., Grade 3). You can type "exit" at any time to cancel the process.';
    case 'admission_semester':
      return 'Which semester are you applying for? (1 or 2). You can type "exit" at any time to cancel the process.';
    case 'admission_referral':
      return 'How did you hear about us? (Twitter, Facebook, Instagram, YouTube, Friend, Other). You can type "exit" at any time to cancel the process.';
    case 'admission_confirm':
      // Only show review details if we have at least some data
      if (!sessionData.displayname && !sessionData.email && !sessionData.grade && !sessionData.semester && !sessionData.referral) {
        return 'Let\'s start the admission process. Please provide your full name. You can type "exit" at any time to cancel the process.';
      }
      return `Please review your details:
- Name: ${sessionData.displayname || 'Not provided'}
- Email: ${sessionData.email || 'Not provided'}
- Grade: ${sessionData.grade || 'Not provided'}
- Semester: ${sessionData.semester || 'Not provided'}
- Referral: ${sessionData.referral || 'Not provided'}

Are all details correct? (Yes/No) You can type "exit" at any time to cancel the process.`;
    case 'admission_change_or_cancel':
      return 'Would you like to change any detail or cancel the admission process? (Reply "Change" or "Cancel")';
    case 'admission_choose_detail_to_change':
      return 'Which detail would you like to change? (Name, Email, Grade, Semester, Referral). You can type "exit" at any time to cancel the process.';
    case 'update_detail':
      return `Please provide the new value for ${sessionData.detailToUpdate.charAt(0).toUpperCase() + sessionData.detailToUpdate.slice(1)}. You can type "exit" at any time to cancel the process.`;
    case 'meeting_offer':
      return 'Your admission is submitted. Would you like to schedule a meeting now? (Yes/No) You can type "exit" at any time to cancel the process.';
    case 'meeting_show_slots':
      return `Available slots (8:00 AM–3:00 PM, every 30 min, Sun–Thu):
${sessionData.slotsList}
Please choose a slot number. You can type "exit" at any time to cancel the process.`;
    case 'awaiting_continue':
      return 'How can I help you today?';
    case 'check_existing_appointment':
      return 'Would you like to proceed with the admission process anyway? (Yes/No)';
    case 'confirm_existing_data':
      return 'Would you like to use these details? (Yes/No)';
    case 'confirm_replace_appointment':
      return 'Do you want to replace the existing appointment? (Yes/No)';
    case 'confirm_book_another_appointment':
      return 'Would you like to book another appointment? (Yes/No)';
    default:
      return '';
  }
}

/**
 * Check if the validation response is acceptable.
 */
function isValidValidation(result) {
    // Check if the response is exactly "valid" or starts with "valid" followed by a space
    const normalized = result.toLowerCase().trim();
    console.log('Checking validation:', normalized);
    return normalized === 'valid' || normalized.startsWith('valid ');
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

  // Check for exit command
  if (userMessage.toLowerCase() === 'exit') {
    userSessions.delete(userId);
    await sendMessage(userId, 'Admission process cancelled. You can start again anytime.');
    return;
  }

  switch (session.state) {
    case 'confirm_book_another_appointment': {
      const yesNo = await aiService.interpretYesNo(userMessage);
      if (yesNo.toLowerCase() === 'yes') {
          // User wants to book another. NOW check for existing data.
          const phone = userId.split('@')[0];
          const [existingData] = await pool.query(
              `SELECT s.id, s.displayname, s.grade, s.semester, s.referral, sci.email 
               FROM student s
               JOIN studentcontactinfo sci ON s.id = sci.student_id
               WHERE (sci.mobile = ? OR sci.mobile2 = ?)
                 AND s.enrolled = 0`,
              [phone, phone]
          );

          if (existingData.length > 0) {
              // Data found, ask user to confirm using it
              session.data = {
                studentId: existingData[0].id,
                displayname: existingData[0].displayname,
                email: existingData[0].email,
                grade: existingData[0].grade ? parseInt(existingData[0].grade, 10) : null,
                semester: existingData[0].semester ? parseInt(existingData[0].semester, 10) : null,
                referral: existingData[0].referral || 'Unknown'
              };
              session.state = 'confirm_existing_data';
              session.checkedExistingData = true;
              await sendMessage(userId, 
                `We found your information based on your phone number:\n` +
                `- Name: ${existingData[0].displayname}\n` +
                `- Email: ${existingData[0].email}\n` +
                `- Grade: ${existingData[0].grade}\n` +
                `- Semester: ${existingData[0].semester}\n` +
                `- Referral: ${existingData[0].referral}\n\n` +
                `Would you like to use these details? (Reply "Yes" to use them, or "No" to fill out the form)`
              );
          } else {
              // No data found, proceed to ask for name
              session.state = 'admission_displayname';
              session.checkedExistingData = true; // Mark check done (needed for subsequent steps)
              session.data = {}; // Ensure data is empty
              await sendMessage(userId, getPromptForState(session.state, session.data));
          }
      } else {
          // User does not want to book another appointment
          await sendMessage(userId, 'Okay. Your existing appointments remain scheduled. Let us know if you need anything else.');
          userSessions.delete(userId);
          return;
      }
      userSessions.set(userId, session);
      break;
    }

    case 'confirm_existing_data': {
      const yesNo = await aiService.interpretYesNo(userMessage);
      if (yesNo.toLowerCase() === 'yes') {
        // User confirmed using the found data
        // Check if an appointment was mentioned (this check seems redundant now based on the new flow)
        // Let's directly proceed to offer meeting if they confirm data use.
        session.state = 'meeting_offer';
        await sendMessage(userId, getPromptForState(session.state, session.data));
      } else if (yesNo.toLowerCase() === 'no') {
        // User wants to correct the found data
        session.state = 'admission_choose_detail_to_change'; // Go to change detail state
        session.data = session.data || {}; // Ensure session.data exists
        await sendMessage(userId, getPromptForState(session.state, session.data));
      } else {
        // Did not understand Yes/No - Re-prompt
        await sendMessage(userId, "Sorry, I didn't understand. Please reply 'Yes' to use the found details or 'No' to fill out the form.");
        // Do not change state, wait for valid response
      }
      break;
    }

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

      // Let the AI service handle all validation
      const validationRes = await aiService.validateInput(validationType, userMessage);
      console.log('=== Validation Details ===');
      console.log('User Input:', userMessage);
      console.log('Validation Type:', validationType);
      console.log('AI Response:', validationRes);
      console.log('Current State:', session.state);
      console.log('Session Data:', session.data);
      
      if (isValidValidation(validationRes)) {
        console.log('Validation PASSED');
        const storeKey = storeKeyMapping[validationType] || validationType;
        
        // Extract the raw value from the AI response (usually after "valid ")
        let extractedValue = userMessage.trim(); // Fallback to user input
        if (validationRes.toLowerCase().startsWith('valid ')){
           extractedValue = validationRes.substring(6).trim(); 
        }

        // Store integer for grade and semester, otherwise store the extracted string
        if (storeKey === 'grade') {
          const gradeMatch = extractedValue.match(/\d+/);
          session.data[storeKey] = gradeMatch ? parseInt(gradeMatch[0], 10) : null;
        } else if (storeKey === 'semester') {
          const semesterMatch = extractedValue.match(/\d+/);
          session.data[storeKey] = semesterMatch ? parseInt(semesterMatch[0], 10) : null;
        } else {
          session.data[storeKey] = extractedValue; // Store the validated/extracted value
        }
        
        console.log('Stored Data:', session.data);
        
        // Move to the next state based on current state
        let nextState = '';
        switch (session.state) {
          case 'admission_displayname':
            nextState = 'admission_email';
            break;
          case 'admission_email':
            nextState = 'admission_grade';
            break;
          case 'admission_grade':
            nextState = 'admission_semester';
            break;
          case 'admission_semester':
            nextState = 'admission_referral';
            break;
          case 'admission_referral':
            nextState = 'admission_confirm';
            break;
        }
        console.log('Moving from', session.state, 'to', nextState);
        session.state = nextState;
        
        // Save session before sending next prompt
        userSessions.set(userId, session);
        await sendMessage(userId, getPromptForState(session.state, session.data));
      } else {
        console.log('Validation FAILED');
        // Send the AI's validation error message
        await sendMessage(userId, validationRes);
        await sendMessage(userId, getPromptForState(session.state, session.data));
        userSessions.set(userId, session);
      }
      console.log('=== End Validation ===');
      break;
    }

    case 'check_existing_appointment': {
      const yesNo = await aiService.interpretYesNo(userMessage);
      if (yesNo.toLowerCase() === 'yes') {
        // User wants to proceed despite existing appointment.
        // NOW check for existing user data.
        const phone = userId.split('@')[0];
        const [existingData] = await pool.query(
            `SELECT s.id, s.displayname, s.grade, s.semester, s.referral, sci.email 
             FROM student s
             JOIN studentcontactinfo sci ON s.id = sci.student_id
             WHERE (sci.mobile = ? OR sci.mobile2 = ?)
               AND s.enrolled = 0`,
            [phone, phone]
        );

        if (existingData.length > 0) {
            // Data found, ask user to confirm using it
            const data = existingData[0];
            session.data = {
                studentId: data.id,
                displayname: data.displayname,
                email: data.email,
                grade: data.grade ? parseInt(data.grade, 10) : null,
                semester: data.semester ? parseInt(data.semester, 10) : null,
                referral: data.referral || 'Unknown'
            };
            session.state = 'confirm_existing_data';
            session.checkedExistingData = true;
            await sendMessage(userId, 
              `We found your information based on your phone number:\n` +
              `- Name: ${data.displayname}\n` +
              `- Email: ${data.email}\n` +
              `- Grade: ${data.grade}\n` +
              `- Semester: ${data.semester}\n` +
              `- Referral: ${data.referral}\n\n` +
              `Would you like to use these details? (Reply "Yes" to use them, or "No" to fill out the form)`
            );
        } else {
            // No data found, proceed to ask for name
            session.state = 'admission_displayname';
            session.checkedExistingData = true; // Mark check done
            session.data = {}; // Ensure data is empty
            await sendMessage(userId, getPromptForState(session.state, session.data));
        }
      } else {
        // User chose not to proceed with admission due to existing appointment
        userSessions.delete(userId);
        await sendMessage(userId, 'Okay, admission process cancelled. Your existing appointment remains scheduled. Let us know if you need anything else.');
        return; // Added return
      }
      userSessions.set(userId, session);
      break;
    }

    case 'admission_confirm': {
      const yesNo = await aiService.interpretYesNo(userMessage);
      if (yesNo.toLowerCase() === 'yes') {
        try {
          // Check if we're updating existing data or creating new
          if (session.data.studentId) {
            // Update existing record
            const currentPhone = userId.split('@')[0];
            await pool.query(
              `UPDATE studentcontactinfo 
               SET email = ?, mobile = ? 
               WHERE student_id = ?`,
              [session.data.email, currentPhone, session.data.studentId]
            );
            await pool.query(
              `UPDATE student 
               SET displayname = ?, grade = ?, semester = ?, referral = ?
               WHERE id = ?`,
              [
                session.data.displayname,
                session.data.grade,
                session.data.semester,
                session.data.referral,
                session.data.studentId
              ]
            );
          } else {
            // Create new record
            const [studentRows] = await pool.query('SELECT MAX(id) AS maxId FROM student');
            const newStudentId = (studentRows[0].maxId || 0) + 1;
            await pool.query(
              `INSERT INTO student (id, displayname, grade, semester, referral, regdate, enrolled)
               VALUES (?, ?, ?, ?, ?, NOW(), 0)`,
              [
                newStudentId,
                session.data.displayname,
                session.data.grade,
                session.data.semester,
                session.data.referral
              ]
            );
            const [contactRows] = await pool.query('SELECT MAX(id) AS maxId FROM studentcontactinfo');
            const newContactId = (contactRows[0].maxId || 0) + 1;
            await pool.query(
              `INSERT INTO studentcontactinfo (id, student_id, email, mobile)
               VALUES (?, ?, ?, ?)`,
              [newContactId, newStudentId, session.data.email, userId.split('@')[0]]
            );
            session.data.studentId = newStudentId;
          }
          
          session.state = 'meeting_offer';
          await sendMessage(userId, getPromptForState(session.state, session.data));
          userSessions.set(userId, session);
        } catch (err) {
          console.error('Error during admission DB update:', err.message);
          console.error('Session data:', session.data);
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
        let valueToStore = userMessage.trim(); // Default to trimmed user input

        // Special handling for grade and semester to ensure they are stored as numbers
        if (storeKey === 'grade' || storeKey === 'semester') {
          let extractedValue = null;
          // Attempt 1: Extract number from validationRes (e.g., "valid 9")
          if (validationRes.toLowerCase().startsWith('valid ')) {
            const potentialNumberStr = validationRes.substring(6).trim();
            const match = potentialNumberStr.match(/\d+/);
            if (match) {
              extractedValue = parseInt(match[0], 10);
            }
          }
          // Attempt 2: Extract number from original userMessage if Attempt 1 failed
          if (extractedValue === null) {
            const match = userMessage.match(/\d+/);
            if (match) {
              extractedValue = parseInt(match[0], 10);
            }
          }
          // Attempt 3: If still null, maybe the AI just said "valid" and user typed "four"
          // We could add word-to-number conversion here if needed, but for now, let's store null if no digits found
          valueToStore = extractedValue; // Store the parsed integer or null
          console.log(`[UpdateDetail] Parsed ${storeKey}:`, valueToStore);
        }

        session.data[storeKey] = valueToStore;
        session.data.detailToUpdate = null;
        session.state = 'admission_confirm';
        // Use the stored value (which might be null if parsing failed) for the confirmation message
        const displayValue = valueToStore !== null ? valueToStore : userMessage.trim(); 
        await sendMessage(userId, `Thank you! Your ${detailToUpdate} has been updated to ${displayValue}.`);
        await sendMessage(userId, getPromptForState(session.state, session.data));
      } else {
        await sendMessage(userId, validationRes);
        await sendMessage(userId, getPromptForState(session.state, session.data));
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
        // Ensure grade is passed as a string like "Grade X" to getAvailableSlots
        const gradeNumber = session.data.grade ? parseInt(session.data.grade, 10) : 4; // Default to 4 if not set
        const gradeForSlots = `Grade ${gradeNumber}`;
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
      const gradeForSlots = session.data.grade ? `Grade ${session.data.grade}` : 'Grade 4'; // Use correct format
      
      // 1. Get the list of available slot Date objects (using the consistent check)
      const availableSlotsObjects = await getAvailableSlots(gradeForSlots);

      if (isNaN(chosenNum) || chosenNum <= 0 || chosenNum > availableSlotsObjects.length) {
        // Invalid number selected
        await sendMessage(userId, 'Invalid slot number. Please choose one of the listed options.');
        // Re-show the list if needed, or just prompt again
        let slotMsg = 'Available slots:\n'; 
        const slotsList = availableSlotsObjects.map((s, i) => {
            const dateStr = s.slotDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
            const timeStr = s.slotDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });
            return `${i + 1}. ${dateStr}, ${timeStr}`;
        }).join('\n');
        slotMsg += `${slotsList}\nPlease choose a slot number:`;
        await sendMessage(userId, slotMsg); 
      } else {
        // Valid number selected
        // 2. Get the EXACT Date object chosen by the user
        const chosenSlotObject = availableSlotsObjects[chosenNum - 1]; 
        const appointmentDateTime = chosenSlotObject.slotDate; // THE Date object
        const phone = userId.split('@')[0];

        // 3. Check for existing appointment *just before* saving (optional but recommended)
        const existingAppointment = await checkExistingAppointment(phone); 
        if (existingAppointment) {
            session.data.pendingSlot = appointmentDateTime; // Store the chosen Date object
            session.data.existingAppointmentDate = existingAppointment.appdate;
            session.state = 'confirm_replace_appointment';
            userSessions.set(userId, session);
            const formattedExisting = new Date(existingAppointment.appdate).toLocaleString();
            const formattedNew = appointmentDateTime.toLocaleString();
            await sendMessage(userId, 
                `You already have an appointment scheduled for ${formattedExisting}. ` +
                `Do you want to replace it with the new slot on ${formattedNew}? (Yes/No)`
            );
            return; 
        }

        // 4. If no existing appointment, proceed to save using the exact Date object
        try {
          const success = await saveAppointment(
              session.data.studentId, 
              appointmentDateTime, // Pass the exact Date object
              'Admission Inquiry', // Purpose
              'Admission',         // Type
              session.data.grade   // ForGrade (already parsed as int)
          );

          if (success) {
            // Use the Date object for confirmation message
            const formattedBookedDate = appointmentDateTime.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
            const formattedBookedTime = appointmentDateTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });
            await sendMessage(userId, `Your meeting is scheduled for ${formattedBookedDate} at ${formattedBookedTime}.`);
            
            // Go back to neutral state
            session.state = 'awaiting_continue';
            delete session.data.slotsList; // Clean up temporary data
            userSessions.set(userId, session);
            await sendMessage(userId, getPromptForState(session.state, session.data)); // Ask "How can I help?"
          } else {
            await sendMessage(userId, 'Sorry, the selected slot might have just been taken or there was a problem scheduling your appointment. Please try again later.');
            // Consider going back to slot selection or ending
            userSessions.delete(userId); 
          }
        } catch (err) {
          console.error('Error in meeting_show_slots during save:', err.message);
          await sendMessage(userId, 'Sorry, there was an error scheduling your appointment. Please try again later.');
          userSessions.delete(userId);
        }
      }
      break;
    }
    case 'confirm_replace_appointment': {
        const yesNo = await aiService.interpretYesNo(userMessage);
        if (yesNo.toLowerCase() === 'yes') {
            // User wants to replace, proceed with saving the pending slot
            const chosenSlot = session.data.pendingSlot;
            const appointmentDateTime = new Date(`${chosenSlot.slot_date} ${chosenSlot.slot_time}`);
            try {
                // First, delete the old appointment (optional, depends on requirements)
                // For now, let's just overwrite by saving the new one
                // await deleteAppointment(session.data.studentId); // Need a delete function if required
                
                const success = await saveAppointment(
                    session.data.studentId, 
                    appointmentDateTime, 
                    'Admission Inquiry', // Purpose
                    'Admission',         // Type
                    session.data.grade   // ForGrade
                );

                if (success) {
                    await sendMessage(userId, `Okay, your previous appointment has been replaced. Your new meeting is scheduled for ${chosenSlot.slot_date} at ${chosenSlot.slot_time}.`);
                    
                    // Go back to neutral state
                    session.state = 'awaiting_continue';
                    delete session.data.pendingSlot;
                    delete session.data.existingAppointmentDate;
                    userSessions.set(userId, session);
                    await sendMessage(userId, getPromptForState(session.state, session.data)); // Ask "How can I help?"
                } else {
                    await sendMessage(userId, 'Sorry, there was a problem replacing your appointment. The slot might have been taken. Please try scheduling again.');
                    userSessions.delete(userId); 
                }
            } catch (err) {
                console.error('Error replacing appointment:', err.message);
                await sendMessage(userId, 'Sorry, there was an error replacing your appointment. Please try again later.');
                userSessions.delete(userId);
            }
        } else {
            // User does not want to replace
            await sendMessage(userId, 'Okay, the new appointment slot was not scheduled. Your existing appointment remains.');
            // Optionally, go back to slot selection or end the flow
            session.state = 'meeting_offer'; // Go back to asking if they want to schedule
            delete session.data.pendingSlot;
            delete session.data.existingAppointmentDate;
            userSessions.set(userId, session);
            await sendMessage(userId, getPromptForState(session.state, session.data));
        }
        break;
    }
    case 'awaiting_continue': {
      const intent = await aiService.determineIntent(userMessage, session.state);
      console.log(`Determined intent: ${intent} for user: ${userId}`);
      if (intent === 'AskFAQ') {
        const answer = await aiService.answerQuestion(userMessage, inputContent);
        await sendMessage(userId, answer || 'Could you please rephrase your question?');
        // Still in awaiting_continue state, ask again
        await sendMessage(userId, getPromptForState(session.state, session.data)); 
      } else if (intent === 'AdmissionFlow') {
        // --- Start: Replicate Database Check Logic from Main Handler --- 
        console.log(`[handleSession/awaiting_continue] Intent is AdmissionFlow for ${userId}. Starting checks...`);
        const phone = userId.split('@')[0];
        let studentId = null;
        session.data = {}; // Reset data within the current session for a fresh check

        // Find student_id
        try {
          const [contactRows] = await pool.query(
            'SELECT student_id FROM studentcontactinfo WHERE mobile = ? OR mobile2 = ? LIMIT 1',
            [phone, phone]
          );
          if (contactRows.length > 0) {
              studentId = contactRows[0].student_id;
              console.log(`[handleSession/awaiting_continue] Found student_id: ${studentId}`);
              session.data.studentId = studentId; // Add to current session data
          } else {
              console.log(`[handleSession/awaiting_continue] No student_id found for phone.`);
          }
        } catch (dbError) {
            console.error('[handleSession/awaiting_continue] DB error finding student_id:', dbError);
            studentId = null; // Ensure studentId is null on error
        }

        let promptToSend = null;
        let nextState = 'admission_displayname'; // Default next state

        if (studentId) {
            // Check Appointments
            let existingAppointments = [];
            try {
                console.log(`[handleSession/awaiting_continue] Checking appointments for student_id: ${studentId}`);
                existingAppointments = await getAllFutureAppointments(studentId);
                console.log(`[handleSession/awaiting_continue] Found ${existingAppointments.length} appointments.`);
            } catch (appError) {
                console.error(`[handleSession/awaiting_continue] Error calling getAllFutureAppointments for student_id ${studentId}:`, appError);
                existingAppointments = [];
            }

            if (existingAppointments && existingAppointments.length > 0) {
                let appointmentList = existingAppointments.map((app, index) =>
                    `${index + 1}. ${new Date(app.appdate).toLocaleString()}`
                ).join('\n');
                promptToSend = `I found the following upcoming appointment(s) scheduled for your number:\n${appointmentList}\n\nWould you like to book another appointment? (Yes/No)`;
                nextState = 'confirm_book_another_appointment';
                session.checkedExistingAppointment = true;
                session.data.existingAppointments = existingAppointments;
            } else {
                // No Appointments -> Check Data
                console.log(`[handleSession/awaiting_continue] Checking data for student_id: ${studentId}`);
                session.checkedExistingAppointment = true;
                const [existingDataRows] = await pool.query(
                    `SELECT s.displayname, s.grade, s.semester, s.referral, sci.email
                     FROM student s
                     JOIN studentcontactinfo sci ON s.id = sci.student_id
                     WHERE s.id = ? AND s.enrolled = 0 LIMIT 1`,
                    [studentId]
                );
                console.log(`[handleSession/awaiting_continue] Found ${existingDataRows.length} data rows.`);
                if (existingDataRows.length > 0) {
                    const data = existingDataRows[0];
                    // Update current session data with found details
                    session.data = {
                        ...session.data, // Keep studentId if already set
                        displayname: data.displayname,
                        email: data.email,
                        grade: data.grade ? parseInt(data.grade, 10) : null,
                        semester: data.semester ? parseInt(data.semester, 10) : null,
                        referral: data.referral || 'Unknown'
                    };
                    promptToSend =
                      `We found your information based on your phone number:\n` +
                      `- Name: ${session.data.displayname || 'N/A'}\n` +
                      `- Email: ${session.data.email || 'N/A'}\n` +
                      `- Grade: ${session.data.grade || 'N/A'}\n` +
                      `- Semester: ${session.data.semester || 'N/A'}\n` +
                      `- Referral: ${session.data.referral || 'N/A'}\n\n` +
                      `Would you like to use these details? (Reply "Yes" to use them, or "No" to fill out the form)`;
                    nextState = 'confirm_existing_data';
                    session.checkedExistingData = true;
                } else {
                    // No Appointments & No Data -> Start fresh form
                    console.log(`[handleSession/awaiting_continue] Starting fresh form for student_id: ${studentId}.`);
                    nextState = 'admission_displayname';
                    session.checkedExistingData = true;
                    session.checkedExistingAppointment = true;
                    // promptToSend will be generated below using getPromptForState
                }
            }
        } else {
            // No Student ID Found -> Start fresh form
            console.log(`[handleSession/awaiting_continue] No student_id found. Starting fresh form.`);
            nextState = 'admission_displayname';
            session.checkedExistingAppointment = true;
            session.checkedExistingData = true;
             // promptToSend will be generated below using getPromptForState
        }

        // Update session state and send the appropriate prompt
        session.state = nextState;
        if (!promptToSend) { // Generate default prompt if not set by specific cases above
            promptToSend = getPromptForState(session.state, session.data);
        }
        userSessions.set(userId, session);
        await sendMessage(userId, promptToSend);
        // --- End: Replicated Logic ---
      } else {
        // For other intents, check for basic user info.
        const userInfo = await getUserInfo(userId);
        if (userInfo) {
          await sendMessage(
            userId,
            `We found your info as a ${userInfo.role}:\n${JSON.stringify(userInfo.data, null, 2)}`
          );
          await sendMessage(userId, 'How can I help you today?');
          userSessions.delete(userId); // Clear the session
        } else {
          await sendMessage(userId, 'Hello! You can ask about admissions or any general question about the school.');
        }
      }
      break;
    }
    default: {
      const intent = await aiService.determineIntent(userMessage, session.state);
      console.log(`Determined intent: ${intent} for user: ${userId}`);
      const admissionStates = [
        'admission_displayname',
        'admission_email',
        'admission_grade',
        'admission_semester',
        'admission_referral',
        'admission_confirm',
        'admission_choose_detail_to_change',
        'update_detail'
      ];
      if (intent === 'AdmissionFlow' && admissionStates.includes(session.state)) {
        await sendMessage(userId, getPromptForState(session.state, session.data));
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
        await sendMessage(userId, 'How can I help you today?');
      } else {
        // For other intents, check for basic user info.
        const userInfo = await getUserInfo(userId);
        if (userInfo) {
          await sendMessage(
            userId,
            `We found your info as a ${userInfo.role}:\n${JSON.stringify(userInfo.data, null, 2)}`
          );
          await sendMessage(userId, 'How can I help you today?');
          userSessions.delete(userId); // Clear the session
        } else {
          await sendMessage(userId, 'Hello! You can ask about admissions or any general question about the school.');
        }
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

    let session = userSessions.get(userId);
    const intent = await aiService.determineIntent(userMessage, session ? session.state : '');
    console.log(`Determined intent: ${intent} for user: ${userId}`);

    // --- Start: Revised Logic ---

    // PRIORITY 1: Handle ACTIVE session
    if (session && session.state) {
        console.log(`[MessageHandler] Active session found for ${userId} in state: ${session.state}. Handling...`);
        // Let handleSession manage the current state, including 'awaiting_continue' + 'AskFAQ'
        await handleSession(userId, userMessage, session); 
        return; // Stop processing here after handling the active session
    }

    // PRIORITY 2: Start NEW Admission Flow if requested and NO active session
    if (intent === 'AdmissionFlow') {
        console.log(`[MessageHandler] Intent is AdmissionFlow, NO active session for ${userId}. Starting checks...`);
        const phone = userId.split('@')[0];
        // session = userSessions.get(userId); // No need to get session again, we know it's null/inactive here
        
        // The logic below assumes no active session exists, which is correct at this point.
        // if (!session || !session.state.startsWith('admission_')) { // This check is redundant now
        console.log(`[MessageHandler] Starting NEW AdmissionFlow checks for ${userId}`);
        let newSession = { state: 'admission_displayname', data: {} }; 
        let studentId = null;

        // --- Find student_id from phone number --- 
        try {
          const [contactRows] = await pool.query(
            'SELECT student_id FROM studentcontactinfo WHERE mobile = ? OR mobile2 = ? LIMIT 1',
            [phone, phone]
          );
          if (contactRows.length > 0) {
              studentId = contactRows[0].student_id;
              console.log(`[MessageHandler] Found student_id: ${studentId}`);
              newSession.data.studentId = studentId;
          } else {
              console.log(`[MessageHandler] No student_id found for phone.`);
          }
        } catch (dbError) {
            console.error('[MessageHandler] DB error finding student_id:', dbError);
            studentId = null;
        }

        let promptToSend = null; // Variable to hold the message to send

        if (studentId) {
            newSession.data.studentId = studentId; 

            // 1. Check Appointments
            let existingAppointments = [];
            try {
                console.log(`[MessageHandler] Checking appointments for student_id: ${studentId}`);
                existingAppointments = await getAllFutureAppointments(studentId); 
                console.log(`[MessageHandler] Found ${existingAppointments.length} appointments.`);
            } catch (appError) {
                console.error(`[MessageHandler] Error calling getAllFutureAppointments for student_id ${studentId}:`, appError);
                existingAppointments = []; // Treat as no appointments found on error
            }
            
            if (existingAppointments && existingAppointments.length > 0) {
                // Appointments Found -> Ask to book another
                let appointmentList = existingAppointments.map((app, index) => 
                    `${index + 1}. ${new Date(app.appdate).toLocaleString()}` // Use appdate which is DATETIME
                ).join('\n');
                promptToSend = `I found the following upcoming appointment(s) scheduled for your number:\n${appointmentList}\n\nWould you like to book another appointment? (Yes/No)`;
                newSession.state = 'confirm_book_another_appointment'; 
                newSession.checkedExistingAppointment = true; 
                newSession.data.existingAppointments = existingAppointments; 
            } else {
                // 2. No Appointments -> Check Data
                console.log(`[MessageHandler] Checking data for student_id: ${studentId}`);
                newSession.checkedExistingAppointment = true; 
                const [existingDataRows] = await pool.query(
                    `SELECT s.displayname, s.grade, s.semester, s.referral, sci.email 
                     FROM student s 
                     JOIN studentcontactinfo sci ON s.id = sci.student_id
                     WHERE s.id = ? AND s.enrolled = 0 LIMIT 1`, // Ensure only one row
                    [studentId]
                );
                console.log(`[MessageHandler] Found ${existingDataRows.length} data rows.`);
                if (existingDataRows.length > 0) {
                    // Data Found -> Format message and ask to use data
                    const data = existingDataRows[0];
                    newSession.data = { 
                        studentId: studentId,
                        displayname: data.displayname,
                        email: data.email,
                        grade: data.grade ? parseInt(data.grade, 10) : null,
                        semester: data.semester ? parseInt(data.semester, 10) : null,
                        referral: data.referral || 'Unknown'
                    };
                    promptToSend = 
                      `We found your information based on your phone number:\n` +
                      `- Name: ${newSession.data.displayname || 'N/A'}\n` +
                      `- Email: ${newSession.data.email || 'N/A'}\n` +
                      `- Grade: ${newSession.data.grade || 'N/A'}\n` +
                      `- Semester: ${newSession.data.semester || 'N/A'}\n` +
                      `- Referral: ${newSession.data.referral || 'N/A'}\n\n` +
                      `Would you like to use these details? (Reply "Yes" to use them, or "No" to fill out the form)`;
                    newSession.state = 'confirm_existing_data';
                    newSession.checkedExistingData = true;
                } else {
                    // No Appointments & No Data -> Start fresh form
                    console.log(`[MessageHandler] Starting fresh form for student_id: ${studentId}.`);
                    newSession.state = 'admission_displayname';
                    newSession.checkedExistingData = true;
                    newSession.checkedExistingAppointment = true; 
                    promptToSend = getPromptForState(newSession.state, newSession.data);
                }
            }
        } else {
            // No Student ID Found -> Start fresh form
            console.log(`[MessageHandler] No student_id found. Starting fresh form.`);
            newSession.checkedExistingAppointment = true;
            newSession.checkedExistingData = true;
            newSession.state = 'admission_displayname';
            promptToSend = getPromptForState(newSession.state, newSession.data);
        }
        
        // Store the session and send the determined initial prompt
        userSessions.set(userId, newSession); 
        if (promptToSend) {
            await sendMessage(userId, promptToSend);
        } else {
            // Fallback safety - should not happen with current logic
            console.error("[MessageHandler] Error: promptToSend was not set!");
            await sendMessage(userId, "Sorry, something went wrong. Please try again.");
        }
        return; // IMPORTANT: Stop processing here
        // } // End of the removed redundant check
        // If there *was* an active session, fall through logic is removed because PRIORITY 1 handles active sessions now.
    }

    // PRIORITY 3: Handle AskFAQ if NO active session
    if (intent === 'AskFAQ') { // This condition implies !session || !session.state
        console.log(`[MessageHandler] Handling AskFAQ for user without session: ${userId}`);
        const answer = await aiService.answerQuestion(userMessage, inputContent);
        await sendMessage(userId, answer || 'Could you please rephrase your question?');
        // Optionally, set awaiting_continue state if you want to track it after the FAQ answer
        // session = { state: 'awaiting_continue', data: {} }; 
        // userSessions.set(userId, session);
        // await sendMessage(userId, "How can I help you further?"); // Optional follow-up
        return; // Stop processing here
    }
    
    // PRIORITY 4: Fallback for NO active session and OTHER intents
    console.log(`[MessageHandler] Fallback: NO active session for ${userId}, intent: ${intent}.`);
    const userInfo = await getUserInfo(userId);
    if (userInfo) {
        // Consider if showing user info here is appropriate. Sending a simple greeting might be better.
        // await sendMessage(userId, `We found your info as a ${userInfo.role}:\\n${JSON.stringify(userInfo.data, null, 2)}`);
        await sendMessage(userId, `Hello! Welcome back.`); // Use a generic greeting
    } else {
        await sendMessage(userId, 'Hello! You can ask about admissions or any general question about the school.');
    }
    await sendMessage(userId, 'How can I help you today?');
    // No session to delete, as none was active/relevant here.
    
    // --- End: Revised Logic --- 

  } catch (err) {
    console.error('Error handling message:', err.message);
    // Maybe send a generic error message to the user?
    // await sendMessage(userId, 'Sorry, something went wrong. Please try again later.');
  }
});

module.exports = {};

