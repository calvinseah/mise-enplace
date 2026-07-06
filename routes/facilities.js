'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');

function staffCanManage(req) {
  const r = req.session?.user?.role;
  return r === 'admin' || r === 'manager';
}

// ── WhatsApp notification via Twilio (fires when a fault is reported) ──────────
async function notifyFaultWhatsApp(f) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WHATSAPP_FROM;   // e.g. whatsapp:+14155238886
  const to    = process.env.TWILIO_WHATSAPP_TO;     // e.g. whatsapp:+65XXXXXXXX (comma-separated for many)
  if (!sid || !token || !from || !to) return;       // not configured — skip silently
  const body =
    '🔧 New fault reported\n' +
    (f.outlet_name ? `Outlet: ${f.outlet_name}\n` : '') +
    `Equipment: ${f.category}${f.brand ? ` (${f.brand})` : ''}\n` +
    `Urgency: ${String(f.priority || 'normal').toUpperCase()}\n` +
    (f.reported_by ? `By: ${f.reported_by}\n` : '') +
    `Issue: ${f.description}`;
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  for (const raw of to.split(',').map(s => s.trim()).filter(Boolean)) {
    const dest = raw.startsWith('whatsapp:') ? raw : 'whatsapp:' + raw;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: from, To: dest, Body: body }).toString(),
      });
    } catch (e) { /* never block reporting on a notification failure */ }
  }
}

// ── Active staff names for the reporter dropdown (public) ─────────────────────
router.get('/staff-list', (req, res) => {
  try { res.json(db.all('SELECT id, name FROM staff WHERE is_active=1 ORDER BY name')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Report a fault (public — any staff on the floor, no login) ─────────────────
router.post('/report', (req, res) => {
  const { outletId, category, brand, description, priority, reportedBy, photo } = req.body;
  if (!category || !description) return res.status(400).json({ error: 'Please choose the equipment and describe the issue.' });
  try {
    const outlet = outletId ? db.get('SELECT name FROM outlets WHERE id=?', [outletId]) : null;
    db.run(
      `INSERT INTO faults (outlet_id, outlet_name, category, brand, description, priority, photo, reported_by, status, reported_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'open', ?, ?)`,
      [outletId || null, outlet ? outlet.name : null, category,
       (brand || '').toString().slice(0, 120) || null,
       String(description).slice(0, 2000),
       priority || 'normal', (photo || '').toString().slice(0, 3_000_000) || null,
       (reportedBy || '').toString().slice(0, 120) || null,
       new Date().toISOString(), new Date().toISOString()]
    );
    // Fire-and-forget WhatsApp alert (won't block or fail the report)
    notifyFaultWhatsApp({
      outlet_name: outlet ? outlet.name : null, category, brand,
      priority: priority || 'normal', reported_by: reportedBy, description
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── List faults (admin/manager) ───────────────────────────────────────────────
router.get('/list', (req, res) => {
  if (!staffCanManage(req)) return res.status(403).json({ error: 'Unauthorised' });
  try {
    const { status, outletId } = req.query;
    let sql = 'SELECT * FROM faults WHERE 1=1';
    const params = [];
    if (status)   { sql += ' AND status=?'; params.push(status); }
    if (outletId) { sql += ' AND outlet_id=?'; params.push(outletId); }
    // Open first, then by priority, then newest
    sql += ` ORDER BY (status='resolved') ASC,
             CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END ASC,
             reported_at DESC`;
    res.json(db.all(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Counts for the dashboard badge
router.get('/open-count', (req, res) => {
  if (!staffCanManage(req)) return res.status(403).json({ error: 'Unauthorised' });
  try {
    const row = db.get(`SELECT COUNT(*) AS n FROM faults WHERE status!='resolved'`);
    res.json({ open: row ? row.n : 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update a fault: status / notes / cost (admin/manager) ─────────────────────
router.put('/:id', (req, res) => {
  const user = req.session?.user;
  if (!staffCanManage(req)) return res.status(403).json({ error: 'Unauthorised' });
  const { status, resolution_notes, cost } = req.body;
  try {
    const f = db.get('SELECT * FROM faults WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Not found' });
    const newStatus = ['open', 'in_progress', 'resolved'].includes(status) ? status : f.status;
    db.run(
      `UPDATE faults SET status=?, resolution_notes=?, cost=?, updated_at=?, updated_by=? WHERE id=?`,
      [newStatus,
       resolution_notes !== undefined ? resolution_notes : f.resolution_notes,
       cost !== undefined && cost !== '' ? Number(cost) : f.cost,
       new Date().toISOString(), user?.username || '', req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
