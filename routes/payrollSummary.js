'use strict';
const express    = require('express');
const PDFDocument = require('pdfkit');
const XLSX       = require('xlsx');
const router     = express.Router();
const db         = require('../database');

// ── Helper: compute payroll for all staff in a period ──────────────────────────
function computeAllPayroll(from, to, outletId, staffId) {
  const staff = db.all(`SELECT * FROM staff WHERE is_active=1`);
  const { computeShiftCost, computeCPF, decryptField } = db;
  const results = [];

  for (const s of staff) {
    if (staffId && String(s.id) !== String(staffId)) continue;
    let sql = `SELECT * FROM attendance WHERE staff_id=? AND substr(clock_in,1,10)>=? AND substr(clock_in,1,10)<=? AND clock_out IS NOT NULL`;
    const params = [s.id, from, to];
    if (outletId) { sql += ` AND outlet_id=?`; params.push(outletId); }
    const records = db.all(sql, params);
    if (!records.length) continue;

    let totalHours = 0, grossPay = 0, regularHours = 0, otHours = 0, phHours = 0;

    for (const r of records) {
      const hrs = r.total_hours || 0;
      totalHours += hrs;
      if (r.is_public_holiday) phHours += hrs;

      if (s.staff_type === 'parttime') {
        const rate = s.hourly_rate || 0;
        grossPay += r.is_public_holiday ? hrs * rate * 1.5 : hrs * rate;
        regularHours += r.is_public_holiday ? 0 : hrs;
      } else {
        const salary = s.monthly_salary || 0;
        const heq    = salary / 26 / 8;
        if (salary > 2600) {
          grossPay = salary;
          regularHours += hrs;
        } else {
          const reg = Math.min(hrs, 8), ot = Math.max(0, hrs - 8);
          grossPay += reg * heq + ot * heq * 1.5;
          regularHours += reg; otHours += ot;
        }
      }
    }

    grossPay = Math.round(grossPay * 100) / 100;
    const cpf = grossPay > 50 ? computeCPF(s, grossPay, to) : null;

    results.push({
      id:           s.id,
      name:         s.name,
      role:         s.role,
      staff_type:   s.staff_type,
      nric_last4:   s.nric_last4 || '',
      shifts:       records.length,
      totalHours:   Math.round(totalHours * 100) / 100,
      regularHours: Math.round(regularHours * 100) / 100,
      otHours:      Math.round(otHours * 100) / 100,
      phHours:      Math.round(phHours * 100) / 100,
      grossPay,
      empCPF:       cpf ? cpf.empCPF   : 0,
      erCPF:        cpf ? cpf.erCPF    : 0,
      netPay:       cpf ? cpf.netPay   : grossPay,
      hasCPF:       !!cpf,
    });
  }

  return results;
}

// Staff detail with punch cards
router.get('/detail/:staffId', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const s = db.get('SELECT * FROM staff WHERE id=?', [req.params.staffId]);
  if (!s) return res.status(404).json({ error: 'Staff not found' });
  const records = db.all(
    `SELECT a.*, o.name as outlet_name FROM attendance a
     LEFT JOIN outlets o ON a.outlet_id=o.id
     WHERE a.staff_id=? AND substr(a.clock_in,1,10)>=? AND substr(a.clock_in,1,10)<=?
     ORDER BY a.clock_in`,
    [req.params.staffId, from, to]
  );
  // Outlet summary
  const outletMap = {};
  records.forEach(r => {
    const k = r.outlet_id || 0;
    if (!outletMap[k]) outletMap[k] = { name: r.outlet_name||'Unknown', shifts:0, hours:0, cost:0 };
    outletMap[k].shifts++;
    outletMap[k].hours += r.total_hours||0;
    outletMap[k].cost += r.total_cost||0;
  });
  res.json({ records, outletSummary: Object.values(outletMap) });
});

