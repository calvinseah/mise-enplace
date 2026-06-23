'use strict';
require('dotenv').config();

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.startsWith('change-this')) {
  console.warn('\n⚠️  WARNING: ENCRYPTION_KEY is not set or default. Change it before storing real data.\n');
}

const express = require('express');
const session = require('express-session');
const path    = require('path');
const { initDB, syncAdminPassword } = require('./database');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mise-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

// ── Auth helpers ──────────────────────────────────────────────────────────────
function getUser(req)    { return req.session?.user || null; }
function isAdmin(req)    { return getUser(req)?.role === 'admin'; }
function isManager(req)  { const r = getUser(req)?.role; return r === 'admin' || r === 'manager'; }

// Redirect to login if not authenticated
function requireAuth(req, res, next) {
  if (isManager(req)) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.path));
}

// Admin-only page redirect
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  if (isManager(req)) return res.redirect('/dashboard?error=access');
  res.redirect('/login?next=' + encodeURIComponent(req.path));
}

// API: must be authenticated
function requireAuthAPI(req, res, next) {
  if (isManager(req)) return next();
  res.status(401).json({ error: 'Unauthorised. Please log in.' });
}

// API: admin only
function requireAdminAPI(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(403).json({ error: 'Admin access required.' });
}

// API: filter outlet access for managers
function outletFilter(req) {
  const user = getUser(req);
  if (!user) return null;
  if (user.role === 'admin') return null; // no filter
  return user.outlets || [];
}

// Expose user info to all routes
app.use((req, res, next) => {
  res.locals.user = getUser(req);
  next();
});

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes (public) ──────────────────────────────────────────────────────
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);
app.use('/api/auth/users', requireAuthAPI, requireAdminAPI, authRoutes); // user mgmt is admin only

// ── Route imports ─────────────────────────────────────────────────────────────
const attendanceRoutes    = require('./routes/attendance');
const staffRoutes         = require('./routes/staff');
const payslipRoutes       = require('./routes/payslip');
const applicationRoutes   = require('./routes/applications');
const revenueRoutes       = require('./routes/revenue');
const payrollSummaryRoutes= require('./routes/payrollSummary');
const rosterRoutes        = require('./routes/roster');
const maiseRoutes         = require('./routes/maise');

// ── Public clock-in API (no auth) ─────────────────────────────────────────────
const PUBLIC_ATT = ['/active-staff','/current/','/holiday-check','/verify-pin','/clock-in','/clock-out','/outlets'];
app.use('/api/attendance', (req, res, next) => {
  const isPublic = PUBLIC_ATT.some(p => req.path.startsWith(p));
  if (isPublic) return attendanceRoutes(req, res, next);
  requireAuthAPI(req, res, next);
}, attendanceRoutes);

// Public: apply
app.post('/api/apply', (req, res, next) => {
  req.url = '/submit';
  applicationRoutes(req, res, next);
});

// Public shift history
app.get('/api/attendance/my-shifts', attendanceRoutes);

// ── Manager API ───────────────────────────────────────────────────────────────
app.use('/api/staff',          requireAuthAPI, staffRoutes);
app.use('/api/applications',   requireAuthAPI, applicationRoutes);
app.use('/api/revenue',        requireAuthAPI, revenueRoutes);
app.use('/api/roster',         requireAuthAPI, rosterRoutes);
app.use('/api/maise',          requireAuthAPI, maiseRoutes);

// ── Admin-only API ────────────────────────────────────────────────────────────
app.use('/api/payslip',        requireAuthAPI, requireAdminAPI, payslipRoutes);
app.use('/api/payroll-summary',requireAuthAPI, requireAdminAPI, payrollSummaryRoutes);

// ── Session info for frontend ─────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  res.json({ id: u.id, username: u.username, name: u.name, role: u.role, outlets: u.outlets, outletNames: u.outletNames });
});

// ── HTML pages (public) ───────────────────────────────────────────────────────
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/clock',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'clock.html')));
app.get('/join',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
app.get('/my-shifts', (req, res) => res.sendFile(path.join(__dirname, 'public', 'my-shifts.html')));
app.get('/login',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// ── HTML pages (manager) ──────────────────────────────────────────────────────
app.get('/dashboard',       requireAuth,  (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/staff',           requireAuth,  (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));
app.get('/roster',          requireAuth,  (req, res) => res.sendFile(path.join(__dirname, 'public', 'roster.html')));
app.get('/labour-cost',     requireAuth,  (req, res) => res.sendFile(path.join(__dirname, 'public', 'labour-cost.html')));

// ── HTML pages (admin only) ───────────────────────────────────────────────────
app.get('/payslip',         requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'payslip.html')));
app.get('/payroll-summary', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'payroll-summary.html')));
app.get('/users',           requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'users.html')));


// Temporary admin password reset route
// Access: /reset-admin?token=RESET_TOKEN&password=newpassword
app.get('/reset-admin', async (req, res) => {
  const { token, password } = req.query;
  const validToken = process.env.RESET_TOKEN;
  if (!validToken || token !== validToken) {
    return res.status(403).send('Invalid token');
  }
  if (!password || password.length < 6) {
    return res.status(400).send('Password must be at least 6 characters');
  }
  try {
    const bcrypt = require('bcryptjs');
    const db = require('./database');
    const hashed = await bcrypt.hash(password, 10);
    db.run(`UPDATE users SET password=? WHERE username='admin'`, [hashed]);
    res.send('Admin password updated successfully. Remove RESET_TOKEN from Railway variables now.');
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});


// ── Admin DB backup download ──────────────────────────────────────────────────
app.get('/api/backup', (req, res) => {
  const { token } = req.query;
  const validToken = process.env.BACKUP_TOKEN;
  if (!validToken || token !== validToken) {
    return res.status(403).send('Invalid token');
  }
  try {
    const fs = require('fs');
    const dbPath = process.env.DB_PATH || './attendance.db';
    if (!fs.existsSync(dbPath)) {
      return res.status(404).send('Database file not found');
    }
    // Save latest DB state to disk first
    const db = require('./database');
    db.saveDB();
    const date = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="mise-backup-${date}.db"`);
    fs.createReadStream(dbPath).pipe(res);
  } catch(e) {
    res.status(500).send('Backup error: ' + e.message);
  }
});

initDB().then(() => syncAdminPassword()).then(() => {
  app.listen(PORT, () => {
    const base = process.env.BASE_URL || `http://localhost:${PORT}`;
    console.log(`\n🍽  Mise — Restaurant Management`);
    console.log(`   Clock-in:  ${base}/`);
    console.log(`   Dashboard: ${base}/dashboard`);
    console.log(`   Login:     ${base}/login`);
    console.log(`   Admin:     admin / ${process.env.ADMIN_PASSWORD || 'admin1234'}\n`);
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
