'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const multer  = require('multer');
const XLSX    = require('xlsx');
const router  = express.Router();
const db      = require('../database');

const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const SG_BANKS = [
  'PayNow','DBS','POSB','OCBC','UOB','Standard Chartered','Citibank','HSBC',
  'Maybank','CIMB','RHB','Maribank','Trust Bank','GXS','Others'
];

// ── Safe staff object (never exposes pin hash or raw encrypted fields) ─────────
function safeStaff(s, includeSecure = false, isAdmin = false) {
  const out = {
    id: s.id, name: s.name, role: s.role, staff_type: s.staff_type,
    monthly_salary: isAdmin || s.staff_type === 'parttime' ? s.monthly_salary : null,
    hourly_rate: s.hourly_rate,
    date_of_birth: isAdmin ? s.date_of_birth : null,
    pr_status: isAdmin ? s.pr_status : null,
    pr_year: isAdmin ? s.pr_year : null,
    nric_last4: isAdmin ? s.nric_last4 : null,
    bank_name: isAdmin ? s.bank_name : null,
    pin_active: s.pin_active, is_active: s.is_active,
    has_pin: s.pin ? 1 : 0,
  };
  if (includeSecure && isAdmin) {
    out.nric_full = db.decryptField(s.nric_full_enc) || null;
    out.bank_account = db.decryptField(s.bank_account_enc) || null;
  }
  return out;
}

