const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const authRoutes = require('../routes/auth');
const studentRoutes = require('../routes/student');
const supervisorRoutes = require('../routes/supervisor');
const financeRoutes = require('../routes/finance');
const adminRoutes = require('../routes/admin');

const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/supervisor', supervisorRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'UEC API running.', timestamp: new Date().toISOString() });
});

module.exports = app;
