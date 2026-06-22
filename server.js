'use strict';
require('dotenv').config();

// Warn loudly if encryption key is default
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.startsWith('change-this')) {
  console.warn('\n⚠️  WARNING: ENCRYPTION_KEY is not set or is using the default value.');
  console.warn('   Set a strong random ENCRYPTION_KEY in your .env file before storing real data.\n');
}

const express = require('express');
const session = require('express-session');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const { initDB } = require('./database');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mad-sailors-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

// ── Auth ──────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.isManager) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.path));
}
function requireAuthAPI(req, res, next) {
  if (req.session?.isManager) return next();
  res.status(401).json({ error: 'Unauthorised. Please log in.' });
}

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (password !== (process.env.MANAGER_PASSWORD || 'admin1234'))
    return res.status(401).json({ error: 'Incorrect password' });
  req.session.isManager = true;
  res.json({ success: true });
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/auth/status', (req, res) => res.json({ loggedIn: !!req.session?.isManager }));

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────────────────
const attendanceRoutes  = require('./routes/attendance');
const staffRoutes       = require('./routes/staff');
const payslipRoutes     = require('./routes/payslip');
const applicationRoutes  = require('./routes/applications');
const revenueRoutes      = require('./routes/revenue');
const rosterRoutes       = require('./routes/roster');
const maiseRoutes        = require('./routes/maise');
const payrollSummaryRoutes = require('./routes/payrollSummary');

// Public clock-in endpoints
const PUBLIC_ATTENDANCE = ['/active-staff','/current/','/holiday-check','/verify-pin','/clock-in','/clock-out','/outlets'];
app.use('/api/attendance', (req, res, next) => {
  const isPublic = PUBLIC_ATTENDANCE.some(p => req.path.startsWith(p));
  if (isPublic) return next();
  requireAuthAPI(req, res, next);
}, attendanceRoutes);

app.use('/api/staff',   requireAuthAPI, staffRoutes);
app.use('/api/payslip',       requireAuthAPI, payslipRoutes);
app.use('/api/applications',  requireAuthAPI, applicationRoutes);
app.use('/api/revenue',       requireAuthAPI, revenueRoutes);
app.use('/api/roster',        requireAuthAPI, rosterRoutes);
app.use('/api/maise',         requireAuthAPI, maiseRoutes);
app.use('/api/payroll-summary', requireAuthAPI, payrollSummaryRoutes);
// Public: staff submit their own application
app.post('/api/apply', (req, res) => {
  // Proxy to the submit handler without auth
  req.url = '/submit';
  applicationRoutes(req, res, (err) => {
    if (err) res.status(500).json({ error: err.message });
  });
});

// ── HTML pages ────────────────────────────────────────────────────────────────
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/clock',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'clock.html')));
app.get('/join',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
app.get('/my-shifts',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'my-shifts.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/staff',     requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));
app.get('/payslip',          requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'payslip.html')));
app.get('/payroll-summary',  requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'payroll-summary.html')));
app.get('/labour-cost',      requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'labour-cost.html')));
app.get('/roster',           requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'roster.html')));

initDB().then(() => {
  app.listen(PORT, () => {
    const base = process.env.BASE_URL || `http://localhost:${PORT}`;
    console.log(`\n🍽  Mise — Restaurant Management`);
    console.log(`   Clock-in:  ${base}/`);
    console.log(`   Dashboard: ${base}/dashboard\n`);
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
