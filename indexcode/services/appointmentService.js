// services/appointmentService.js
const pool = require('../config/db');

// Helper function to format JS Date to MySQL DATETIME string
function formatDateTimeMySql(date) {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0'); // JS months are 0-indexed
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    // Returns string in 'YYYY-MM-DD HH:MM:SS' format
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Return all booked times from the DB within the next 2 days.
 */
async function getBookedSlots() {
    const twoWeeksFromNow = new Date();
    twoWeeksFromNow.setDate(twoWeeksFromNow.getDate() + 2);

    try {
        const [rows] = await pool.query(
            `SELECT appdate
               FROM appointments
               WHERE appdate >= NOW()
                 AND appdate < ?`, [twoWeeksFromNow]
        );
        return rows.map(r => new Date(r.appdate));
    } catch (error) {
        console.error('Error retrieving booked slots:', error.message);
        return [];
    }
}

/**
 * Generate half-hour increments from 8:00 AM to 3:00 PM, Sunday–Thursday, for the next 14 days.
 * Exclude booked slots so the user only sees truly available times.
 * "Section 1" for Grade <= 3, "Section 2" otherwise.
 */
async function getAvailableSlots(grade = 'Grade 4') {
    const now = new Date();

    // Define start and end dates (e.g., tomorrow for 3 days)
    const startDate = new Date();
    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 3);
    endDate.setHours(23, 59, 59, 999); // Ensure we cover the whole end day

    // Optional: Determine section based on grade (used internally if needed,
    // but we won't return it to the user.)
    let numericGrade = 4;
    const match = grade.match(/(\d+)/);
    if (match) numericGrade = parseInt(match[1], 10);
    // Section calculation is kept (if you use it elsewhere in your code)
    const section = numericGrade <= 3 ? 'Section 1' : 'Section 2';

    const possibleSlots = [];
    let current = new Date(startDate);
    current.setHours(0, 0, 0, 0); 

    while (current < endDate) { 
        const dayOfWeek = current.getDay(); 
        if (dayOfWeek >= 0 && dayOfWeek <= 4) { // Sunday to Thursday
            for (let hour = 8; hour < 15; hour++) { 
                for (let minute = 0; minute < 60; minute += 30) { 
                    const slotDate = new Date(
                        current.getFullYear(),
                        current.getMonth(),
                        current.getDate(),
                        hour,
                        minute,
                        0
                    );

                    if (slotDate > now) { 
                        // *** Direct check for each slot using formatted string ***
                        let isSlotBooked = true; 
                        const formattedSlotDate = formatDateTimeMySql(slotDate); // Format the date
                        try {
                            const [existing] = await pool.query(
                                'SELECT COUNT(*) AS cnt FROM appointments WHERE appdate = ?', 
                                [formattedSlotDate] // Use the formatted string here
                            );
                            if (existing[0].cnt === 0) {
                                isSlotBooked = false;
                            }
                        } catch (checkError) {
                            console.error(`[getAvailableSlots] Error checking individual slot ${formattedSlotDate}:`, checkError.message);
                            isSlotBooked = true; 
                        }
                        
                        if (!isSlotBooked) {
                            possibleSlots.push({ slotDate }); // Still push the Date object
                        }
                        // *** End direct check ***
                    }
                }
            }
        }
        current.setDate(current.getDate() + 1);
    }

    console.log(`[getAvailableSlots] Generated ${possibleSlots.length} available slots after individual checks.`);
    return possibleSlots;
}


/**
 * Attempt to save an appointment for studentId at slotDatetime, if free.
 */
async function saveAppointment(studentId, slotDatetime, purpose = 'Admission Inquiry', type = 'Admission', forgrade = null) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Format the incoming JS Date object for MySQL comparison
        const formattedSlotTime = formatDateTimeMySql(slotDatetime);
        
        // Check if the slot is still available using the formatted string
        // Widen check slightly to account for potential minor time discrepancies
        const slotTimeMinus1Sec = new Date(slotDatetime.getTime() - 1000);
        const slotTimePlus1Sec = new Date(slotDatetime.getTime() + 1000);
        const formattedMinus1Sec = formatDateTimeMySql(slotTimeMinus1Sec);
        const formattedPlus1Sec = formatDateTimeMySql(slotTimePlus1Sec);

        console.log(`[saveAppointment] Checking availability for slot between ${formattedMinus1Sec} and ${formattedPlus1Sec}`); 
        const [existing] = await connection.query(
            'SELECT COUNT(*) AS cnt FROM appointments WHERE appdate >= ? AND appdate <= ?', 
            [formattedMinus1Sec, formattedPlus1Sec] // Check a small window
        );
        console.log(`[saveAppointment] Found ${existing[0].cnt} existing appointments within the ~2s window.`);
        
        if (existing[0].cnt > 0) {
            console.log(`[saveAppointment] Slot around ${formattedSlotTime} already booked. Rolling back.`); 
            await connection.rollback();
            return false; // Slot already taken
        }

        // Generate a new ID for the appointment
        const [idRows] = await connection.query('SELECT MAX(id) AS maxId FROM appointments FOR UPDATE');
        const newAppointmentId = (idRows[0].maxId || 0) + 1;

        // Insert appointment including type and forgrade
        await connection.query(
            `INSERT INTO appointments (id, student_id, appdate, time, purpose, host, type, forgrade) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, // Added placeholders
             [newAppointmentId, studentId, formattedSlotTime, formattedSlotTime, purpose, 'IvyBot', type, forgrade] // Added values
        );

        await connection.commit();
        console.log(`[saveAppointment] Successfully booked slot: ${formattedSlotTime} for student: ${studentId}`);
        return true;
    } catch (error) {
        await connection.rollback();
        console.error(`[saveAppointment] Error saving appointment for slot ${formatDateTimeMySql(slotDatetime)}:`, error.message);
        return false;
    } finally {
        connection.release();
    }
}

/**
 * Check if the user already has an upcoming appointment.
 */
async function checkExistingAppointment(studentId) {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM appointments WHERE student_id = ? AND appdate >= NOW() ORDER BY appdate ASC LIMIT 1', [studentId]
        );
        return rows.length ? rows[0] : null;
    } catch (error) {
        console.error('Error checking appointment:', error.message);
        return null;
    }
}

/**
 * Get ALL future appointments for a given student ID.
 */
async function getAllFutureAppointments(studentId) {
    console.log(`[getAllFutureAppointments] Checking for student_id: ${studentId}`); // Log input
    try {
        const [rows] = await pool.query(
            'SELECT * FROM appointments WHERE student_id = ? AND appdate >= NOW() ORDER BY appdate ASC', [studentId]
        );
        console.log(`[getAllFutureAppointments] Query found ${rows.length} rows for student_id: ${studentId}`); // Log result count
        return rows; 
    } catch (error) {
        console.error(`[getAllFutureAppointments] Error checking all future appointments for student_id ${studentId}:`, error.message);
        return []; 
    }
}

module.exports = {
    getAvailableSlots,
    saveAppointment,
    checkExistingAppointment,
    getAllFutureAppointments // Export the new function
};