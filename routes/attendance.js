'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const db      = require('../database');

// Active staff for clock-in (pin must exist AND be active)
router.get('/active-staff', (req, res) => {
  try {
    const staff = db.all(
      `SELECT id, name, role FROM staff
       WHERE is_active=1
       ORDER BY name`
    );
    res.json(staff);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check current clock-in status
router.get('/current/:staffId', (req, res) => {
  try {
    const record = db.get(
      `SELECT * FROM attendance WHERE staff_id=? AND clock_out IS NULL
       ORDER BY clock_in DESC LIMIT 1`,
      [req.params.staffId]
    );
    res.json({ active: !!record, record: record || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Holiday check
router.get('/holiday-check', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const holiday = db.get(`SELECT * FROM public_holidays WHERE date=?`, [date]);
    res.json({ isHoliday: !!holiday, holiday: holiday || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Active outlets for clock-in
router.get('/outlets', (req, res) => {
  try {
    res.json(db.all(`SELECT id, name FROM outlets WHERE is_active=1 ORDER BY name`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verify PIN
router.post('/verify-pin', async (req, res) => {
  const { staffId, pin } = req.body;
  if (!staffId || !pin) return res.status(400).json({ error: 'staffId and pin required' });
  try {
    // Check lockout
    const lockout = db.get(`SELECT * FROM pin_lockouts WHERE staff_id=?`, [staffId]);
    if (lockout?.locked_until && new Date(lockout.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(lockout.locked_until) - new Date()) / 60000);
      return res.status(429).json({ error: `Locked. Try again in ${mins} minute(s).`, locked: true });
    }

    const staff = db.get(`SELECT pin, pin_active FROM staff WHERE id=? AND is_active=1`, [staffId]);
    if (!staff?.pin) return res.status(404).json({ error: 'Staff not found' });
    if (!staff.pin_active) return res.status(403).json({ error: 'PIN is currently deactivated. Please see your manager.' });

    const match = await bcrypt.compare(String(pin), staff.pin);
    if (!match) {
      const attempts = (lockout?.attempts || 0) + 1;
      const lockedUntil = attempts >= 3 ? new Date(Date.now() + 5 * 60000).toISOString() : null;
      db.run(
        `INSERT INTO pin_lockouts (staff_id, attempts, locked_until) VALUES (?,?,?)
         ON CONFLICT(staff_id) DO UPDATE SET attempts=?, locked_until=?`,
        [staffId, attempts, lockedUntil, attempts, lockedUntil]
      );
      if (lockedUntil) return res.status(429).json({ error: 'Too many attempts. Locked for 5 minutes.', locked: true });
      return res.status(401).json({ error: 'Incorrect PIN. Please try again.', attemptsLeft: 3 - attempts });
    }

    db.run(`DELETE FROM pin_lockouts WHERE staff_id=?`, [staffId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clock in (with outlet)
router.post('/clock-in', (req, res) => {
  const { staffId, outletId } = req.body;
  if (!staffId) return res.status(400).json({ error: 'staffId required' });
  try {
    const active = db.get(`SELECT id FROM attendance WHERE staff_id=? AND clock_out IS NULL`, [staffId]);
    if (active) return res.status(400).json({ error: 'Already clocked in' });
    const now   = new Date().toISOString();
    const today = now.slice(0, 10);
    const holiday = db.get(`SELECT * FROM public_holidays WHERE date=?`, [today]);
    db.run(
      `INSERT INTO attendance (staff_id, outlet_id, clock_in, is_public_holiday)
       VALUES (?,?,?,?)`,
      [staffId, outletId || null, now, holiday ? 1 : 0]
    );
    const record = db.get(
      `SELECT * FROM attendance WHERE staff_id=? AND clock_out IS NULL ORDER BY id DESC LIMIT 1`,
      [staffId]
    );
    res.json({ success: true, record, holiday: holiday || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clock out
router.post('/clock-out', (req, res) => {
  const { staffId, breakMinutes = 0 } = req.body;
  if (!staffId) return res.status(400).json({ error: 'staffId required' });
  try {
    const record = db.get(
      `SELECT a.*, s.staff_type, s.monthly_salary, s.hourly_rate
       FROM attendance a JOIN staff s ON a.staff_id=s.id
       WHERE a.staff_id=? AND a.clock_out IS NULL ORDER BY a.clock_in DESC LIMIT 1`,
      [staffId]
    );
    if (!record) return res.status(400).json({ error: 'No active clock-in found' });
    const now = new Date();
    const grossMins  = (now - new Date(record.clock_in)) / 60000;
    const workedMins = grossMins - Number(breakMinutes);
    const totalHours = Math.round((workedMins / 60) * 100) / 100;
    const staff = db.get(`SELECT * FROM staff WHERE id=?`, [staffId]);
    const { cost } = db.computeShiftCost(staff, totalHours, record.is_public_holiday);
    db.run(
      `UPDATE attendance SET clock_out=?,break_minutes=?,total_hours=?,total_cost=? WHERE id=?`,
      [now.toISOString(), breakMinutes, totalHours, cost, record.id]
    );
    res.json({ success: true, totalHours, totalCost: cost });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manager: get records (with outlet filter)
router.get('/records', (req, res) => {
  try {
    const { from, to, staffId, outletId } = req.query;
    let sql = `
      SELECT a.*, s.name as staff_name, s.role, s.staff_type,
             ph.name as holiday_name,
             o.name as outlet_name
      FROM attendance a
      JOIN staff s ON a.staff_id=s.id
      LEFT JOIN public_holidays ph ON substr(a.clock_in,1,10)=ph.date
      LEFT JOIN outlets o ON a.outlet_id=o.id
      WHERE 1=1`;
    const params = [];
    if (from)     { sql += ` AND substr(a.clock_in,1,10)>=?`; params.push(from); }
    if (to)       { sql += ` AND substr(a.clock_in,1,10)<=?`; params.push(to); }
    if (staffId)  { sql += ` AND a.staff_id=?`;               params.push(staffId); }
    if (outletId) { sql += ` AND a.outlet_id=?`;              params.push(outletId); }
    sql += ` ORDER BY a.clock_in DESC`;
    res.json(db.all(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Amend record
router.put('/records/:id', (req, res) => {
  const { clockIn, clockOut, breakMinutes, isPublicHoliday, outletId, notes, amendedBy } = req.body;
  try {
    const record = db.get(
      `SELECT a.*, s.staff_type, s.monthly_salary, s.hourly_rate
       FROM attendance a JOIN staff s ON a.staff_id=s.id WHERE a.id=?`,
      [req.params.id]
    );
    if (!record) return res.status(404).json({ error: 'Record not found' });
    const ci  = new Date(clockIn || record.clock_in);
    const co  = clockOut ? new Date(clockOut) : null;
    let totalHours = record.total_hours;
    let totalCost  = record.total_cost;
    if (co) {
      const workedMins = (co - ci) / 60000 - Number(breakMinutes ?? record.break_minutes ?? 0);
      totalHours = Math.round((workedMins / 60) * 100) / 100;
      const ph = isPublicHoliday !== undefined ? isPublicHoliday : record.is_public_holiday;
      const { cost } = db.computeShiftCost(record, totalHours, ph);
      totalCost = cost;
    }
    db.run(
      `UPDATE attendance SET clock_in=?,clock_out=?,break_minutes=?,total_hours=?,total_cost=?,
       is_public_holiday=?,outlet_id=?,notes=?,is_amended=1,amended_by=?,amended_at=? WHERE id=?`,
      [clockIn || record.clock_in, clockOut || record.clock_out,
       breakMinutes ?? record.break_minutes, totalHours, totalCost,
       isPublicHoliday !== undefined ? (isPublicHoliday ? 1 : 0) : record.is_public_holiday,
       outletId !== undefined ? outletId : record.outlet_id,
       notes !== undefined ? notes : record.notes,
       amendedBy || 'Manager', new Date().toISOString(),
       req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public holidays CRUD
router.get('/holidays', (req, res) => {
  try { res.json(db.all(`SELECT * FROM public_holidays ORDER BY date`)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/holidays', (req, res) => {
  const { date, name } = req.body;
  if (!date || !name) return res.status(400).json({ error: 'date and name required' });
  try { db.run(`INSERT OR REPLACE INTO public_holidays (date,name) VALUES (?,?)`, [date, name]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/holidays/:id', (req, res) => {
  try { db.run(`DELETE FROM public_holidays WHERE id=?`, [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});


// ── PUBLIC: Staff shift history via NRIC lookup ───────────────────────────────
router.get('/my-shifts', (req, res) => {
  const { nric, from, to } = req.query;
  if (!nric || nric.length < 4) return res.status(400).json({ error: 'NRIC required' });
  try {
    // Find staff by last 4 of NRIC or full encrypted NRIC
    const { decryptField } = require('../database');
    const last4 = nric.slice(-4).toUpperCase();
    const allStaff = require('../database').all(
      `SELECT id, name, role, nric_last4, nric_full_enc FROM staff WHERE is_active=1`
    );

    // Match by last 4, then verify full NRIC if provided and stored
    const matched = allStaff.filter(s => {
      if (s.nric_last4 && s.nric_last4.toUpperCase() === last4) return true;
      const full = decryptField(s.nric_full_enc);
      if (full && full.toUpperCase() === nric.toUpperCase()) return true;
      return false;
    });

    if (!matched.length) return res.status(404).json({ error: 'No staff found with that NRIC.' });
    const staff = matched[0];

    const fromDate = from || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
    const toDate   = to   || new Date().toISOString().slice(0,10);

    const records = require('../database').all(
      `SELECT a.clock_in, a.clock_out, a.total_hours, a.break_minutes, a.is_public_holiday,
              o.name as outlet_name
       FROM attendance a
       LEFT JOIN outlets o ON a.outlet_id=o.id
       WHERE a.staff_id=? AND substr(a.clock_in,1,10)>=? AND substr(a.clock_in,1,10)<=?
         AND a.clock_out IS NOT NULL
       ORDER BY a.clock_in DESC`,
      [staff.id, fromDate, toDate]
    );

    const totalHours = records.reduce((s,r) => s + (r.total_hours||0), 0);

    res.json({
      name: staff.name,
      role: staff.role,
      from: fromDate,
      to: toDate,
      totalHours: Math.round(totalHours*100)/100,
      shifts: records.map(r => ({
        date:        r.clock_in.slice(0,10),
        clockIn:     r.clock_in,
        clockOut:    r.clock_out,
        hours:       r.total_hours || 0,
        breakMins:   r.break_minutes || 0,
        isPublicHoliday: r.is_public_holiday === 1,
        outlet:      r.outlet_name || null,
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Missed clock-out: staff clocked in but no clock-out from previous days ────
router.get('/missed-clockout', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Find records where clock_in is before today and clock_out is null
    const missed = require('../database').all(
      `SELECT a.id, a.clock_in, a.staff_id, s.name as staff_name, o.name as outlet_name
       FROM attendance a
       JOIN staff s ON a.staff_id = s.id
       LEFT JOIN outlets o ON a.outlet_id = o.id
       WHERE a.clock_out IS NULL
         AND substr(a.clock_in, 1, 10) < ?
       ORDER BY a.clock_in DESC`,
      [today]
    );
    res.json(missed);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
