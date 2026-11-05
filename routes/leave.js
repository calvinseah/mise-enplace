'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const { writeLog } = require('./audit');

const LEAVE_TYPES = ['Annual Leave', 'Medical Leave', 'Hospitalisation Leave', 'Compassionate Leave', 'Childcare Leave', 'Maternity Leave', 'Paternity Leave', 'Off in Lieu', 'Unpaid Leave'];

// Singapore statutory defaults by leave type
const STATUTORY_DEFAULTS = {
  'Annual Leave':          14,
  'Medical Leave':         14,
  'Hospitalisation Leave': 60,
  'Compassionate Leave':   3,
  'Childcare Leave':       6,
  'Maternity Leave':       112, // 16 weeks in days
  'Paternity Leave':       28,  // 4 weeks in days
  'Off in Lieu':           0,
  'Unpaid Leave':          0
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function getWorkingDays(start, end) {
  // Every calendar day in the range counts as a leave day — including weekends
  // AND public holidays. (The business operates on weekends and public holidays,
  // so leave taken on those days consumes a leave day like any other.)
  let count = 0;
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    count++;
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

// Staff a manager may act on: those who have clocked in at the manager's outlets.
// Returns null for admins (no restriction), or an array of staff ids for managers.
function managerStaffIds(user) {
  if (!user || user.role !== 'manager' || !user.outlets?.length) return null;
  const ph = user.outlets.map(() => '?').join(',');
  return db.all(`SELECT DISTINCT staff_id FROM attendance WHERE outlet_id IN (${ph})`, user.outlets)
           .map(r => r.staff_id);
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
      remaining: b.total_days - b.used_days
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
    // Managers only see leave for staff who work at their outlets
    const mgrIds = managerStaffIds(user);
    if (mgrIds !== null) {
      if (!mgrIds.length) return res.json([]);
      sql += ` AND la.staff_id IN (${mgrIds.map(() => '?').join(',')})`;
      params.push(...mgrIds);
    }
    sql += ' ORDER BY la.created_at DESC';
    res.json(db.all(sql, params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST apply for leave ──────────────────────────────────────────────────────
const MAX_ATTACHMENT_CHARS = 3000000; // ~2.2 MB of base64 ≈ a ~1.6 MB file

router.post('/apply', (req, res) => {
  const { staffId, leave_type, start_date, end_date, reason, attachment } = req.body;
  if (!staffId || !leave_type || !start_date || !end_date)
    return res.status(400).json({ error: 'Missing required fields' });
  // Validate attachment up front (optional). Expect { name, type, dataUrl }.
  if (attachment) {
    const d = attachment.dataUrl || '';
    if (typeof d !== 'string' || !/^data:(image\/|application\/pdf)/i.test(d))
      return res.status(400).json({ error: 'Attachment must be an image or PDF.' });
    if (d.length > MAX_ATTACHMENT_CHARS)
      return res.status(400).json({ error: 'Attachment is too large — please keep it under about 1.5 MB (images are auto-compressed on upload).' });
  }
  try {
    const days = getWorkingDays(start_date, end_date);
    if (days <= 0) return res.status(400).json({ error: 'No working days in selected range' });

    // Advance-notice rule: Annual Leave and Childcare Leave must be applied at
    // least 21 days (3 weeks) ahead of the leave start date. Other types
    // (medical, hospitalisation, compassionate, off-in-lieu, etc.) are exempt.
    const ADVANCE_NOTICE_TYPES = ['Annual Leave', 'Childcare Leave'];
    const ADVANCE_NOTICE_DAYS  = 21;
    if (ADVANCE_NOTICE_TYPES.includes(leave_type)) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const start = new Date(start_date + 'T00:00:00');
      const daysAhead = Math.round((start - today) / 86400000);
      if (daysAhead < ADVANCE_NOTICE_DAYS) {
        return res.status(400).json({
          error: `${leave_type} must be applied at least ${ADVANCE_NOTICE_DAYS} days in advance (earliest start date: ` +
                 new Date(today.getTime() + ADVANCE_NOTICE_DAYS * 86400000).toISOString().slice(0, 10) + ').'
        });
      }
    }

    const hasAtt = attachment ? 1 : 0;
    db.run(
      `INSERT INTO leave_applications (staff_id, leave_type, start_date, end_date, days, reason, status, created_at, has_attachment)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [staffId, leave_type, start_date, end_date, days, reason || null, 'pending', new Date().toISOString(), hasAtt]
    );
    if (hasAtt) {
      const appId = db.get('SELECT last_insert_rowid() AS id')?.id;
      if (appId) {
        db.run(
          `INSERT INTO leave_attachments (application_id, filename, mimetype, data, size, created_at)
           VALUES (?,?,?,?,?,?)`,
          [appId, attachment.name || null, attachment.type || null, attachment.dataUrl,
           attachment.dataUrl.length, new Date().toISOString()]
        );
      }
    }
    const sName = db.get('SELECT name FROM staff WHERE id=?', [staffId])?.name || '';
    writeLog('staff:' + staffId, 'leave_applied', 'leave', null, sName, { leave_type, start_date, end_date, days, attachment: !!hasAtt });
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

    // Managers can only review leave for staff at their own outlets
    if (user.role === 'manager') {
      const ids = managerStaffIds(user) || [];
      if (!ids.includes(app.staff_id)) return res.status(403).json({ error: 'This leave request is outside your outlets' });
    }

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

// ── POST verify NRIC (public — staff self-service identity check) ─────────────
router.post('/verify-nric', (req, res) => {
  const { staffId, nric } = req.body;
  if (!staffId || !nric) return res.status(400).json({ error: 'staffId and nric required' });
  try {
    const s = db.get('SELECT nric_full_enc, nric_last4 FROM staff WHERE id=? AND is_active=1', [staffId]);
    if (!s) return res.json({ success: false });
    const given  = String(nric).trim().toUpperCase();
    const stored = (db.decryptField(s.nric_full_enc) || '').trim().toUpperCase();
    let ok = stored ? stored === given : false;
    // Fallback to last-4 match if a full NRIC isn't stored
    if (!ok && !stored && s.nric_last4) ok = given.slice(-4) === String(s.nric_last4).trim().toUpperCase();
    res.json({ success: !!ok });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST bulk balance import (admin) — sets remaining balances ────────────────
router.post('/entitlements/bulk', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const year = req.body.year || new Date().getFullYear();
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  try {
    let staffUpdated = 0, fieldsUpdated = 0;
    for (const row of rows) {
      if (!row.staffId || !row.balances || typeof row.balances !== 'object') continue;
      ensureEntitlements(row.staffId, year);
      let any = false;
      for (const [type, val] of Object.entries(row.balances)) {
        if (!LEAVE_TYPES.includes(type)) continue;
        const n = Number(val);
        if (isNaN(n)) continue;
        // These are remaining balances: set total to the remaining and reset used to 0
        db.run(`UPDATE leave_entitlements SET total_days=?, used_days=0 WHERE staff_id=? AND year=? AND leave_type=?`,
          [n, row.staffId, year, type]);
        fieldsUpdated++; any = true;
      }
      if (any) staffUpdated++;
    }
    db.saveDB();
    writeLog(req.session.user.username, 'bulk_leave_balances', 'leave_entitlement', null, '', { year, staffUpdated, fieldsUpdated });
    res.json({ success: true, staffUpdated, fieldsUpdated, year });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST recalc used_days from approved applications (admin) ──────────────────
// Rebuilds each entitlement's used_days = SUM of approved leave (that type/year)
// with start_date on/after `since` (default the 29 Jul migration baseline, so
// leave already reflected in the imported 28 Jul balance is not double-counted).
// Unpaid Leave never consumes a balance. Totals (entitlements) are left untouched.
// Idempotent: safe to run any time; fixes drift from import/approve ordering.
router.post('/entitlements/recalc', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const year  = String(req.body.year || new Date().getFullYear());
  const since = req.body.since || (year + '-07-29');
  try {
    const sums = db.all(
      `SELECT staff_id, leave_type, SUM(days) AS d
         FROM leave_applications
        WHERE status='approved' AND leave_type<>'Unpaid Leave'
          AND substr(start_date,1,4)=? AND start_date>=?
        GROUP BY staff_id, leave_type`, [year, since]);
    // Reset all used for the year, then apply the recomputed totals.
    db.run(`UPDATE leave_entitlements SET used_days=0 WHERE year=?`, [year]);
    let groups = 0;
    for (const r of sums) {
      ensureEntitlements(r.staff_id, year);
      db.run(`UPDATE leave_entitlements SET used_days=? WHERE staff_id=? AND year=? AND leave_type=?`,
        [r.d, r.staff_id, year, r.leave_type]);
      groups++;
    }
    db.saveDB();
    writeLog(req.session.user.username, 'recalc_leave_used', 'leave_entitlement', null, '', { year, since, groups });
    res.json({ success: true, year, since, groups });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET leave attachment (admin/manager) — streams the stored file inline ─────
router.get('/:id/attachment', (req, res) => {
  const user = req.session?.user;
  if (!user || (user.role !== 'admin' && user.role !== 'manager'))
    return res.status(403).json({ error: 'Unauthorised' });
  try {
    const app = db.get('SELECT * FROM leave_applications WHERE id=?', [req.params.id]);
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (user.role === 'manager') {
      const ids = managerStaffIds(user) || [];
      if (!ids.includes(app.staff_id)) return res.status(403).json({ error: 'This leave request is outside your outlets' });
    }
    const att = db.get('SELECT * FROM leave_attachments WHERE application_id=? ORDER BY id DESC', [req.params.id]);
    if (!att || !att.data) return res.status(404).json({ error: 'No attachment' });
    const m = /^data:([^;]+);base64,(.*)$/s.exec(att.data);
    if (!m) return res.status(500).json({ error: 'Bad attachment data' });
    const buf = Buffer.from(m[2], 'base64');
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Content-Disposition', 'inline; filename="' + (att.filename || ('attachment-' + req.params.id)) + '"');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