// ── JSON preview ───────────────────────────────────────────────────────────────
router.get('/summary', (req, res) => {
  const { from, to } = req.query;
  const outletId = req.query.outlet_id || req.query.outletId;
  const staffId  = req.query.staff_id  || req.query.staffId;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  try {
    const rows = computeAllPayroll(from, to, outletId, staffId);
    const totals = rows.reduce((acc, r) => ({
      totalHours: acc.totalHours + r.totalHours,
      grossPay:   acc.grossPay  + r.grossPay,
      empCPF:     acc.empCPF    + r.empCPF,
      erCPF:      acc.erCPF     + r.erCPF,
      netPay:     acc.netPay    + r.netPay,
    }), { totalHours: 0, grossPay: 0, empCPF: 0, erCPF: 0, netPay: 0 });
    res.json({ rows, totals, from, to });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Excel export ───────────────────────────────────────────────────────────────
router.get('/export/excel', (req, res) => {
  const { from, to } = req.query;
  const outletId  = req.query.outlet_id  || req.query.outletId;
  const companyId = req.query.company_id || req.query.companyId;
  const staffId   = req.query.staff_id   || req.query.staffId;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  try {
    const rows = computeAllPayroll(from, to, outletId, staffId);
    const wb   = XLSX.utils.book_new();

    // Main payroll sheet
    const headers = [
      'Name','Role','Type','NRIC Last 4','Shifts','Total Hours',
      'Regular Hours','OT Hours','PH Hours',
      'Gross Pay ($)','Employee CPF ($)','Net Pay ($)','Employer CPF ($)'
    ];
    const data = rows.map(r => [
      r.name, r.role,
      r.staff_type === 'fulltime' ? 'Full-time' : 'Part-time',
      r.nric_last4,
      r.shifts, r.totalHours, r.regularHours, r.otHours, r.phHours,
      r.grossPay, r.empCPF, r.netPay, r.erCPF,
    ]);

    // Totals row
    const totals = rows.reduce((a, r) => ({
      hrs: a.hrs + r.totalHours, gross: a.gross + r.grossPay,
      emp: a.emp + r.empCPF, net: a.net + r.netPay, er: a.er + r.erCPF
    }), { hrs:0, gross:0, emp:0, net:0, er:0 });

    data.push([]);
    data.push(['TOTAL','','','','',
      Math.round(totals.hrs*100)/100,'','','',
      Math.round(totals.gross*100)/100,
      Math.round(totals.emp*100)/100,
      Math.round(totals.net*100)/100,
      Math.round(totals.er*100)/100,
    ]);

    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    ws['!cols'] = headers.map((h,i) => ({ wch: i === 0 ? 24 : 14 }));

    // Style header row bold (basic)
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
      if (cell) cell.s = { font: { bold: true }, fill: { fgColor: { rgb: '3D5240' } } };
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Payroll Summary');

    // Meta sheet
    const metaWs = XLSX.utils.aoa_to_sheet([
      ['Payroll Summary'],
      ['Pay Period', `${from} to ${to}`],
      ['Generated', new Date().toLocaleString('en-SG')],
      ['Staff count', rows.length],
      [''],
      ['Note: Employer CPF is for company records only — not deducted from staff pay.'],
      ['This is a computer-generated document. Not a tax document.'],
    ]);
    XLSX.utils.book_append_sheet(wb, metaWs, 'Info');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="mise_payroll_${from}_${to}.xlsx"`);
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PDF export ─────────────────────────────────────────────────────────────────
router.get('/export/pdf', (req, res) => {
  const { from, to } = req.query;
  const outletId  = req.query.outlet_id  || req.query.outletId;
  const companyId = req.query.company_id || req.query.companyId;
  const staffId   = req.query.staff_id   || req.query.staffId;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  try {
    const rows = computeAllPayroll(from, to, outletId, staffId);
    const doc  = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="mise_payroll_${from}_${to}.pdf"`);
    doc.pipe(res);

    const GREEN = '#3D5240';
    const W     = doc.page.width - 80;

    // ── Header ──
    let hy = 40;
    doc.fontSize(18).font('Helvetica-Bold').fillColor(GREEN)
       .text('Mise — Payroll Summary', 40, hy);
    hy += 26;

    const outletName = outletId ? db.get('SELECT name FROM outlets WHERE id=?',[outletId])?.name : 'All outlets';
    const company = companyId ? db.get('SELECT name,uen FROM companies WHERE id=?',[companyId]) : null;
    if (company) {
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#1B3A5C').text(company.name, 40, hy);
      hy += 16;
    }
    const metaParts = [];
    if (company && company.uen && company.uen !== 'TBC') metaParts.push(`UEN: ${company.uen}`);
    metaParts.push(`Pay period: ${from} to ${to}`);
    metaParts.push(`Outlet: ${outletName}`);
    metaParts.push(`Generated: ${new Date().toLocaleDateString('en-SG')}`);
    metaParts.push(`${rows.length} staff`);
    doc.fontSize(9).font('Helvetica').fillColor('#555').text(metaParts.join('   |   '), 40, hy);
    hy += 15;
    doc.moveTo(40, hy).lineTo(doc.page.width - 40, hy).strokeColor(GREEN).lineWidth(1.5).stroke();
    hy += 8;

    // Table
    const cols = [
      { label: 'Name',         w: 170 },
      { label: 'Role',         w: 50  },
      { label: 'Type',         w: 58  },
      { label: 'Shifts',       w: 42  },
      { label: 'Hours',        w: 50  },
      { label: 'OT hrs',       w: 50  },
      { label: 'Gross Pay',    w: 70  },
      { label: 'Emp CPF (–)',  w: 72  },
      { label: 'Net Pay',      w: 70  },
      { label: 'Er CPF*',      w: 64  },
    ];

    function drawColHeader(yy) {
      doc.rect(40, yy, W, 17).fill(GREEN);
      let xx = 40;
      cols.forEach(c => {
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff')
           .text(c.label, xx + 4, yy + 5, { width: c.w - 8, ellipsis: true });
        xx += c.w;
      });
      return yy + 17;
    }

    let y = drawColHeader(hy);

    // Data rows
    rows.forEach((r, i) => {
      const vals = [
        r.name, r.role,
        r.staff_type === 'fulltime' ? 'Full-time' : 'Part-time',
        r.shifts,
        r.totalHours.toFixed(2),
        r.otHours > 0 ? r.otHours.toFixed(2) : '—',
        '$' + r.grossPay.toFixed(2),
        r.hasCPF ? '–$' + r.empCPF.toFixed(2) : '—',
        '$' + r.netPay.toFixed(2),
        r.hasCPF ? '$' + r.erCPF.toFixed(2) : '—',
      ];

      // Row height driven by the tallest wrapping cell (the name)
      doc.fontSize(8).font('Helvetica');
      const nameH = doc.heightOfString(String(r.name), { width: cols[0].w - 8 });
      const rowH  = Math.max(16, nameH + 8);

      // Page break: start a fresh page and redraw the column header
      if (y + rowH > doc.page.height - 46) {
        doc.addPage();
        y = drawColHeader(40);
      }

      const bg = i % 2 === 0 ? '#F5F7F2' : '#fff';
      doc.rect(40, y, W, rowH).fill(bg);

      let x = 40;
      cols.forEach((c, ci) => {
        const txt   = String(vals[ci]);
        const cellH = doc.heightOfString(txt, { width: c.w - 8 });
        const ty    = y + Math.max(3, (rowH - cellH) / 2);
        doc.fontSize(8).font('Helvetica').fillColor('#222')
           .text(txt, x + 4, ty, { width: c.w - 8, ellipsis: ci !== 0 });
        x += c.w;
      });
      y += rowH;
    });

    // Totals row
    const tot = rows.reduce((a,r) => ({
      hrs: a.hrs+r.totalHours, ot: a.ot+r.otHours,
      gross: a.gross+r.grossPay, emp: a.emp+r.empCPF,
      net: a.net+r.netPay, er: a.er+r.erCPF
    }), {hrs:0,ot:0,gross:0,emp:0,net:0,er:0});

    if (y + 18 > doc.page.height - 46) { doc.addPage(); y = drawColHeader(40); }
    y += 2;
    doc.rect(40, y, W, 17).fill('#E8EDE3');
    let tx = 40;
    const totVals = [
      'TOTAL', '', '', rows.length + ' staff',
      tot.hrs.toFixed(2), tot.ot.toFixed(2),
      '$'+Math.round(tot.gross*100)/100,
      '–$'+Math.round(tot.emp*100)/100,
      '$'+Math.round(tot.net*100)/100,
      '$'+Math.round(tot.er*100)/100,
    ];
    cols.forEach((c, ci) => {
      doc.fontSize(8).font('Helvetica-Bold').fillColor(GREEN)
         .text(totVals[ci], tx + 4, y + 5, { width: c.w - 8 });
      tx += c.w;
    });

    // Footer
    const fy = doc.page.height - 36;
    doc.moveTo(40, fy).lineTo(doc.page.width-40, fy).strokeColor('#ccc').lineWidth(0.5).stroke();
    doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#999')
       .text('* Employer CPF is for company records only and is not deducted from staff pay.   This is a computer-generated document. Not a tax document.', 40, fy + 6);

    doc.end();
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Entity assignments ────────────────────────────────────────────────────────
router.get('/entity-assignments', (req, res) => {
  const { year, month } = req.query;
  try {
    const assignments = db.all(
      `SELECT sea.staff_id, sea.company_id, s.name as staff_name, c.name as company_name, c.uen
       FROM staff_entity_assignments sea
       JOIN staff s ON sea.staff_id=s.id
       JOIN companies c ON sea.company_id=c.id
       WHERE sea.year=? AND sea.month=?`,
      [year, month]
    );
    res.json(assignments);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/entity-assignments', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { assignments, year, month } = req.body; // [{staffId, companyId}]
  try {
    assignments.forEach(({ staffId, companyId }) => {
      const existing = db.get('SELECT id FROM staff_entity_assignments WHERE staff_id=? AND year=? AND month=?', [staffId, year, month]);
      if (existing) {
        if (companyId) db.run('UPDATE staff_entity_assignments SET company_id=? WHERE id=?', [companyId, existing.id]);
        else db.run('DELETE FROM staff_entity_assignments WHERE id=?', [existing.id]);
      } else if (companyId) {
        db.run('INSERT INTO staff_entity_assignments (staff_id, company_id, year, month) VALUES (?,?,?,?)', [staffId, companyId, year, month]);
      }
    });
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
