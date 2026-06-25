'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const { writeLog } = require('./audit');

const LEAVE_TYPES = ['Annual Leave', 'Medical Leave', 'Childcare Leave', 'Maternity Leave', 'Paternity Leave', 'Unpaid Leave'];

// Singapore statutory defaults by leave type
const STATUTORY_DEFAULTS = {
  'Annual Leave':    14,
  'Medical Leave':   14,
  'Childcare Leave': 6,
  'Maternity Leave': 112, // 16 weeks in days
  'Paternity Leave': 28,  // 4 weeks in days
  'Unpaid Leave':    0
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function getWorkingDays(start, end) {
  let count = 0;
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function ensureEntitlements(staffId, year) {
  const staff = db.get('SELECT * FROM staff WHERE id=?', [staffId]);
  if (!staff) return;
  LEAVE_TYPES.forEach(type => {
    const existing = db.get('SELECT id FROM leave_entitlements WHERE staff_id=? AND year=? AND leave_type=?', [staffId, year, type]);
    if (!existing) {
      // Calculate annual leave based on years of service
      let days = STATUTORY_DEFAULTS[type] || 0;
      if (type === 'Annual Leave' && staff.date_of_birth) {
        // Use join date approximation - default to 7 days min
        days = 7;
      }
      db.run('INSERT INTO leave_entitlements (staff_id, year, leave_type, total_days, used_days) VALUES (?,?,?,?,0)',
        [staffId, year, type, days]);
    }
  });
}

// ── GET balances ──────────────────────────────────────────────────────────────
router.get('/balances', (req, res) => {
  const { staffId, year = new Date().getFullYear() } = req.query;
  if (!staffId) return res.status(400).json({ error: 'staffId required' });
  try {
    ensureEntitlements(staffId, year);
    const balances = db.all(
      'SELECT leave_type, total_days, used_days FROM leave_entitlements WHERE staff_id=? AND year=?',
      [staffId, year]
    );
    res.json(balances.map(b => ({
      ...b,
      remaining: Math.max(0, b.total_days - b.used_days)
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET applications ──────────────────────────────────────────────────────────
router.get('/applications', (req, res) => {
  const { staffId, status, year } = req.query;
  const user = req.session?.user;
  try {
    let sql = `SELECT la.*, s.name as staff_name, s.role FROM leave_applications la
               JOIN staff s ON la.staff_id=s.id WHERE 1=1`;
    const params = [];
    if (staffId) { sql += ' AND la.staff_id=?'; params.push(staffId); }
    if (status)  { sql += ' AND la.status=?'; params.push(status); }
    if (year)    { sql += ' AND substr(la.start_date,1,4)=?'; params.push(String(year)); }
    if (user?.role === 'manager' && user?.outlets?.length) {
      // Managers only see staff in their outlets
    }
    sql += ' ORDER BY la.created_at DESC';
    res.json(db.all(sql, params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST apply for leave ──────────────────────────────────────────────────────
router.post('/apply', (req, res) => {
  const { staffId, leave_type, start_date, end_date, reason } = req.body;
  if (!staffId || !leave_type || !start_date || !end_date)
    return res.status(400).json({ error: 'Missing required fields' });
  try {
    const days = getWorkingDays(start_date, end_date);
    if (days <= 0) return res.status(400).json({ error: 'No working days in selected range' });

    db.run(
      `INSERT INTO leave_applications (staff_id, leave_type, start_date, end_date, days, reason, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [staffId, leave_type, start_date, end_date, days, reason || null, 'pending', new Date().toISOString()]
    );
    const sName = db.get('SELECT name FROM staff WHERE id=?', [staffId])?.name || '';
    writeLog('staff:' + staffId, 'leave_applied', 'leave', null, sName, { leave_type, start_date, end_date, days });
    db.saveDB();
    res.json({ success: true, days });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT approve/reject ────────────────────────────────────────────────────────
router.put('/:id/review', (req, res) => {
  const user = req.session?.user;
  if (!user || (user.role !== 'admin' && user.role !== 'manager'))
    return res.status(403).json({ error: 'Unauthorised' });
  const { status, reject_reason } = req.body;
  if (!['approved', 'rejected'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  try {
    const app = db.get('SELECT * FROM leave_applications WHERE id=?', [req.params.id]);
    if (!app) return res.status(404).json({ error: 'Not found' });

    db.run(
      `UPDATE leave_applications SET status=?, reviewed_by=?, reviewed_at=?, reject_reason=? WHERE id=?`,
      [status, user.username, new Date().toISOString(), reject_reason || null, req.params.id]
    );

    // Update used_days in entitlements if approved
    if (status === 'approved' && app.leave_type !== 'Unpaid Leave') {
      const year = app.start_date.slice(0, 4);
      ensureEntitlements(app.staff_id, year);
      db.run(
        `UPDATE leave_entitlements SET used_days=used_days+? WHERE staff_id=? AND year=? AND leave_type=?`,
        [app.days, app.staff_id, year, app.leave_type]
      );
    }
    // Revert if previously approved and now rejected
    if (status === 'rejected' && app.status === 'approved' && app.leave_type !== 'Unpaid Leave') {
      const year = app.start_date.slice(0, 4);
      db.run(
        `UPDATE leave_entitlements SET used_days=MAX(0,used_days-?) WHERE staff_id=? AND year=? AND leave_type=?`,
        [app.days, app.staff_id, year, app.leave_type]
      );
    }

    writeLog(user.username, 'leave_' + status, 'leave', req.params.id, app.staff_name || '', { leave_type: app.leave_type, days: app.days, reject_reason });
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT update entitlement (admin) ────────────────────────────────────────────
router.put('/entitlements/:staffId', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { year = new Date().getFullYear(), leave_type, total_days, used_days } = req.body;
  try {
    ensureEntitlements(req.params.staffId, year);
    if (total_days !== undefined) {
      db.run(
        `UPDATE leave_entitlements SET total_days=? WHERE staff_id=? AND year=? AND leave_type=?`,
        [total_days, req.params.staffId, year, leave_type]
      );
    }
    if (used_days !== undefined) {
      db.run(
        `UPDATE leave_entitlements SET used_days=? WHERE staff_id=? AND year=? AND leave_type=?`,
        [used_days, req.params.staffId, year, leave_type]
      );
    }
    const sName2 = db.get('SELECT name FROM staff WHERE id=?', [req.params.staffId])?.name || '';
    writeLog(req.session?.user?.username || '?', 'update_leave_entitlement', 'leave_entitlement', req.params.staffId, sName2,
      { leave_type, year, total_days, used_days });
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE cancel application (by staff or admin) ─────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const app = db.get('SELECT * FROM leave_applications WHERE id=?', [req.params.id]);
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (app.status === 'approved') {
      const year = app.start_date.slice(0, 4);
      db.run(`UPDATE leave_entitlements SET used_days=MAX(0,used_days-?) WHERE staff_id=? AND year=? AND leave_type=?`,
        [app.days, app.staff_id, year, app.leave_type]);
    }
    db.run('DELETE FROM leave_applications WHERE id=?', [req.params.id]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
