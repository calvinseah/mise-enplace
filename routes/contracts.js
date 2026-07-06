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

// ── Generate + send via DocuSeal (fills particulars, employee signs) ──────────
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const CONTRACT_TERMS = [
  ['Working Hours','The Employee shall work on a part-time basis as mutually agreed between the parties. Scheduled working hours and days shall be confirmed in writing prior to the commencement of each work period. The Employer reserves the right to adjust working hours with reasonable notice.'],
  ['Remuneration','The Employee shall be paid at an hourly rate, on a monthly basis by 7 days following each calendar month via bank transfer. The Employer shall provide a monthly pay slip detailing hours worked and total remuneration.'],
  ['Confidentiality','The Employee agrees to keep all business information, client data, trade secrets, and proprietary information of the Employer strictly confidential, both during and after the term of employment. Breach of this clause may result in immediate termination and legal action.'],
  ['Code of Conduct','The Employee is expected to conduct themselves professionally at all times, adhere to the Employer\u2019s policies and procedures, treat colleagues, clients, and stakeholders with respect, and maintain the reputation and integrity of the Company.'],
  ['Termination','Either party may terminate this agreement by providing written notice as follows: During probation (if applicable): 1 week\u2019s notice or payment in lieu. After confirmation: 2 weeks\u2019 notice or payment in lieu. The Employer may terminate immediately without notice in cases of gross misconduct, dishonesty, or serious breach of contract.'],
  ['Intellectual Property','All work product, inventions, creative works, and deliverables produced by the Employee in the course of employment shall remain the sole property of the Company. The Employee waives any moral rights to such works to the fullest extent permitted by law.'],
  ['Governing Law','This Agreement shall be governed by and construed in accordance with the laws of the Republic of Singapore. Disputes shall be resolved through good-faith negotiation, failing which, through the appropriate Singapore courts or tribunals.'],
  ['Entire Agreement','This Agreement constitutes the entire agreement between the parties and supersedes all prior discussions or representations. Any amendments must be made in writing and signed by both parties.'],
];

function buildContractHtml(staff, company, sig) {
  const addr = (company.address || '19 Rochdale Road\nSingapore 535834');
  const rate = staff.hourly_rate ? Number(staff.hourly_rate).toFixed(2) : '';
  const bank = [staff.bank_name, staff.bank_account].filter(Boolean).join(' \u2014 ');
  const empSig = sig.image ? `<img src="${sig.image}" style="height:46px">` : '';
  const empName = [sig.name, sig.designation].filter(Boolean).join(', ');
  const terms = CONTRACT_TERMS.map((t,i)=>`<div style="margin:8px 0"><div style="font-weight:bold">${i+1}. ${t[0]}</div><div>${t[1]}</div></div>`).join('');

  // DocuSeal fillable field tags for the Employee to complete/sign
  const fContact  = '<text-field name="Contact No." role="Employee" required="false" style="width:150px;height:15px;display:inline-block"></text-field>';
  const fSig      = '<signature-field name="Employee Signature" role="Employee" required="true" style="width:190px;height:46px;display:inline-block"></signature-field>';
  const fNric     = '<text-field name="Employee Name and NRIC" role="Employee" required="true" style="width:200px;height:15px;display:inline-block"></text-field>';
  const fEmpDate  = '<date-field name="Employee Date" role="Employee" required="true" style="width:130px;height:15px;display:inline-block"></date-field>';

  return `<div style="font-family:Helvetica,Arial,sans-serif;color:#1E2A22;font-size:11px;line-height:1.5">
<div style="font-size:20px;font-weight:bold">The Black Hole Group</div>
<div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#3D5240;margin-top:2px">Part-Time Employment Contract</div>
<div style="border-bottom:2px solid #1B2A4A;margin:10px 0 14px"></div>
<div style="letter-spacing:1px;text-transform:uppercase;color:#3D5240;font-weight:bold;margin:12px 0 6px">Parties to the Agreement</div>
<table style="width:100%"><tr>
<td style="width:50%;vertical-align:top;padding-right:16px">
<div style="font-size:9px;text-transform:uppercase;color:#9AA79E;font-weight:bold;margin-bottom:3px">Employer</div>
<div><b>Company Name:</b> ${esc(company.name)}</div>
<div><b>Reg. No.:</b> ${esc(company.uen)}</div>
<div><b>Address:</b> ${esc(addr).replace(/\n/g,'<br>')}</div>
</td>
<td style="width:50%;vertical-align:top">
<div style="font-size:9px;text-transform:uppercase;color:#9AA79E;font-weight:bold;margin-bottom:3px">Employee</div>
<div><b>Full Name:</b> ${esc(staff.name)}</div>
<div><b>NRIC / FIN:</b> ${esc(staff.nric_full)}</div>
<div><b>Bank &amp; Account:</b> ${esc(bank)}</div>
<div><b>Contact No.:</b> ${fContact}</div>
</td>
</tr></table>
<div style="letter-spacing:1px;text-transform:uppercase;color:#3D5240;font-weight:bold;margin:14px 0 6px">Employment Details</div>
<table style="width:100%"><tr>
<td style="width:50%;vertical-align:top;padding-right:16px"><div><b>Position / Role:</b> ${esc(staff.role)}</div><div><b>Employment Type:</b> Part-Time</div></td>
<td style="width:50%;vertical-align:top"><div><b>Hourly Rate (SGD):</b> ${rate?'$'+rate:''}</div></td>
</tr></table>
<div style="letter-spacing:1px;text-transform:uppercase;color:#3D5240;font-weight:bold;margin:14px 0 6px">Terms and Conditions</div>
${terms}
<div style="letter-spacing:1px;text-transform:uppercase;color:#3D5240;font-weight:bold;margin:16px 0 6px">Signatures</div>
<div style="font-size:10px;color:#5B6B60;margin-bottom:8px">By signing below, both parties confirm they have read, understood, and agree to the terms of this contract.</div>
<table style="width:100%"><tr>
<td style="width:50%;vertical-align:top;padding-right:30px">${empSig}<div style="border-top:1px solid #1E2A22;padding-top:3px;font-size:9px;color:#5B6B60">Authorised Signatory</div><div style="font-weight:bold;margin-top:3px">${esc(empName)}</div></td>
<td style="width:50%;vertical-align:top">${fSig}<div style="border-top:1px solid #1E2A22;padding-top:3px;font-size:9px;color:#5B6B60">Employee's Signature</div><div style="margin-top:4px">Name &amp; NRIC: ${fNric}</div><div style="margin-top:6px">Date: ${fEmpDate}</div></td>
</tr></table>
</div>`;
}

