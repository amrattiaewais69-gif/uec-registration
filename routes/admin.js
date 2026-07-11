const express = require('express');
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
    const { rows: revRows } = await db.query("SELECT COALESCE(SUM(total_fees), 0)::numeric as total FROM requests WHERE status = 'Registered Successfully'");

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
        totalRevenue: Number(revRows[0].total)
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

    let csv = '\uFEFFStudent ID,Student Name,Faculty,Supervisor,Total Fees,Status,Courses\n';
    requests.forEach(r => {
      const courses = allSel.filter(s => s.request_id === r.request_id).map(s => s.course_name).join(' - ');
      csv += `${r.student_id},${r.student_name || 'Unknown'},${r.faculty || 'General'},${r.supervisor_name || 'N/A'},${r.total_fees},${r.status},"${courses}"\n`;
    });

    return res.json({ csvData: csv });
  } catch (error) {
    console.error('Export error:', error);
    return res.json({ success: false, message: 'Export failed.' });
  }
});

module.exports = router;