// GET all staff
router.get('/', (req, res) => {
  try {
    const isAdmin = req.session?.user?.role === 'admin';
    const rows = db.all(`SELECT * FROM staff ORDER BY is_active DESC, name`);
    res.json(rows.map(s => safeStaff(s, false, isAdmin)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET single staff (includes decrypted secure fields for manager view)
router.get('/:id', (req, res) => {
  try {
    const s = db.get(`SELECT * FROM staff WHERE id = ?`, [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const isAdminSingle = req.session?.user?.role === 'admin';
    res.json(safeStaff(s, true, isAdminSingle));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CREATE staff
router.post('/', async (req, res) => {
  const { name, role, staff_type, monthly_salary, hourly_rate, date_of_birth,
          pr_status, pr_year, nric_last4, nric_full, bank_name, bank_account, pin } = req.body;
  if (!name || !role || !staff_type) return res.status(400).json({ error: 'name, role, staff_type required' });
  try {
    let hashedPin = null;
    if (pin && /^\d{4}$/.test(String(pin))) hashedPin = await bcrypt.hash(String(pin), 10);
    db.run(
      `INSERT INTO staff (name, role, staff_type, monthly_salary, hourly_rate, date_of_birth,
        pr_status, pr_year, nric_last4, nric_full_enc, bank_name, bank_account_enc,
        pin, pin_active, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,1)`,
      [name, role, staff_type,
       staff_type === 'fulltime' ? (monthly_salary || null) : null,
       staff_type === 'parttime' ? (hourly_rate || null) : null,
       date_of_birth || null, pr_status || 'citizen', pr_year || null,
       nric_last4 || null,
       db.encryptField(nric_full || null),
       bank_name || null,
       db.encryptField(bank_account || null),
       hashedPin]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// UPDATE staff
router.put('/:id', async (req, res) => {
  const { name, role, staff_type, monthly_salary, hourly_rate, date_of_birth,
          pr_status, pr_year, nric_last4, nric_full, bank_name, bank_account } = req.body;
  try {
    const existing = db.get(`SELECT nric_full_enc, bank_account_enc FROM staff WHERE id = ?`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const newNricEnc = nric_full !== undefined
      ? db.encryptField(nric_full || null)
      : existing.nric_full_enc;
    const newBankEnc = bank_account !== undefined
      ? db.encryptField(bank_account || null)
      : existing.bank_account_enc;

    db.run(
      `UPDATE staff SET name=?,role=?,staff_type=?,monthly_salary=?,hourly_rate=?,
       date_of_birth=?,pr_status=?,pr_year=?,nric_last4=?,nric_full_enc=?,
       bank_name=?,bank_account_enc=? WHERE id=?`,
      [name, role, staff_type,
       staff_type === 'fulltime' ? (monthly_salary || null) : null,
       staff_type === 'parttime' ? (hourly_rate || null) : null,
       date_of_birth || null, pr_status || 'citizen', pr_year || null,
       nric_last4 || null, newNricEnc, bank_name || null, newBankEnc,
       req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SET / RESET PIN
router.post('/:id/pin', async (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
  try {
    const hashed = await bcrypt.hash(String(pin), 10);
    db.run(`UPDATE staff SET pin=?, pin_active=1 WHERE id=?`, [hashed, req.params.id]);
    db.run(`DELETE FROM pin_lockouts WHERE staff_id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// TOGGLE PIN active/inactive (deactivate without removing PIN)
router.patch('/:id/pin-active', (req, res) => {
  const { pin_active } = req.body;
  try {
    db.run(`UPDATE staff SET pin_active=? WHERE id=?`, [pin_active ? 1 : 0, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// REMOVE PIN entirely
router.delete('/:id/pin', (req, res) => {
  try {
    db.run(`UPDATE staff SET pin=NULL, pin_active=0 WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// TOGGLE active status
router.patch('/:id/status', (req, res) => {
  const { is_active } = req.body;
  try {
    db.run(`UPDATE staff SET is_active=? WHERE id=?`, [is_active ? 1 : 0, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── OUTLETS ───────────────────────────────────────────────────────────────────
router.get('/outlets/list', (req, res) => {
  try {
    const user = req.session?.user;
    if (user?.role === 'manager' && user?.outlets?.length) {
      const placeholders = user.outlets.map(() => '?').join(',');
      res.json(db.all(`SELECT * FROM outlets WHERE id IN (${placeholders}) ORDER BY name`, user.outlets));
    } else {
      res.json(db.all(`SELECT * FROM outlets ORDER BY name`));
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/outlets', (req, res) => {
  const { name, address } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    db.run(`INSERT INTO outlets (name, address) VALUES (?,?)`, [name, address || null]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/outlets/:id', (req, res) => {
  const { name, address, is_active } = req.body;
  try {
    db.run(`UPDATE outlets SET name=?,address=?,is_active=? WHERE id=?`,
      [name, address || null, is_active !== undefined ? (is_active ? 1 : 0) : 1, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/outlets/:id', (req, res) => {
  try {
    db.run(`DELETE FROM outlets WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BULK UPLOAD ───────────────────────────────────────────────────────────────
// Download template
router.get('/bulk/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const headers = [
    'name','role','staff_type','monthly_salary','hourly_rate',
    'date_of_birth','pr_status','pr_year','nric_last4','nric_full',
    'bank_name','bank_account','pin'
  ];
  const example = [
    'Jamie Tan','FOH','parttime','','9.50',
    '2001-03-15','citizen','','1234','S1234567A',
    'DBS','123456789','1001'
  ];
  const notes = [
    'Full name','FOH or BOH',
    'fulltime or parttime',
    'Monthly salary (fulltime only)',
    'Hourly rate (parttime only)',
    'YYYY-MM-DD',
    'citizen / pr / foreigner',
    'Year PR obtained (PR only)',
    'Last 4 digits of NRIC',
    'Full NRIC e.g. S1234567A (encrypted)',
    'DBS/POSB/OCBC/UOB/etc.',
    'Bank account number (encrypted)',
    '4-digit PIN (optional)'
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, notes, example]);
  ws['!cols'] = headers.map(() => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Staff');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="staff_upload_template.xlsx"');
  res.send(buf);
});

// Process upload
router.post('/bulk/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Row 0 = headers, Row 1 = notes (skip), Row 2+ = data
    if (rows.length < 3) return res.status(400).json({ error: 'No data rows found. Use the template.' });

    const headers = rows[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g,'_'));
    const dataRows = rows.slice(2).filter(r => r.some(c => c !== ''));

    const results = { created: 0, skipped: 0, errors: [] };

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const r = {};
      headers.forEach((h, idx) => { r[h] = String(row[idx] || '').trim(); });

      if (!r.name || !r.role || !r.staff_type) {
        results.errors.push(`Row ${i + 3}: missing name, role, or staff_type`);
        results.skipped++;
        continue;
      }
      if (!['fulltime','parttime'].includes(r.staff_type)) {
        results.errors.push(`Row ${i + 3}: staff_type must be 'fulltime' or 'parttime'`);
        results.skipped++;
        continue;
      }

      try {
        let hashedPin = null;
        if (r.pin && /^\d{4}$/.test(r.pin)) hashedPin = await bcrypt.hash(r.pin, 10);

        db.run(
          `INSERT INTO staff (name, role, staff_type, monthly_salary, hourly_rate,
            date_of_birth, pr_status, pr_year, nric_last4, nric_full_enc,
            bank_name, bank_account_enc, pin, pin_active, is_active)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,1)`,
          [r.name, r.role, r.staff_type,
           r.staff_type === 'fulltime' && r.monthly_salary ? parseFloat(r.monthly_salary) : null,
           r.staff_type === 'parttime' && r.hourly_rate   ? parseFloat(r.hourly_rate)    : null,
           r.date_of_birth || null,
           ['citizen','pr','foreigner'].includes(r.pr_status) ? r.pr_status : 'citizen',
           r.pr_year ? parseInt(r.pr_year) : null,
           r.nric_last4 || null,
           db.encryptField(r.nric_full || null),
           r.bank_name || null,
           db.encryptField(r.bank_account || null),
           hashedPin]
        );
        results.created++;
      } catch (e) {
        results.errors.push(`Row ${i + 3} (${r.name}): ${e.message}`);
        results.skipped++;
      }
    }

    res.json({ success: true, ...results });
  } catch (e) {
    res.status(400).json({ error: 'Could not parse file: ' + e.message });
  }
});

module.exports = router;