router.post('/send', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const key = process.env.DOCUSEAL_API_KEY;
  if (!key) return res.status(400).json({ error: 'DocuSeal is not connected. Add DOCUSEAL_API_KEY to Mise\u2019s environment variables first.' });
  const { staffId, companyId, email } = req.body;
  if (!staffId || !companyId || !email) return res.status(400).json({ error: 'Employee, company and email are all required.' });
  try {
    const s = db.get('SELECT * FROM staff WHERE id=?', [staffId]);
    const company = db.get('SELECT id,name,uen,address FROM companies WHERE id=?', [companyId]);
    if (!s || !company) return res.status(404).json({ error: 'Staff or company not found.' });
    const staff = {
      name: s.name, role: s.role, hourly_rate: s.hourly_rate,
      nric_full: db.decryptField(s.nric_full_enc) || '',
      bank_name: s.bank_name || '', bank_account: db.decryptField(s.bank_account_enc) || '',
    };
    const sigRow = db.get(`SELECT value FROM app_settings WHERE key='employer_signature'`);
    const sig = sigRow ? JSON.parse(sigRow.value) : { image: null, name: '', designation: '' };

    const html = buildContractHtml(staff, company, sig);
    const api = process.env.DOCUSEAL_API_URL || 'https://api.docuseal.com';
    const resp = await fetch(api + '/submissions/html', {
      method: 'POST',
      headers: { 'X-Auth-Token': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Employment Contract \u2014 ' + staff.name,
        send_email: true,
        documents: [{ name: 'Employment Contract', html, size: 'A4' }],
        submitters: [{ role: 'Employee', name: staff.name, email }],
      }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = (data && (data.error || data.message)) || ('DocuSeal returned status ' + resp.status);
      return res.status(502).json({ error: msg, detail: data });
    }
    // Log the sent contract in Mise (DocuSeal holds the document itself)
    try {
      const first = Array.isArray(data) ? data[0] : null;
      db.run(
        `INSERT INTO contracts (staff_id, staff_name, company_id, company_name, email, submission_id, slug, status, sent_by, sent_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [staffId, staff.name, companyId, company.name, email,
         first && first.submission_id ? first.submission_id : null,
         first && first.slug ? first.slug : null,
         'sent', req.session?.user?.username || '', new Date().toISOString()]
      );
    } catch(e) { /* logging shouldn't block the send */ }
    res.json({ success: true, submission: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sent-contracts log (refreshes signing status from DocuSeal) ───────────────
router.get('/list', async (req, res) => {
  try {
    const rows = db.all('SELECT * FROM contracts ORDER BY sent_at DESC');
    const key = process.env.DOCUSEAL_API_KEY;
    if (key) {
      const api = process.env.DOCUSEAL_API_URL || 'https://api.docuseal.com';
      const pending = rows.filter(r => r.submission_id && r.status !== 'completed' && r.status !== 'declined' && r.status !== 'expired').slice(0, 30);
      for (const c of pending) {
        try {
          const r = await fetch(api + '/submissions/' + c.submission_id, { headers: { 'X-Auth-Token': key } });
          if (!r.ok) continue;
          const s = await r.json();
          let status = s.status || c.status;
          const subs = s.submitters || [];
          if (!s.status && subs.length && subs.every(x => x.completed_at)) status = 'completed';
          const signedAt = s.completed_at || (subs.find(x => x.completed_at)||{}).completed_at || null;
          if (status !== c.status || (signedAt && !c.signed_at)) {
            db.run('UPDATE contracts SET status=?, signed_at=? WHERE id=?', [status, signedAt, c.id]);
            c.status = status; c.signed_at = signedAt;
          }
        } catch(e) { /* keep stored status */ }
      }
    }
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
