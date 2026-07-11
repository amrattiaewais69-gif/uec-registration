-- =========================================================================
-- UEC SUMMER COURSE REGISTRATION SYSTEM - PostgreSQL SCHEMA
-- =========================================================================

-- USERS (Admin + Finance)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'finance')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- SUPERVISORS
CREATE TABLE IF NOT EXISTS supervisors (
  id SERIAL PRIMARY KEY,
  supervisor_id VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- STUDENTS
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  student_id VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  faculty VARCHAR(255) DEFAULT 'General',
  academic_level VARCHAR(50),
  supervisor_id VARCHAR(100),
  photo_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (supervisor_id) REFERENCES supervisors(supervisor_id)
    ON DELETE SET NULL
);

-- COURSES
CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  course_code VARCHAR(50) NOT NULL UNIQUE,
  course_name VARCHAR(500) NOT NULL,
  credit_hours INTEGER NOT NULL DEFAULT 0,
  max_seats INTEGER NOT NULL DEFAULT 30,
  fee_per_credit DECIMAL(10,2) NOT NULL DEFAULT 0,
  faculty VARCHAR(255) DEFAULT 'General',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- FAILED COURSES
CREATE TABLE IF NOT EXISTS failed_courses (
  id SERIAL PRIMARY KEY,
  student_id VARCHAR(100) NOT NULL,
  course_code VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
  FOREIGN KEY (course_code) REFERENCES courses(course_code) ON DELETE CASCADE,
  UNIQUE(student_id, course_code)
);

-- REQUESTS
CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  request_id VARCHAR(100) NOT NULL UNIQUE,
  student_id VARCHAR(100) NOT NULL,
  total_credits INTEGER DEFAULT 0,
  total_fees DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'Draft',
  supervisor_comments TEXT,
  reference_number VARCHAR(255),
  payment_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_requests_student ON requests(student_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

-- COURSE SELECTIONS
CREATE TABLE IF NOT EXISTS course_selections (
  id SERIAL PRIMARY KEY,
  selection_id VARCHAR(100) NOT NULL UNIQUE,
  request_id VARCHAR(100) NOT NULL,
  student_id VARCHAR(100) NOT NULL,
  course_code VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (request_id) REFERENCES requests(request_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
  FOREIGN KEY (course_code) REFERENCES courses(course_code) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_selections_request ON course_selections(request_id);

-- PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  transaction_id VARCHAR(100) NOT NULL UNIQUE,
  request_id VARCHAR(100) NOT NULL,
  student_id VARCHAR(100) NOT NULL,
  amount_paid DECIMAL(10,2) NOT NULL DEFAULT 0,
  reference_number VARCHAR(255),
  payment_date TIMESTAMP,
  status VARCHAR(50) DEFAULT 'Pending',
  payment_method VARCHAR(100),
  receipt_no VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (request_id) REFERENCES requests(request_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_payments_request ON payments(request_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- APPROVAL HISTORY
CREATE TABLE IF NOT EXISTS approval_history (
  id SERIAL PRIMARY KEY,
  history_id VARCHAR(100) NOT NULL UNIQUE,
  request_id VARCHAR(100) NOT NULL,
  actor_email VARCHAR(255),
  actor_role VARCHAR(50),
  action VARCHAR(100),
  action_date TIMESTAMP DEFAULT NOW(),
  comments TEXT,
  FOREIGN KEY (request_id) REFERENCES requests(request_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_history_request ON approval_history(request_id);

-- AUDIT LOG
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  log_id VARCHAR(100) NOT NULL UNIQUE,
  action_date TIMESTAMP DEFAULT NOW(),
  actor_identifier VARCHAR(255),
  description TEXT
);

-- Function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_supervisors_updated_at BEFORE UPDATE ON supervisors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_students_updated_at BEFORE UPDATE ON students
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_courses_updated_at BEFORE UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_requests_updated_at BEFORE UPDATE ON requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
