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
      return { code: c.course_code, name: c.course_name, allocated, max, percentage: ((allocated / max) * 100).toFixed(1) + '%', creditHours: Number(c.credit_hours), feePerCredit: Number(c.fee_per_credit), faculty: c.faculty };
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
    else if (role === 'finance' || role === 'admin') { table = 'users'; idColumn = 'username'; }
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

router.post('/addStudent', authMiddleware(['admin']), async (req, res) => {
  try {
    const { studentId, name, email, faculty, academicLevel, supervisorId } = req.body;
    if (!studentId || !name) {
      return res.json({ success: false, message: 'Student ID and Name are required.' });
    }
    const { rows: existing } = await db.query('SELECT student_id FROM students WHERE student_id = $1', [studentId]);
    if (existing.length > 0) {
      return res.json({ success: false, message: 'Student ID already exists.' });
    }
    const hash = await bcrypt.hash(studentId, 12);
    await db.query(
      'INSERT INTO students (student_id, name, email, password_hash, faculty, academic_level, supervisor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [studentId, name, email || null, hash, faculty || 'General', academicLevel || null, supervisorId || null]
    );
    return res.json({ success: true, message: `Student ${studentId} added. Password: ${studentId}` });
  } catch (error) {
    console.error('Add student error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/addSupervisor', authMiddleware(['admin']), async (req, res) => {
  try {
    const { supervisorId, name, email } = req.body;
    if (!supervisorId || !name) {
      return res.json({ success: false, message: 'Supervisor ID and Name are required.' });
    }
    const { rows: existing } = await db.query('SELECT supervisor_id FROM supervisors WHERE supervisor_id = $1', [supervisorId]);
    if (existing.length > 0) {
      return res.json({ success: false, message: 'Supervisor ID already exists.' });
    }
    const hash = await bcrypt.hash(supervisorId, 12);
    await db.query(
      'INSERT INTO supervisors (supervisor_id, name, email, password_hash) VALUES ($1, $2, $3, $4)',
      [supervisorId, name, email || null, hash]
    );
    return res.json({ success: true, message: `Supervisor ${supervisorId} added. Password: ${supervisorId}` });
  } catch (error) {
    console.error('Add supervisor error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.get('/users', authMiddleware(['admin']), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT username, email, role FROM users ORDER BY role, username');
    return res.json({ success: true, users: rows });
  } catch (error) {
    console.error('Admin users error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/addUser', authMiddleware(['admin']), async (req, res) => {
  try {
    const { username, email, role } = req.body;
    if (!username || !role) {
      return res.json({ success: false, message: 'Username and Role are required.' });
    }
    if (!['admin', 'finance'].includes(role)) {
      return res.json({ success: false, message: 'Role must be admin or finance.' });
    }
    const { rows: existing } = await db.query('SELECT username FROM users WHERE username = $1', [username]);
    if (existing.length > 0) {
      return res.json({ success: false, message: 'Username already exists.' });
    }
    const hash = await bcrypt.hash(username, 12);
    await db.query(
      'INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [username, email || null, hash, role]
    );
    return res.json({ success: true, message: `User ${username} (${role}) added. Password: ${username}` });
  } catch (error) {
    console.error('Add user error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/bulkFailedCourses', authMiddleware(['admin']), async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || !Array.isArray(data) || data.length === 0) {
      return res.json({ success: false, message: 'No data provided.' });
    }
    let inserted = 0, skipped = 0;
    for (const row of data) {
      const studentId = (row.studentId || '').trim();
      const courseCode = (row.courseCode || '').trim();
      if (!studentId || !courseCode) { skipped++; continue; }
      try {
        await db.query(
          'INSERT INTO failed_courses (student_id, course_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [studentId, courseCode]
        );
        inserted++;
      } catch (e) { skipped++; }
    }
    return res.json({ success: true, message: `Done. Inserted: ${inserted}, Skipped: ${skipped}` });
  } catch (error) {
    console.error('Bulk failed courses error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/bulkAssignSupervisors', authMiddleware(['admin']), async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || !Array.isArray(data) || data.length === 0) {
      return res.json({ success: false, message: 'No data provided.' });
    }
    let created = 0, updated = 0, skipped = 0;
    for (const row of data) {
      const studentId = (row.studentId || '').trim();
      const supervisorId = (row.supervisorId || '').trim();
      const name = (row.name || '').trim();
      const email = (row.email || '').trim();
      const password = (row.password || '').trim();
      const faculty = (row.faculty || '').trim();
      const academicLevel = (row.academicLevel || '').trim();
      if (!studentId || !supervisorId) { skipped++; continue; }
      try {
        const { rows: existing } = await db.query('SELECT student_id FROM students WHERE student_id = $1', [studentId]);
        if (existing.length > 0) {
          await db.query('UPDATE students SET supervisor_id = $1 WHERE student_id = $2', [supervisorId, studentId]);
          updated++;
        } else {
          const hash = await bcrypt.hash(password || studentId, 12);
          await db.query(
            'INSERT INTO students (student_id, name, email, password_hash, faculty, academic_level, supervisor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [studentId, name || studentId, email || null, hash, faculty || 'General', academicLevel || null, supervisorId]
          );
          created++;
        }
      } catch (e) { skipped++; }
    }
    return res.json({ success: true, message: `Done. Created: ${created}, Updated: ${updated}, Skipped: ${skipped}` });
  } catch (error) {
    console.error('Bulk assign supervisors error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/updateCourseSeats', authMiddleware(['admin']), async (req, res) => {
  try {
    const { courseCode, maxSeats } = req.body;
    if (!courseCode || maxSeats === undefined) {
      return res.json({ success: false, message: 'Course code and max seats required.' });
    }
    const seats = parseInt(maxSeats);
    if (isNaN(seats) || seats < 0) {
      return res.json({ success: false, message: 'Invalid seat count.' });
    }
    await db.query('UPDATE courses SET max_seats = $1 WHERE course_code = $2', [seats, courseCode]);
    return res.json({ success: true, message: `${courseCode} max seats updated to ${seats}.` });
  } catch (error) {
    console.error('Update seats error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/bulkUpdateCourses', authMiddleware(['admin']), async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || !Array.isArray(data) || data.length === 0) {
      return res.json({ success: false, message: 'No data provided.' });
    }
    let updated = 0, created = 0, skipped = 0;
    for (const row of data) {
      const code = (row.courseCode || '').trim();
      const name = (row.courseName || '').trim();
      const creditHours = parseInt(row.creditHours);
      const maxSeats = parseInt(row.maxSeats);
      const feePerCredit = parseFloat(row.feePerCredit);
      const faculty = (row.faculty || '').trim();
      if (!code) { skipped++; continue; }
      try {
        const { rows: existing } = await db.query('SELECT course_code FROM courses WHERE course_code = $1', [code]);
        if (existing.length > 0) {
          const sets = [];
          const vals = [];
          let pi = 1;
          if (name) { sets.push(`course_name = $${pi++}`); vals.push(name); }
          if (!isNaN(creditHours)) { sets.push(`credit_hours = $${pi++}`); vals.push(creditHours); }
          if (!isNaN(maxSeats)) { sets.push(`max_seats = $${pi++}`); vals.push(maxSeats); }
          if (!isNaN(feePerCredit)) { sets.push(`fee_per_credit = $${pi++}`); vals.push(feePerCredit); }
          if (faculty) { sets.push(`faculty = $${pi++}`); vals.push(faculty); }
          if (sets.length > 0) {
            vals.push(code);
            await db.query(`UPDATE courses SET ${sets.join(', ')} WHERE course_code = $${pi}`, vals);
          }
          updated++;
        } else {
          if (!name || isNaN(creditHours)) { skipped++; continue; }
          await db.query(
            'INSERT INTO courses (course_code, course_name, credit_hours, max_seats, fee_per_credit, faculty) VALUES ($1,$2,$3,$4,$5,$6)',
            [code, name, creditHours, isNaN(maxSeats) ? 100 : maxSeats, isNaN(feePerCredit) ? 0 : feePerCredit, faculty || 'General']
          );
          created++;
        }
      } catch (e) { skipped++; }
    }
    return res.json({ success: true, message: `Done. Updated: ${updated}, Created: ${created}, Skipped: ${skipped}` });
  } catch (error) {
    console.error('Bulk update courses error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
