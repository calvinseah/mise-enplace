'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');

const SG_BANKS = ['DBS','POSB','OCBC','UOB','Standard Chartered','Citibank','HSBC',
  'Maybank','CIMB','RHB','Maribank','Trust Bank','GXS','Others'];

// ── PUBLIC: Submit application ─────────────────────────────────────────────────
router.post('/submit', (req, res) => {
  const { date_of_birth, nric_full, bank_name, bank_account } = req.body;
  const rawName = req.body.name || '';

  // Convert to title case: "AHMAD BIN HASSAN" → "Ahmad Bin Hassan"
  const name = rawName.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (bank_name && !SG_BANKS.includes(bank_name)) return res.status(400).json({ error: 'Invalid bank' });

  try {
    db.run(
      `INSERT INTO applications (name, date_of_birth, nric_full_enc, bank_name, bank_account_enc, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        name.trim(),
        date_of_birth || null,
        db.encryptField(nric_full || null),
        bank_name || null,
        db.encryptField(bank_account || null),
        new Date().toISOString(),
      ]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MANAGER: List applications ────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const rows = db.all(
      `SELECT * FROM applications WHERE status = ? ORDER BY submitted_at DESC`,
      [status]
    );
    // Decrypt secure fields for manager view
    const out = rows.map(r => ({
      ...r,
      nric_full:    db.decryptField(r.nric_full_enc) || null,
      bank_account: db.decryptField(r.bank_account_enc) || null,
    }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MANAGER: Approve → creates staff member ───────────────────────────────────
router.post('/:id/approve', (req, res) => {
  const { role, staff_type, monthly_salary, hourly_rate } = req.body;
  if (!role || !staff_type) return res.status(400).json({ error: 'role and staff_type required' });

  try {
    const app = db.get(`SELECT * FROM applications WHERE id = ? AND status = 'pending'`, [req.params.id]);
    if (!app) return res.status(404).json({ error: 'Application not found or already reviewed' });

    // Extract last 4 of NRIC for the display field
    const nricFull = db.decryptField(app.nric_full_enc) || '';
    const nricLast4 = nricFull.length >= 4 ? nricFull.slice(-4) : null;

    // Create staff member
    db.run(
      `INSERT INTO staff (name, role, staff_type, monthly_salary, hourly_rate, date_of_birth,
        pr_status, nric_last4, nric_full_enc, bank_name, bank_account_enc, pin_active, is_active)
       VALUES (?,?,?,?,?,?,'citizen',?,?,?,?,0,1)`,
      [
        app.name,
        role,
        staff_type,
        staff_type === 'fulltime' ? (monthly_salary || null) : null,
        staff_type === 'parttime' ? (hourly_rate   || null) : null,
        app.date_of_birth || null,
        nricLast4,
        app.nric_full_enc,
        app.bank_name || null,
        app.bank_account_enc,
      ]
    );

    // Mark application approved
    db.run(
      `UPDATE applications SET status='approved', reviewed_at=?, reviewed_by='Manager' WHERE id=?`,
      [new Date().toISOString(), req.params.id]
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MANAGER: Reject ───────────────────────────────────────────────────────────
router.post('/:id/reject', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { reason } = req.body;
  try {
    const app = db.get(`SELECT id FROM applications WHERE id = ? AND status = 'pending'`, [req.params.id]);
    if (!app) return res.status(404).json({ error: 'Application not found or already reviewed' });

    db.run(
      `UPDATE applications SET status='rejected', reviewed_at=?, reviewed_by='Manager', reject_reason=? WHERE id=?`,
      [new Date().toISOString(), reason || null, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
