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
const companyRoutes        = require('./routes/companies');
const leaveRoutes          = require('./routes/leave');
const { router: auditRoutes } = require('./routes/audit');
const maiseKbRoutes = require('./routes/maiseKb');
const recipeRoutes = require('./routes/recipes');
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
// Public staff name search (no auth — only returns name/id/role for leave tab)
app.get('/api/staff/public-search', (req, res) => {
  const db = require('./database');
  const q = req.query.q || '';
  if (q.length < 2) return res.json([]);
  try {
    const results = db.all(
      `SELECT id, name, role, staff_type FROM staff WHERE is_active=1 AND staff_type='fulltime' AND name LIKE ? LIMIT 8`,
      ['%' + q + '%']
    );
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.use('/api/staff',          requireAuthAPI, staffRoutes);
app.use('/api/applications',   requireAuthAPI, applicationRoutes);
app.use('/api/companies',       requireAuthAPI, companyRoutes);
app.use('/api/recipes', recipeRoutes); // public read, auth for write handled in route
app.use('/api/maise-kb',        requireAuthAPI, maiseKbRoutes);
app.use('/api/audit',           requireAuthAPI, requireAdmin, auditRoutes); // public
app.use('/api/leave',           leaveRoutes); // auth handled inside route
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
app.get('/applications',    requireAuth,  (req, res) => res.sendFile(path.join(__dirname, 'public', 'applications.html')));
app.get('/roster',          requireAuth,  (req, res) => res.sendFile(path.join(__dirname, 'public', 'roster.html')));
app.get('/labour-cost',     requireAuth,  (req, res) => res.sendFile(path.join(__dirname, 'public', 'labour-cost.html')));

// ── HTML pages (admin only) ───────────────────────────────────────────────────
app.get('/payslip',         requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'payslip.html')));
app.get('/payroll-summary', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'payroll-summary.html')));
app.get('/users',           requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'users.html')));
app.get('/recipes',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'recipes.html')));
app.get('/maise',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'maise-page.html')));
app.get('/maise-kb',        requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'maise-kb.html')));
app.get('/leave', (req, res) => res.sendFile(path.join(__dirname, 'public', 'leave.html')));
app.get('/companies',       requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'companies.html')));


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
  if (!validToken || token !== validToken) return res.status(403).send('Invalid token');
  try {
    const db = require('./database');
    const data = db.exportDB();
    if (!data) return res.status(500).send('Export failed');
    const date = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="mise-backup-${date}.db"`);
    res.send(Buffer.from(data));
  } catch(e) { res.status(500).send('Backup error: ' + e.message); }
});

// List auto-backups (admin only)
app.get('/api/backups/list', requireAuthAPI, requireAdminAPI, (req, res) => {
  const fs = require('fs'), path = require('path');
  const backupDir = '/app/data/backups';
  try {
    if (!fs.existsSync(backupDir)) return res.json([]);
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.db'))
      .sort().reverse()
      .map(f => ({ name: f, size: fs.statSync(path.join(backupDir, f)).size }));
    res.json(files);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Download specific auto-backup (admin only)
app.get('/api/backups/download/:filename', requireAuthAPI, requireAdminAPI, (req, res) => {
  const fs = require('fs'), path = require('path');
  const filename = req.params.filename.replace(/[^\w\-_.]/g, '');
  const filePath = path.join('/app/data/backups', filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.download(filePath);
});



// ── Auto backup daily at 1:00 AM SGT (17:00 UTC) ─────────────────────────────
function scheduleAutoBackup() {
  const fs = require('fs');
  const path = require('path');

  function runBackup() {
    try {
      const db = require('./database');
      const data = db.exportDB(); // returns Uint8Array of the SQLite file
      if (!data) { console.log('[Auto backup] No data to backup'); return; }

      const backupDir = '/app/data/backups';
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

      // Keep last 7 daily backups
      const date = new Date().toISOString().slice(0, 10);
      const backupPath = path.join(backupDir, `attendance-${date}.db`);
      fs.writeFileSync(backupPath, Buffer.from(data));

      // Keep up to 365 daily backups (1 year)
      const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('attendance-') && f.endsWith('.db'))
        .sort();
      if (files.length > 365) {
        files.slice(0, files.length - 365).forEach(f => {
          try { fs.unlinkSync(path.join(backupDir, f)); } catch(e) {}
        });
      }

      console.log(`[Auto backup] Saved to ${backupPath} (${(data.length / 1024).toFixed(0)} KB)`);
    } catch(e) {
      console.error('[Auto backup] Error:', e.message);
    }
  }

  function scheduleNext() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(17, 0, 0, 0); // 1:00 AM SGT
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delay = next - now;
    const hrs = Math.floor(delay / 3600000);
    const mins = Math.floor((delay % 3600000) / 60000);
    console.log(`[Auto backup] Next run in ${hrs}h ${mins}m (1:00 AM SGT)`);
    setTimeout(() => { runBackup(); scheduleNext(); }, delay);
  }

  scheduleNext();
}

// ── Auto clock-out at 11:59pm SGT daily ──────────────────────────────────────
function runAutoClockout() {
  const db = require('./database');
  // 23:59 SGT = 15:59 UTC
  const now = new Date();
  const clockOutISO = (() => {
    const d = new Date();
    d.setUTCHours(15, 59, 0, 0);
    // If it's past 15:59 UTC today, use today; otherwise use yesterday
    if (d > now) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString();
  })();

  try {
    const open = db.all(`SELECT a.id, a.staff_id, a.clock_in FROM attendance a WHERE a.clock_out IS NULL`);
    if (!open.length) { console.log('[Auto clock-out] No open shifts found'); return 0; }

    const { computeShiftCost } = db;
    let count = 0;
    for (const record of open) {
      const clockIn = new Date(record.clock_in);
      // Set clock-out to 23:59 SGT on the same SGT date as clock-in
      const sgtDate = new Date(clockIn.getTime() + 8 * 3600000).toISOString().slice(0,10);
      const clockOut = new Date(sgtDate + 'T15:59:00.000Z');

      const durationMs = Math.max(0, clockOut - clockIn);
      const totalMins = durationMs / 60000;
      const breakMins = db.get(`SELECT COALESCE(SUM(duration_mins),0) as total FROM breaks WHERE attendance_id=?`, [record.id])?.total || 0;
      const netMins = Math.max(0, totalMins - breakMins);
      const totalHours = Math.round(netMins / 60 * 100) / 100;

      const staff = db.get(`SELECT * FROM staff WHERE id=?`, [record.staff_id]);
      const cost = staff ? Math.round(computeShiftCost(staff, totalHours, clockOut.toISOString(), false) * 100) / 100 : 0;

      db.run(
        `UPDATE attendance SET clock_out=?, break_minutes=?, total_hours=?, total_cost=?, notes=? WHERE id=?`,
        [clockOut.toISOString(), breakMins, totalHours, cost, 'Auto clocked out at 23:59', record.id]
      );
      db.run(`UPDATE breaks SET break_end=?, duration_mins=0 WHERE attendance_id=? AND break_end IS NULL`, [clockOut.toISOString(), record.id]);
      count++;
    }
    if (count) { db.saveDB(); }
    console.log(`[Auto clock-out] ${count} staff processed at 23:59 SGT`);
    return count;
  } catch(e) {
    console.error('[Auto clock-out] Error:', e.message);
    return 0;
  }
}

function scheduleAutoClockout() {
  function scheduleNext() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(15, 59, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delay = next - now;
    const hrs = Math.floor(delay/3600000), mins = Math.floor((delay%3600000)/60000);
    console.log(`[Auto clock-out] Scheduled — next run in ${hrs}h ${mins}m (23:59 SGT)`);
    setTimeout(() => { runAutoClockout(); scheduleNext(); }, delay);
  }
  scheduleNext();
}


// Manual auto clock-out trigger (admin only, for testing)
app.post('/api/admin/auto-clockout', requireAuthAPI, (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const count = runAutoClockout();
    res.json({ success: true, count, message: `${count} staff clocked out` });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
