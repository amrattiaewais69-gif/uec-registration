const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.get('/dashboard', authMiddleware(['admin']), async (req, res) => {
  try {
    const { rows: users } = await db.query('SELECT * FROM users WHERE username = $1 AND role = $2', [req.user.token, 'admin']);
    if (users.length === 0) return res.json({ success: false, message: 'Access Denied.' });

    const { rows: enrolled } = await db.query("SELECT COUNT(DISTINCT student_id)::int as cnt FROM requests WHERE status = 'Registered Successfully'");
    const { rows: pendingA } = await db.query("SELECT COUNT(*)::int as cnt FROM requests WHERE status = 'Submitted'");
    const { rows: pendingP } = await db.query("SELECT COUNT(*)::int as cnt FROM requests WHERE status IN ('Approved by Supervisor', 'Pending Payment', 'Partially Paid')");

    const { rows: revRows } = await db.query(`
      SELECT COALESCE(SUM(r.total_fees), 0)::numeric as total_fees,
             COALESCE((SELECT SUM(p.amount_paid) FROM payments p
               JOIN requests r2 ON p.request_id = r2.request_id
               WHERE r2.status = 'Registered Successfully' AND p.status = 'Settlement/Discount'), 0)::numeric as total_discounts
      FROM requests r WHERE r.status = 'Registered Successfully'
    `);
    const totalRevenue = Number(revRows[0].total_fees) - Number(revRows[0].total_discounts);

    const { rows: courses } = await db.query('SELECT * FROM courses WHERE is_active = TRUE');

    const { rows: allSel } = await db.query(`
      SELECT cs.course_code FROM course_selections cs
      JOIN requests r ON cs.request_id = r.request_id
      WHERE r.status NOT IN ('Rejected', 'Returned for Modification')
    `);

    const occupancyMap = {};
    courses.forEach(c => { occupancyMap[c.course_code] = 0; });
    allSel.forEach(sel => {
      if (occupancyMap[sel.course_code] !== undefined) occupancyMap[sel.course_code]++;
    });

    const courseStats = courses.map(c => {
      const allocated = occupancyMap[c.course_code] || 0;
      const max = Number(c.max_seats) || 1;
      return { code: c.course_code, name: c.course_name, allocated, max, percentage: ((allocated / max) * 100).toFixed(1) + '%' };
    });

    return res.json({
      success: true,
      metrics: {
        registeredStudents: enrolled[0].cnt,
        pendingApprovals: pendingA[0].cnt,
        pendingPayments: pendingP[0].cnt,
        totalRevenue: totalRevenue
      },
      courseStats
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.get('/export/:type', authMiddleware(['admin']), async (req, res) => {
  try {
    const type = req.params.type;
    let statusFilter = [];
    if (type === 'paid') statusFilter = ['Registered Successfully'];
    else if (type === 'pending') statusFilter = ['Submitted'];
    else if (type === 'unpaid') statusFilter = ['Approved by Supervisor', 'Pending Payment', 'Partially Paid'];
    else return res.json({ success: false, message: 'Invalid type.' });

    const { rows: requests } = await db.query(`
      SELECT r.*, s.name as student_name, s.faculty, sup.name as supervisor_name
      FROM requests r
      LEFT JOIN students s ON r.student_id = s.student_id
      LEFT JOIN supervisors sup ON s.supervisor_id = sup.supervisor_id
      WHERE r.status = ANY($1)
    `, [statusFilter]);

    const { rows: allSel } = await db.query(`
      SELECT cs.request_id, c.course_name FROM course_selections cs
      JOIN courses c ON cs.course_code = c.course_code
    `);

    const { rows: allPayments } = await db.query(`SELECT * FROM payments`);

    let csv = '\uFEFFStudent ID,Student Name,Faculty,Supervisor,Total Fees,Paid Amount,Discount Amount,Discount Approver,Status,Courses\n';
    requests.forEach(r => {
      const courses = allSel.filter(s => s.request_id === r.request_id).map(s => s.course_name).join(' - ');
      const reqPayments = allPayments.filter(p => String(p.request_id) === String(r.request_id));
      let paid = 0, disc = 0, approvers = [];
      reqPayments.forEach(p => {
        const a = parseFloat(p.amount_paid) || 0;
        if (p.status === 'Settlement/Discount' || p.payment_method === 'Discount') {
          disc += a;
          const ref = p.reference_number || '';
          const match = ref.match(/Discount\s+\d+%?\s*-\s*(.+)/i);
          if (match) approvers.push(match[1].trim());
        } else {
          paid += a;
        }
      });
      csv += `${r.student_id},${r.student_name || 'Unknown'},${r.faculty || 'General'},${r.supervisor_name || 'N/A'},${r.total_fees},${paid},${disc},"${approvers.join('; ')}",${r.status},"${courses}"\n`;
    });

    return res.json({ csvData: csv });
  } catch (error) {
    console.error('Export error:', error);
    return res.json({ success: false, message: 'Export failed.' });
  }
});

router.get('/students', authMiddleware(['admin']), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT student_id, name, email, faculty, academic_level, supervisor_id, photo_url FROM students ORDER BY student_id');
    return res.json({ success: true, students: rows });
  } catch (error) {
    console.error('Admin students error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.get('/supervisors', authMiddleware(['admin']), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT supervisor_id, name, email FROM supervisors ORDER BY supervisor_id');
    return res.json({ success: true, supervisors: rows });
  } catch (error) {
    console.error('Admin supervisors error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/resetPassword', authMiddleware(['admin']), async (req, res) => {
  try {
    const { userId, role, newPassword } = req.body;
    if (!userId || !role || !newPassword) {
      return res.json({ success: false, message: 'All fields required.' });
    }
    if (newPassword.length < 6) {
      return res.json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    let table, idColumn;
    if (role === 'student') { table = 'students'; idColumn = 'student_id'; }
    else if (role === 'supervisor') { table = 'supervisors'; idColumn = 'supervisor_id'; }
    else { return res.json({ success: false, message: 'Invalid role.' }); }

    const { rows } = await db.query(`SELECT * FROM ${table} WHERE ${idColumn} = $1`, [userId]);
    if (rows.length === 0) return res.json({ success: false, message: 'User not found.' });

    const hash = await bcrypt.hash(newPassword, 12);
    await db.query(`UPDATE ${table} SET password_hash = $1 WHERE ${idColumn} = $2`, [hash, userId]);

    return res.json({ success: true, message: `Password reset for ${role} ${userId}.` });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/setPhoto', authMiddleware(['admin']), async (req, res) => {
  try {
    const { studentId, photoUrl } = req.body;
    if (!studentId) return res.json({ success: false, message: 'Student ID required.' });
    await db.query('UPDATE students SET photo_url = $1 WHERE student_id = $2', [photoUrl || null, studentId]);
    return res.json({ success: true, message: 'Photo updated.' });
  } catch (error) {
    console.error('Set photo error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
