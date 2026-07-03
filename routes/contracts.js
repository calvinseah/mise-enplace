'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');

function isAdmin(req) { return req.session?.user?.role === 'admin'; }

// ── Employer signature + signatory (stored once, reused for every contract) ────
router.get('/signature', (req, res) => {
  try {
    const row = db.get(`SELECT value FROM app_settings WHERE key='employer_signature'`);
    res.json(row ? JSON.parse(row.value) : { image: null, name: '', designation: '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/signature', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const payload = JSON.stringify({
      image:       (req.body.image || '').toString().slice(0, 2_000_000),
      name:        (req.body.name || '').toString().slice(0, 120),
      designation: (req.body.designation || '').toString().slice(0, 120),
    });
    db.run(
      `INSERT INTO app_settings (key, value) VALUES ('employer_signature', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [payload]
    );
    db.saveDB();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Data for the contract generator: part-time staff + companies ──────────────
router.get('/data', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const staff = db.all(
      `SELECT id, name, role, hourly_rate FROM staff
       WHERE is_active=1 AND staff_type='parttime' ORDER BY name`
    );
    const companies = db.all(`SELECT id, name, uen, address FROM companies WHERE is_active=1 ORDER BY name`);
    res.json({ staff, companies });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full particulars for one staff member (decrypted — admin only)
router.get('/staff/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const s = db.get(`SELECT * FROM staff WHERE id=?`, [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({
      id: s.id,
      name: s.name,
      role: s.role,
      hourly_rate: s.hourly_rate,
      nric_full: db.decryptField(s.nric_full_enc) || '',
      bank_name: s.bank_name || '',
      bank_account: db.decryptField(s.bank_account_enc) || '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
