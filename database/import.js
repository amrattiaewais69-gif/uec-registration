require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').trim();
  const lines = content.split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '"') { inQuotes = !inQuotes; continue; }
      if (line[j] === ',' && !inQuotes) { values.push(current.trim()); current = ''; continue; }
      current += line[j];
    }
    values.push(current.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

async function importData() {
  const client = await pool.connect();
  try {
    console.log('Starting batch import...\n');
    const basePath = 'D:\\East Capital\\ALL Project\\Summer Course Registration\\30-6-2026\\1\\sheet';

    // Clear existing data
    await client.query('DELETE FROM audit_log');
    await client.query('DELETE FROM approval_history');
    await client.query('DELETE FROM payments');
    await client.query('DELETE FROM course_selections');
    await client.query('DELETE FROM requests');
    await client.query('DELETE FROM failed_courses');
    await client.query('DELETE FROM students');
    await client.query('DELETE FROM supervisors');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM courses');
    console.log('Cleared existing data.');

    // 1. Supervisors
    const supervisors = parseCSV(path.join(basePath, 'supervisors.csv'));
    for (const s of supervisors) {
      const hash = await bcrypt.hash(s.Password, 12);
      await client.query(
        'INSERT INTO supervisors (supervisor_id, name, email, password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (supervisor_id) DO NOTHING',
        [s.SupervisorID, s.SupervisorName, s.SupervisorEmail, hash]
      );
    }
    console.log(`Supervisors: ${supervisors.length}`);

    // 2. Students - batch
    const students = parseCSV(path.join(basePath, 'students.csv'));
    const studentChunks = [];
    for (let i = 0; i < students.length; i += 50) {
      studentChunks.push(students.slice(i, i + 50));
    }
    for (const chunk of studentChunks) {
      const values = [];
      const params = [];
      let paramIdx = 1;
      for (const s of chunk) {
        const hash = await bcrypt.hash(s.Password, 12);
        values.push(`($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`);
        params.push(s.StudentID, s.Name, s.Email, hash, s.Faculty || 'General', s.AcademicLevel, s.SupervisorID || null);
      }
      await client.query(
        `INSERT INTO students (student_id,name,email,password_hash,faculty,academic_level,supervisor_id)
         VALUES ${values.join(',')} ON CONFLICT (student_id) DO NOTHING`, params
      );
    }
    console.log(`Students: ${students.length}`);

    // 3. Courses
    const courses = parseCSV(path.join(basePath, 'courses.csv'));
    const courseValues = [];
    const courseParams = [];
    let ci = 1;
    for (const c of courses) {
      courseValues.push(`($${ci++},$${ci++},$${ci++},$${ci++},$${ci++},$${ci++})`);
      courseParams.push(c.CourseCode, c.CourseName, parseInt(c.CreditHours), parseInt(c.MaxSeats), parseFloat(c.FeePerCredit), c.Faculty || 'General');
    }
    await client.query(
      `INSERT INTO courses (course_code,course_name,credit_hours,max_seats,fee_per_credit,faculty)
       VALUES ${courseValues.join(',')} ON CONFLICT (course_code) DO NOTHING`, courseParams
    );
    console.log(`Courses: ${courses.length}`);

    // 4. Failed Courses
    const failed = parseCSV(path.join(basePath, 'failed_courses.csv'));
    const fcValues = [];
    const fcParams = [];
    let fi = 1;
    for (const f of failed) {
      fcValues.push(`($${fi++},$${fi++})`);
      fcParams.push(f.StudentID, f.CourseCode.trim());
    }
    if (fcValues.length > 0) {
      await client.query(
        `INSERT INTO failed_courses (student_id,course_code) VALUES ${fcValues.join(',')} ON CONFLICT DO NOTHING`, fcParams
      );
    }
    console.log(`Failed Courses: ${failed.length}`);

    // 5. Users
    const users = parseCSV(path.join(basePath, 'users.csv'));
    for (const u of users) {
      if (!u.Username || !u.Password) continue;
      const hash = await bcrypt.hash(u.Password, 12);
      await client.query(
        'INSERT INTO users (username,password_hash,email,role) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING',
        [u.Username, hash, u.Email || '', u.Role]
      );
    }
    console.log(`Users: ${users.length}`);

    console.log('\n=== IMPORT COMPLETE ===');
  } catch (error) {
    console.error('Import error:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

importData();
