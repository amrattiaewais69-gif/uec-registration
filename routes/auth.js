const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/database');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
      return res.json({ success: false, message: 'All fields required.' });
    }

    const uStr = String(username).trim();
    const pStr = String(password).trim();

    if (role === 'student') {
      const { rows } = await db.query('SELECT * FROM students WHERE student_id = $1', [uStr]);
      if (rows.length === 0) return res.json({ success: false, message: 'Invalid credentials.' });
      const valid = await bcrypt.compare(pStr, rows[0].password_hash);
      if (!valid) return res.json({ success: false, message: 'Invalid credentials.' });
      return res.json({
        success: true, token: rows[0].student_id, email: rows[0].email,
        name: rows[0].name, faculty: rows[0].faculty || 'General',
        requirePasswordChange: (uStr === pStr)
      });
    }

    if (role === 'supervisor') {
      const { rows } = await db.query('SELECT * FROM supervisors WHERE supervisor_id = $1', [uStr]);
      if (rows.length === 0) return res.json({ success: false, message: 'Invalid credentials.' });
      const valid = await bcrypt.compare(pStr, rows[0].password_hash);
      if (!valid) return res.json({ success: false, message: 'Invalid credentials.' });
      return res.json({
        success: true, token: rows[0].supervisor_id, email: rows[0].email,
        name: rows[0].name, requirePasswordChange: (uStr === pStr)
      });
    }

    if (role === 'finance' || role === 'admin') {
      const { rows } = await db.query('SELECT * FROM users WHERE username = $1 AND role = $2', [uStr, role]);
      if (rows.length === 0) return res.json({ success: false, message: 'Invalid credentials.' });
      const valid = await bcrypt.compare(pStr, rows[0].password_hash);
      if (!valid) return res.json({ success: false, message: 'Invalid credentials.' });
      return res.json({
        success: true, token: rows[0].username, email: rows[0].email,
        name: rows[0].username, requirePasswordChange: (uStr === pStr)
      });
    }

    return res.json({ success: false, message: 'Invalid role.' });
  } catch (error) {
    console.error('Login error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/changePassword', async (req, res) => {
  try {
    const { username, oldPassword, newPassword, role } = req.body;
    if (!username || !oldPassword || !newPassword || !role) {
      return res.json({ success: false, message: 'All fields required.' });
    }

    let table, idColumn;
    if (role === 'student') { table = 'students'; idColumn = 'student_id'; }
    else if (role === 'supervisor') { table = 'supervisors'; idColumn = 'supervisor_id'; }
    else { table = 'users'; idColumn = 'username'; }

    const { rows } = await db.query(`SELECT * FROM ${table} WHERE ${idColumn} = $1`, [String(username).trim()]);
    if (rows.length === 0) return res.json({ success: false, message: 'User not found.' });

    const valid = await bcrypt.compare(String(oldPassword).trim(), rows[0].password_hash);
    if (!valid) return res.json({ success: false, message: 'Invalid Old Password.' });

    const newHash = await bcrypt.hash(String(newPassword).trim(), 12);
    await db.query(`UPDATE ${table} SET password_hash = $1 WHERE ${idColumn} = $2`, [newHash, String(username).trim()]);
    await logAction(String(username).trim(), 'Password changed for role: ' + role);

    return res.json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    console.error('Change password error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

async function logAction(actor, description) {
  try {
    const { v4: uuidv4 } = require('uuid');
    await db.query(
      'INSERT INTO audit_log (log_id, actor_identifier, description) VALUES ($1, $2, $3)',
      [uuidv4(), actor, description]
    );
  } catch (e) { /* silent */ }
}

module.exports = router;
module.exports.logAction = logAction;
