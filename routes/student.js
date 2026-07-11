const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');
const { logAction } = require('./auth');

const router = express.Router();

router.get('/dashboard', authMiddleware(['student']), async (req, res) => {
  try {
    const studentId = req.user.token;

    const { rows: students } = await db.query('SELECT * FROM students WHERE student_id = $1', [studentId]);
    if (students.length === 0) return res.json({ success: false, message: 'Student not found.' });
    const student = students[0];

    const { rows: sups } = await db.query('SELECT * FROM supervisors WHERE supervisor_id = $1', [student.supervisor_id]);
    const supervisor = sups[0];

    const { rows: courses } = await db.query(
      'SELECT * FROM courses WHERE LOWER(faculty) = LOWER($1) AND is_active = TRUE',
      [student.faculty || '']
    );

    const { rows: failedRows } = await db.query('SELECT course_code FROM failed_courses WHERE student_id = $1', [studentId]);
    const failedCourseCodes = failedRows.map(r => r.course_code);

    const { rows: selections } = await db.query(`
      SELECT cs.course_code FROM course_selections cs
      JOIN requests r ON cs.request_id = r.request_id
      WHERE r.status NOT IN ('Rejected', 'Returned for Modification')
    `);

    const occupancyMap = {};
    courses.forEach(c => { occupancyMap[c.course_code] = 0; });
    selections.forEach(sel => {
      if (occupancyMap[sel.course_code] !== undefined) occupancyMap[sel.course_code]++;
    });

    const availableCourses = courses
      .filter(c => failedCourseCodes.includes(c.course_code))
      .map(c => ({
        courseCode: c.course_code,
        courseName: c.course_name,
        creditHours: Number(c.credit_hours),
        maxSeats: Number(c.max_seats),
        availableSeats: Number(c.max_seats) - (occupancyMap[c.course_code] || 0),
        feePerCredit: Number(c.fee_per_credit)
      }));

    const { rows: requests } = await db.query('SELECT * FROM requests WHERE student_id = $1', [studentId]);
    const studentRequest = requests[0] || null;

    let currentSelection = [];
    if (studentRequest) {
      const { rows: sels } = await db.query('SELECT course_code FROM course_selections WHERE request_id = $1', [studentRequest.request_id]);
      currentSelection = sels.map(s => s.course_code);
    }

    return res.json({
      success: true,
      studentInfo: {
        id: student.student_id, name: student.name, level: student.academic_level,
        supervisorName: supervisor ? supervisor.name : 'N/A', faculty: student.faculty || '---'
      },
      courses: availableCourses,
      currentRequest: studentRequest
        ? { requestId: studentRequest.request_id, status: studentRequest.status,
            comments: studentRequest.supervisor_comments,
            totalCredits: studentRequest.total_credits, totalFees: Number(studentRequest.total_fees) }
        : { status: 'Draft', totalCredits: 0, totalFees: 0 },
      selectedCourses: currentSelection
    });
  } catch (error) {
    console.error('Student dashboard error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/submitRegistration', authMiddleware(['student']), async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { studentId, email, courses: courseCodes } = req.body;
    const sessionToken = req.user.token;

    if (!courseCodes || courseCodes.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'No courses selected.' });
    }

    let totalCredits = 0;
    let totalFees = 0;
    for (const code of courseCodes) {
      const { rows } = await client.query('SELECT * FROM courses WHERE course_code = $1', [code]);
      if (rows.length === 0) { await client.query('ROLLBACK'); return res.json({ success: false, message: 'Invalid Course: ' + code }); }
      totalCredits += Number(rows[0].credit_hours);
      totalFees += Number(rows[0].credit_hours) * Number(rows[0].fee_per_credit);
    }

    const maxCredits = parseInt(process.env.MAX_CREDIT_HOURS) || 10;
    if (totalCredits > maxCredits) { await client.query('ROLLBACK'); return res.json({ success: false, message: `Max ${maxCredits} Credit Hours allowed.` }); }

    // Check seats
    for (const code of courseCodes) {
      const { rows: cRows } = await client.query('SELECT * FROM courses WHERE course_code = $1', [code]);
      const c = cRows[0];

      const { rows: occRows } = await client.query(`
        SELECT COUNT(*)::int as cnt FROM course_selections cs
        JOIN requests r ON cs.request_id = r.request_id
        WHERE cs.course_code = $1 AND r.status NOT IN ('Rejected', 'Returned for Modification')
      `, [code]);
      const occupied = occRows[0].cnt;

      const { rows: exReq } = await client.query('SELECT request_id FROM requests WHERE student_id = $1', [sessionToken]);
      let alreadySelected = false;
      if (exReq.length > 0) {
        const { rows: exSel } = await client.query(
          'SELECT id FROM course_selections WHERE request_id = $1 AND course_code = $2',
          [exReq[0].request_id, code]
        );
        alreadySelected = exSel.length > 0;
      }

      if (!alreadySelected && occupied >= Number(c.max_seats)) {
        await client.query('ROLLBACK');
        return res.json({ success: false, message: `Course (${c.course_name}) is full.` });
      }
    }

    // Find or create request
    const { rows: existingReqs } = await client.query('SELECT * FROM requests WHERE student_id = $1', [sessionToken]);
    let requestId;

    if (existingReqs.length > 0) {
      requestId = existingReqs[0].request_id;
      await client.query('DELETE FROM course_selections WHERE request_id = $1', [requestId]);
      await client.query(
        'UPDATE requests SET total_credits = $1, total_fees = $2, status = $3, supervisor_comments = NULL, reference_number = NULL, payment_date = NULL WHERE request_id = $4',
        [totalCredits, totalFees, 'Submitted', requestId]
      );
    } else {
      requestId = uuidv4();
      await client.query(
        'INSERT INTO requests (request_id, student_id, total_credits, total_fees, status) VALUES ($1, $2, $3, $4, $5)',
        [requestId, sessionToken, totalCredits, totalFees, 'Submitted']
      );
    }

    for (const code of courseCodes) {
      await client.query(
        'INSERT INTO course_selections (selection_id, request_id, student_id, course_code) VALUES ($1, $2, $3, $4)',
        [uuidv4(), requestId, sessionToken, code]
      );
    }

    await client.query(
      'INSERT INTO approval_history (history_id, request_id, actor_email, actor_role, action, comments) VALUES ($1, $2, $3, $4, $5, $6)',
      [uuidv4(), requestId, email, 'Student', 'Submit', 'Registration finalized by Student.']
    );

    await client.query('COMMIT');
    await logAction(email, 'Submitted registration for Request: ' + requestId);
    return res.json({ success: true, message: 'Application sent to your advisor.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Submit error:', error);
    return res.json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

module.exports = router;
