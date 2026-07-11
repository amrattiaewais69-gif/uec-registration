const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');
const { logAction } = require('./auth');

const router = express.Router();

router.get('/dashboard', authMiddleware(['supervisor']), async (req, res) => {
  try {
    const supervisorId = req.user.token;

    const { rows: sups } = await db.query('SELECT * FROM supervisors WHERE supervisor_id = $1', [supervisorId]);
    if (sups.length === 0) return res.json({ success: false, message: 'Access Denied.' });
    const supervisor = sups[0];

    const { rows: assignedStudents } = await db.query('SELECT * FROM students WHERE supervisor_id = $1', [supervisorId]);
    if (assignedStudents.length === 0) return res.json({ success: true, supervisorName: supervisor.name, requests: [] });

    const studentIds = assignedStudents.map(s => s.student_id);

    const { rows: requests } = await db.query(`
      SELECT r.*, s.name as student_name, s.academic_level, s.email as student_email
      FROM requests r JOIN students s ON r.student_id = s.student_id
      WHERE r.student_id = ANY($1)
    `, [studentIds]);

    const { rows: allSelections } = await db.query(`
      SELECT cs.*, c.course_name FROM course_selections cs
      JOIN courses c ON cs.course_code = c.course_code
    `);

    const { rows: allFailed } = await db.query(`
      SELECT fc.*, c.course_name FROM failed_courses fc
      JOIN courses c ON fc.course_code = c.course_code
    `);

    const detailedRequests = requests.map(r => {
      const selCourses = allSelections
        .filter(sel => sel.request_id === r.request_id)
        .map(sel => `${sel.course_name} (${sel.course_code})`);

      const failedList = allFailed
        .filter(f => f.student_id === r.student_id)
        .map(f => `${f.course_name} (${f.course_code})`);

      return {
        requestId: r.request_id, studentId: r.student_id, studentName: r.student_name,
        level: r.academic_level, studentEmail: r.student_email,
        totalCredits: r.total_credits, totalFees: Number(r.total_fees),
        status: r.status, comments: r.supervisor_comments,
        courses: selCourses.join('<br>'),
        failedCourses: failedList.length > 0 ? failedList.join('<br>') : 'None'
      };
    });

    return res.json({ success: true, supervisorName: supervisor.name, requests: detailedRequests });
  } catch (error) {
    console.error('Supervisor dashboard error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/processAction', authMiddleware(['supervisor']), async (req, res) => {
  try {
    const { requestId, action, comments, email } = req.body;
    if (!requestId || !action) return res.json({ success: false, message: 'Request ID and action required.' });

    const { rows } = await db.query('SELECT * FROM requests WHERE request_id = $1', [requestId]);
    if (rows.length === 0) return res.json({ success: false, message: 'Request not found.' });

    let nextStatus = '';
    if (action === 'Approve') nextStatus = 'Approved by Supervisor';
    else if (action === 'Reject') nextStatus = 'Rejected';
    else if (action === 'Return') nextStatus = 'Returned for Modification';
    else return res.json({ success: false, message: 'Invalid action.' });

    await db.query('UPDATE requests SET status = $1, supervisor_comments = $2 WHERE request_id = $3', [nextStatus, comments || null, requestId]);
    await db.query(
      'INSERT INTO approval_history (history_id, request_id, actor_email, actor_role, action, comments) VALUES ($1, $2, $3, $4, $5, $6)',
      [uuidv4(), requestId, email, 'Supervisor', action, comments]
    );
    await logAction(email, 'Supervisor status -> ' + nextStatus);

    return res.json({ success: true, message: 'Application updated.' });
  } catch (error) {
    console.error('Supervisor action error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
