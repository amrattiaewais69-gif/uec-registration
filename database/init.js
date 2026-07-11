require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

async function initializeDatabase() {
  console.log('Initializing UEC Database (PostgreSQL)...\n');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false
  });

  const client = await pool.connect();

  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schema);
    console.log('Schema created.');

    // Seed default users
    const defaultUsers = [
      { username: 'admin', password: 'admin123', email: 'admin@uec.edu.eg', role: 'admin' },
      { username: 'finance', password: 'finance123', email: 'finance@uec.edu.eg', role: 'finance' }
    ];

    for (const user of defaultUsers) {
      const { rows } = await client.query('SELECT id FROM users WHERE username = $1', [user.username]);
      if (rows.length === 0) {
        const hash = await bcrypt.hash(user.password, 12);
        await client.query(
          'INSERT INTO users (username, password_hash, email, role) VALUES ($1, $2, $3, $4)',
          [user.username, hash, user.email, user.role]
        );
        console.log(`  Created: ${user.username} / ${user.password}`);
      }
    }

    // Seed default supervisor
    const supId = 'SUP001';
    const { rows: supRows } = await client.query('SELECT id FROM supervisors WHERE supervisor_id = $1', [supId]);
    if (supRows.length === 0) {
      const hash = await bcrypt.hash('supervisor123', 12);
      await client.query(
        'INSERT INTO supervisors (supervisor_id, name, email, password_hash) VALUES ($1, $2, $3, $4)',
        [supId, 'Dr. Supervisor', 'supervisor@uec.edu.eg', hash]
      );
      console.log(`  Created: SUP001 / supervisor123`);
    }

    // Seed default student
    const stuId = '25100012';
    const { rows: stuRows } = await client.query('SELECT id FROM students WHERE student_id = $1', [stuId]);
    if (stuRows.length === 0) {
      const hash = await bcrypt.hash(stuId, 12);
      await client.query(
        'INSERT INTO students (student_id, name, email, password_hash, faculty, academic_level, supervisor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [stuId, 'Test Student', 'student@uec.edu.eg', hash, 'Pharmacy', '3rd Year', supId]
      );
      console.log(`  Created: ${stuId} / ${stuId}`);
    }

    // Seed default courses
    const defaultCourses = [
      { code: 'PHM301', name: 'Clinical Pharmacy', credits: 3, seats: 30, fee: 1500, faculty: 'Pharmacy' },
      { code: 'PHM302', name: 'Pharmacology II', credits: 3, seats: 25, fee: 1500, faculty: 'Pharmacy' },
      { code: 'PHM303', name: 'Medicinal Chemistry', credits: 2, seats: 20, fee: 1200, faculty: 'Pharmacy' },
      { code: 'PHM401', name: 'Drug Information', credits: 2, seats: 30, fee: 1200, faculty: 'Pharmacy' }
    ];

    for (const c of defaultCourses) {
      const { rows } = await client.query('SELECT id FROM courses WHERE course_code = $1', [c.code]);
      if (rows.length === 0) {
        await client.query(
          'INSERT INTO courses (course_code, course_name, credit_hours, max_seats, fee_per_credit, faculty) VALUES ($1, $2, $3, $4, $5, $6)',
          [c.code, c.name, c.credits, c.seats, c.fee, c.faculty]
        );
      }
    }
    console.log('  Default courses seeded.');

    // Seed failed courses
    await client.query(
      "INSERT INTO failed_courses (student_id, course_code) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [stuId, 'PHM301']
    );
    await client.query(
      "INSERT INTO failed_courses (student_id, course_code) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [stuId, 'PHM302']
    );

    console.log('\nInitialization complete!');
    console.log('Credentials:');
    console.log('  Admin:     admin / admin123');
    console.log('  Finance:   finance / finance123');
    console.log('  Student:   25100012 / 25100012');
    console.log('  Supervisor: SUP001 / supervisor123');

  } catch (error) {
    console.error('Init failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

initializeDatabase();
