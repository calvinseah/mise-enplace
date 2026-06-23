'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');

// ── Settings: closed days + shift times per outlet/month ──────────────────────
router.get('/settings', (req, res) => {
  const { year, month, outletId } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  try {
    let row = db.get(
      `SELECT * FROM roster_settings WHERE outlet_id=? AND year=? AND month=?`,
      [outletId || null, parseInt(year), parseInt(month)]
    );
    if (!row) {
      // Return defaults
      row = {
        outlet_id: outletId || null, year: parseInt(year), month: parseInt(month),
        closed_days: '[]', overridden_days: '[]',
        shift_times: JSON.stringify({
          opening:   { start: '10:00', end: '17:00' },
          closing:   { start: '17:00', end: '23:00' },
          fullshift: { start: '10:00', end: '23:00' },
        })
      };
    }
    row.closed_days     = JSON.parse(row.closed_days     || '[]');
    row.overridden_days = JSON.parse(row.overridden_days || '[]');
    row.shift_times     = JSON.parse(row.shift_times     || '{}');
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', (req, res) => {
  const { year, month, outletId, closed_days, shift_times, overridden_days } = req.body;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  try {
    db.run(
      `INSERT INTO roster_settings (outlet_id, year, month, closed_days, shift_times, overridden_days)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(outlet_id,year,month) DO UPDATE SET closed_days=excluded.closed_days, shift_times=excluded.shift_times, overridden_days=excluded.overridden_days`,
      [outletId || null, year, month,
       JSON.stringify(closed_days || []),
       JSON.stringify(shift_times || {}),
       JSON.stringify(overridden_days || [])]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Availability ──────────────────────────────────────────────────────────────
router.get('/availability', (req, res) => {
  const { year, month, outletId, staffId } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  try {
    let sql = `SELECT ra.*, s.name as staff_name, s.role
               FROM roster_availability ra
               JOIN staff s ON ra.staff_id=s.id
               WHERE ra.year=? AND ra.month=? AND ra.available=1`;
    const params = [parseInt(year), parseInt(month)];
    if (outletId) { sql += ` AND ra.outlet_id=?`; params.push(outletId); }
    if (staffId)  { sql += ` AND ra.staff_id=?`;  params.push(staffId); }
    res.json(db.all(sql, params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/availability', (req, res) => {
  const { staffId, outletId, year, month, day, shift_type, available } = req.body;
  if (!staffId || !year || !month || !day || !shift_type)
    return res.status(400).json({ error: 'staffId, year, month, day, shift_type required' });
  try {
    db.run(
      `INSERT INTO roster_availability (staff_id, outlet_id, year, month, day, shift_type, available)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(staff_id,outlet_id,year,month,day,shift_type) DO UPDATE SET available=excluded.available`,
      [staffId, outletId || null, year, month, day, shift_type, available ? 1 : 0]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bulk set availability for a staff member
router.post('/availability/bulk', (req, res) => {
  const { staffId, outletId, year, month, entries } = req.body;
  if (!staffId || !year || !month || !entries) return res.status(400).json({ error: 'Missing fields' });
  try {
    for (const e of entries) {
      db.run(
        `INSERT INTO roster_availability (staff_id, outlet_id, year, month, day, shift_type, available)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(staff_id,outlet_id,year,month,day,shift_type) DO UPDATE SET available=excluded.available`,
        [staffId, outletId || null, year, month, e.day, e.shift_type, e.available ? 1 : 0]
      );
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clear all availability for a staff/month
router.delete('/availability', (req, res) => {
  const { staffId, outletId, year, month } = req.query;
  if (!staffId || !year || !month) return res.status(400).json({ error: 'Missing fields' });
  try {
    db.run(
      `DELETE FROM roster_availability WHERE staff_id=? AND year=? AND month=?`,
      [staffId, year, month]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Schedule ──────────────────────────────────────────────────────────────────
router.get('/schedule', (req, res) => {
  const { year, month, outletId } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  try {
    let sql = `SELECT rs.id, rs.staff_id, rs.outlet_id, rs.year, rs.month, rs.day, rs.role_group, rs.shift_label, rs.start_time, rs.end_time, rs.removed, s.name as staff_name, s.role, s.hourly_rate, s.monthly_salary, s.staff_type
               FROM roster_schedule rs
               JOIN staff s ON rs.staff_id=s.id
               WHERE rs.year=? AND rs.month=?`;
    const params = [parseInt(year), parseInt(month)];
    if (outletId) { sql += ` AND rs.outlet_id=?`; params.push(outletId); }
    res.json(db.all(sql, params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/schedule', (req, res) => {
  const { staffId, outletId, year, month, day, role_group, shift_label, start_time, end_time } = req.body;
  if (!staffId || !year || !month || !day) return res.status(400).json({ error: 'Missing fields' });
  try {
    db.run(
      `INSERT INTO roster_schedule (staff_id, outlet_id, year, month, day, role_group, shift_label, start_time, end_time, removed)
       VALUES (?,?,?,?,?,?,?,?,?,0)
       ON CONFLICT(staff_id,outlet_id,year,month,day) DO UPDATE SET role_group=excluded.role_group, shift_label=excluded.shift_label, start_time=excluded.start_time, end_time=excluded.end_time, removed=0`,
      [staffId, outletId || null, year, month, day, role_group || 'foh', shift_label || null, start_time || null, end_time || null]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/schedule/:id', (req, res) => {
  const { shift_label, role_group, removed } = req.body;
  try {
    const updates = [];
    const params = [];
    if (shift_label !== undefined) { updates.push('shift_label=?'); params.push(shift_label); }
    if (role_group  !== undefined) { updates.push('role_group=?');  params.push(role_group); }
    if (removed     !== undefined) { updates.push('removed=?');     params.push(removed ? 1 : 0); }
    const { start_time, end_time } = req.body;
    if (start_time  !== undefined) { updates.push('start_time=?');  params.push(start_time); }
    if (end_time    !== undefined) { updates.push('end_time=?');    params.push(end_time); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    db.run(`UPDATE roster_schedule SET ${updates.join(',')} WHERE id=?`, params);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/schedule/:id', (req, res) => {
  try {
    db.run(`DELETE FROM roster_schedule WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── COL: Cost of Labour ───────────────────────────────────────────────────────
router.get('/col', (req, res) => {
  const { year, month, outletId, week } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  try {
    let sql = `SELECT rs.*, s.name as staff_name, s.hourly_rate, s.monthly_salary, s.staff_type
               FROM roster_schedule rs
               JOIN staff s ON rs.staff_id=s.id
               WHERE rs.year=? AND rs.month=? AND rs.removed=0 AND rs.shift_label IS NOT NULL AND rs.shift_label != ''`;
    const params = [parseInt(year), parseInt(month)];
    if (outletId) { sql += ` AND rs.outlet_id=?`; params.push(outletId); }
    if (week) {
      // week = 1..5, filter by day range
      const w = parseInt(week);
      const startDay = (w - 1) * 7 + 1;
      const endDay   = w * 7;
      sql += ` AND rs.day>=? AND rs.day<=?`;
      params.push(startDay, endDay);
    }
    sql += ` ORDER BY s.name, rs.day`;

    const rows = db.all(sql, params);

    // Get shift times for hour calculation
    const settings = db.get(
      `SELECT shift_times FROM roster_settings WHERE outlet_id=? AND year=? AND month=?`,
      [outletId || null, parseInt(year), parseInt(month)]
    );
    const shiftTimes = settings ? JSON.parse(settings.shift_times) : {
      opening:   { start: '10:00', end: '17:00' },
      closing:   { start: '17:00', end: '23:00' },
      fullshift: { start: '10:00', end: '23:00' },
    };

    // Parse hours from start_time/end_time (HH:MM) or shift label
    function parseHours(label, shiftTimesObj, startTime, endTime) {
      // Prefer explicit start/end times
      if (startTime && endTime) {
        const [sh,sm] = startTime.split(':').map(Number);
        const [eh,em] = endTime.split(':').map(Number);
        const diff = (eh*60+em) - (sh*60+sm);
        return diff > 0 ? Math.round(diff / 60 * 100) / 100 : 0;
      }
      if (!label) return 0;
      label = label.trim();
      const parts = label.split('-');
      if (parts.length < 2) return 0;

      function toMins(t) {
        t = t.trim().toUpperCase();
        if (t === 'C' || t === 'CLOSE') {
          const [ch, cm] = (shiftTimesObj.closing?.end || '23:00').split(':').map(Number);
          return ch * 60 + (cm || 0);
        }
        const clean = t.replace('.', ':');
        if (clean.includes(':')) {
          const [h, m] = clean.split(':').map(Number);
          return h * 60 + (m || 0);
        }
        return parseFloat(t) * 60;
      }

      const startMins = toMins(parts[0]);
      const endMins   = toMins(parts.slice(1).join('-'));
      const diff = endMins - startMins;
      return diff > 0 ? Math.round(diff / 60 * 100) / 100 : 0;
    }

    // Group by staff
    const byStaff = {};
    for (const r of rows) {
      const hours = parseHours(r.shift_label, shiftTimes, r.start_time, r.end_time);
      const rate  = r.staff_type === 'parttime' ? (r.hourly_rate || 0) : (r.monthly_salary || 0) / 26 / 8;
      const cost  = Math.round(hours * rate * 100) / 100;

      if (!byStaff[r.staff_id]) {
        byStaff[r.staff_id] = {
          staff_id: r.staff_id, name: r.staff_name,
          hourly_rate: Math.round(rate * 100) / 100,
          totalHours: 0, totalCost: 0, shifts: []
        };
      }
      byStaff[r.staff_id].totalHours += hours;
      byStaff[r.staff_id].totalCost  += cost;
      byStaff[r.staff_id].shifts.push({
        day: r.day, shift_label: r.shift_label,
        start_time: r.start_time, end_time: r.end_time,
        section: r.role_group,
        hours, rate: Math.round(rate * 100) / 100, cost
      });
    }

    const staffList = Object.values(byStaff).map(s => ({
      ...s,
      totalHours: Math.round(s.totalHours * 100) / 100,
      totalCost:  Math.round(s.totalCost  * 100) / 100,
    }));

    const totals = staffList.reduce((a, s) => ({
      totalHours: a.totalHours + s.totalHours,
      totalCost:  a.totalCost  + s.totalCost,
    }), { totalHours: 0, totalCost: 0 });

    res.json({ staff: staffList, totals, shiftTimes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
