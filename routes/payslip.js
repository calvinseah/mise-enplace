'use strict';
const express = require('express');
const PDFDocument = require('pdfkit');
const router = express.Router();
const db = require('../database');

const COMPANY_NAME = 'Mise';
const COMPANY_ADDRESS = '';
const NAVY = '#1A2318';
 const GREEN = '#3D5240';
const LIGHT_GREEN = '#C8D5B9';
const WARM = '#3D5240';
const DARK = '#1A2318';

// ─── PREVIEW payslip data (JSON) ─────────────────────────────────────────────
router.get('/preview', (req, res) => {
  try {
    const data = computePayslip(req.query);
    if (req.query.companyId) {
      const co = db.get('SELECT name, uen FROM companies WHERE id=?', [req.query.companyId]);
      if (co) { data.companyName = co.name; data.companyUen = co.uen; }
    }
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── DOWNLOAD payslip PDF ─────────────────────────────────────────────────────
router.get('/download', (req, res) => {
  try {
    const data = computePayslip(req.query);
    if (req.query.companyId) {
      const co = db.get('SELECT name, uen FROM companies WHERE id=?', [req.query.companyId]);
      if (co) { data.companyName = co.name; data.companyUen = co.uen; }
    }
    const { staffName } = data;
    const safeName = staffName.replace(/[^a-z0-9]/gi, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_payslip.pdf"`);

    generatePDF(data, res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── COMPUTE PAYSLIP DATA ─────────────────────────────────────────────────────

// ── SHG contribution calculator ───────────────────────────────────────────────
function getSHGName(race) {
  race = (race || '').toLowerCase();
  if (race === 'chinese') return 'CDAC';
  if (race === 'malay') return 'MBMF';
  if (race === 'indian') return 'SINDA';
  if (race === 'eurasian') return 'ECF';
  return null;
}

function getSHGAmount(race, ow) {
  race = (race || '').toLowerCase();
  if (race === 'chinese') {
    if (ow <= 2000) return 0.50;
    if (ow <= 3500) return 1.00;
    if (ow <= 5000) return 1.50;
    return 2.00;
  }
  if (race === 'malay') {
    if (ow <= 1000) return 1.00;
    if (ow <= 2000) return 2.00;
    if (ow <= 3000) return 3.00;
    if (ow <= 4000) return 4.00;
    return 5.00;
  }
  if (race === 'indian') {
    if (ow <= 2000) return 0.50;
    if (ow <= 3500) return 1.00;
    if (ow <= 5000) return 2.00;
    return 3.00;
  }
  if (race === 'eurasian') {
    if (ow <= 5000) return 0;
    return 2.00;
  }
  return 0;
}

function computeExtras(staff, grossPay, cpf) {
  const cpfExempt = !!staff.cpf_exempt;
  const sdlAmount = Math.min(11.25, Math.max(2, Math.round(grossPay * 0.0025 * 100) / 100));
  const shgName   = !cpfExempt ? getSHGName(staff.race) : null;
  const shgAmount = (!cpfExempt && shgName) ? getSHGAmount(staff.race, grossPay) : 0;
  const effectiveCPF = cpfExempt
    ? { empCPF: 0, erCPF: 0, employee: 0, employer: 0, total: 0, eligible: false }
    : cpf
      ? { ...cpf, employee: cpf.empCPF || 0, employer: cpf.erCPF || 0 }
      : { empCPF: 0, erCPF: 0, employee: 0, employer: 0, total: 0, eligible: false };
  const netPay = Math.round((grossPay - (effectiveCPF.empCPF || effectiveCPF.employee || 0) - shgAmount) * 100) / 100;
  return { cpfExempt, sdlAmount, shgName, shgAmount, effectiveCPF, netPay };
}

function computePayslip({ staffId, from, to }) {
  if (!staffId || !from || !to) throw new Error('staffId, from, and to required');

  const staff = db.get(`SELECT * FROM staff WHERE id = ?`, [staffId]);
  if (!staff) throw new Error('Staff not found');

  const records = db.all(
    `SELECT a.*, ph.name as holiday_name, o.name as outlet_name
     FROM attendance a
     LEFT JOIN public_holidays ph ON substr(a.clock_in, 1, 10) = ph.date
     LEFT JOIN outlets o ON a.outlet_id = o.id
     WHERE a.staff_id = ? AND substr(a.clock_in,1,10) >= ? AND substr(a.clock_in,1,10) <= ?
       AND a.clock_out IS NOT NULL
     ORDER BY a.clock_in`,
    [staffId, from, to]
  );

  // Collect distinct outlets worked
  const outletSet = new Set(records.map(r => r.outlet_name).filter(Boolean));
  const outlets = [...outletSet].join(', ') || null;

  const { computeShiftCost, computeCPF } = require('../database');

  if (staff.staff_type === 'parttime') {
    return computeParttimePayslip(staff, records, from, to, computeShiftCost, computeCPF, outlets);
  } else {
    return computeFulltimePayslip(staff, records, from, to, computeShiftCost, computeCPF, outlets);
  }
}

function computeParttimePayslip(staff, records, from, to, computeShiftCost, computeCPF, outlets) {
  const regularShifts = [];
  const phShifts = [];
  let totalHours = 0;
  let grossPay = 0;

  for (const r of records) {
    const hours = r.total_hours || 0;
    const isPH = r.is_public_holiday === 1;
    const { cost, rate } = computeShiftCost(staff, hours, isPH);
    totalHours += hours;
    grossPay += cost;

    const shift = {
      id: r.id,
      date: r.clock_in.slice(0, 10),
      clockIn: r.clock_in,
      clockOut: r.clock_out,
      breakMinutes: r.break_minutes,
      hours,
      rate,
      amount: cost,
      isAmended: r.is_amended,
      notes: r.notes
    };

    if (isPH) {
      shift.holidayName = r.holiday_name || 'Public Holiday';
      phShifts.push(shift);
    } else {
      regularShifts.push(shift);
    }
  }

  grossPay = Math.round(grossPay * 100) / 100;

  // CPF — only if gross > $50
  let cpf = null;
  if (grossPay > 50) {
    cpf = computeCPF(staff, grossPay, to);
  }

  const extras = computeExtras(staff, grossPay, cpf);
  return {
    staff_type: 'parttime',
    staffId: staff.id,
    staffName: staff.name,
    role: staff.role,
    nricLast4: staff.nric_last4,
    prStatus: staff.pr_status,
    from, to,
    regularShifts,
    phShifts,
    totalHours: Math.round(totalHours * 100) / 100,
    grossPay,
    cpf: extras.effectiveCPF,
    employeeCPF: extras.effectiveCPF.empCPF || extras.effectiveCPF.employee || 0,
    employerCPF: extras.effectiveCPF.erCPF || extras.effectiveCPF.employer || 0,
    netPay: extras.netPay,
    sdlAmount: extras.sdlAmount,
    shgName: extras.shgName,
    shgAmount: extras.shgAmount,
    cpfExempt: extras.cpfExempt,
    hourlyRate: staff.hourly_rate
  };
}

function computeFulltimePayslip(staff, records, from, to, computeShiftCost, computeCPF, outlets) {
  const salary = staff.monthly_salary || 0;
  const isHighEarner = salary > 2600;
  const hourlyEquiv = salary / 26 / 8;

  const shifts = [];
  let totalHours = 0;
  let otHours = 0;
  let phShifts = [];
  let otPay = 0;

  for (const r of records) {
    const hours = r.total_hours || 0;
    const isPH = r.is_public_holiday === 1;
    const { cost, otHours: ot } = computeShiftCost(staff, hours, isPH);
    totalHours += hours;
    if (ot) otHours += ot;

    const shift = {
      id: r.id,
      date: r.clock_in.slice(0, 10),
      clockIn: r.clock_in,
      clockOut: r.clock_out,
      breakMinutes: r.break_minutes,
      hours,
      isPH,
      holidayName: r.holiday_name,
      isAmended: r.is_amended,
      notes: r.notes
    };
    shifts.push(shift);
    if (isPH) phShifts.push(shift);
  }

  let grossPay;
  if (isHighEarner) {
    grossPay = salary;
    otPay = 0;
  } else {
    // Base + OT
    const regularHoursAll = Math.max(0, totalHours - otHours);
    otPay = Math.round(otHours * hourlyEquiv * 1.5 * 100) / 100;
    grossPay = Math.round((salary + otPay) * 100) / 100;
  }

  const rawCpf = computeCPF(staff, grossPay, to);
  const extras = computeExtras(staff, grossPay, rawCpf);

  return {
    staff_type: 'fulltime',
    staffId: staff.id,
    staffName: staff.name,
    role: staff.role,
    nricLast4: staff.nric_last4,
    prStatus: staff.pr_status,
    from, to,
    salary,
    isHighEarner,
    hourlyEquiv: Math.round(hourlyEquiv * 100) / 100,
    shifts,
    phShifts,
    totalHours: Math.round(totalHours * 100) / 100,
    otHours: Math.round(otHours * 100) / 100,
    otPay,
    grossPay,
    cpf: extras.effectiveCPF,
    employeeCPF: extras.effectiveCPF.empCPF || extras.effectiveCPF.employee || 0,
    employerCPF: extras.effectiveCPF.erCPF || extras.effectiveCPF.employer || 0,
    netPay: extras.netPay,
    sdlAmount: extras.sdlAmount,
    shgName: extras.shgName,
    shgAmount: extras.shgAmount,
    cpfExempt: extras.cpfExempt,
    daysPresent: new Set(shifts.map(s => s.date)).size
  };
}

// ─── PDF GENERATION ───────────────────────────────────────────────────────────
function generatePDF(data, stream) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(stream);

  const W = doc.page.width - 100; // usable width

  // ── Header: dark green banner ──
  const headerName = data.companyName || COMPANY_NAME;
  const pageW = doc.page.width;

  // Banner background
  doc.rect(0, 0, pageW, 90).fill('#1A2318');

  // Company name
  doc.fontSize(20).fillColor('#ffffff').font('Helvetica-Bold').text(headerName, 50, 22);

  // UEN
  if (data.companyUen && data.companyUen !== 'TBC') {
    doc.fontSize(9).fillColor('rgba(255,255,255,0.5)').font('Helvetica').text(`UEN: ${data.companyUen}`, 50, 47);
  }

  // PAYSLIP badge top right
  doc.fontSize(11).fillColor('#C8D5B9').font('Helvetica-Bold').text('PAYSLIP', 0, 35, { align: 'right', width: pageW - 50 });

  // ── Staff Info block ──
  let y = 110;

  // Two-column info layout
  const colL = 50, colR = 320;
  const infoLeft = [
    ['EMPLOYEE', data.staffName],
    ['ROLE', data.role + ' · ' + (data.staff_type === 'fulltime' ? 'Full-time' : 'Part-time')],
    ...(data.nricLast4 ? [['NRIC', `****${data.nricLast4}`]] : []),
    ['CITIZENSHIP', (data.prStatus||'').toUpperCase()],
    ...(data.outlets ? [['OUTLET', data.outlets]] : []),
  ];
  const infoRight = [
    ['PAY PERIOD', `${fmtDate(data.from)} – ${fmtDate(data.to)}`],
    ['GENERATED', new Date().toLocaleDateString('en-SG', { day:'2-digit', month:'short', year:'numeric' })],
  ];

  let yL = y, yR = y;
  for (const [label, val] of infoLeft) {
    doc.fontSize(7.5).fillColor('#888').font('Helvetica-Bold').text(label, colL, yL);
    doc.fontSize(10).fillColor('#1A2318').font('Helvetica').text(val, colL, yL + 10);
    yL += 28;
  }
  for (const [label, val] of infoRight) {
    doc.fontSize(7.5).fillColor('#888').font('Helvetica-Bold').text(label, colR, yR);
    doc.fontSize(10).fillColor('#1A2318').font('Helvetica').text(val, colR, yR + 10);
    yR += 28;
  }

  y = Math.max(yL, yR) + 8;
  doc.moveTo(50, y).lineTo(pageW - 50, y).strokeColor('#E8EDE3').lineWidth(1).stroke();
  y += 14;

  // ── Shifts ──
  if (data.staff_type === 'parttime') {
    y = drawParttimeShifts(doc, data, y, W);
  } else {
    y = drawFulltimeSection(doc, data, y, W);
  }

  // ── CPF Section ──
  y = drawCPFSection(doc, data, y, W);

  // ── Footer ──
  const footerY = doc.page.height - 60;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).strokeColor('#ddd').lineWidth(1).stroke();
  doc.fontSize(8).fillColor('#999').font('Helvetica-Oblique')
    .text('This is a computer-generated payslip. This is not a tax document.', 50, footerY + 8, { align: 'center', width: W });

  doc.end();
}

function drawParttimeShifts(doc, data, y, W) {
  // Regular shifts
  if (data.regularShifts.length > 0) {
    y = sectionHeader(doc, 'Regular Shifts', y);
    y = tableHeader(doc, ['Date', 'Clock In', 'Clock Out', 'Break', 'Hours', 'Rate/hr', 'Amount'], y, W);
    for (const s of data.regularShifts) {
      y = tableRow(doc, [
        fmtDate(s.date),
        fmtTime(s.clockIn),
        fmtTime(s.clockOut),
        `${s.breakMinutes}m`,
        s.hours.toFixed(2),
        `$${s.rate.toFixed(2)}`,
        `$${s.amount.toFixed(2)}`
      ], y, W, s.isAmended);
      if (s.notes) {
        doc.fontSize(7).fillColor(WARM).font('Helvetica-Oblique').text(`  Note: ${s.notes}`, 55, y); y += 12;
      }
    }
  }

  // Public holiday shifts
  if (data.phShifts.length > 0) {
    y += 8;
    y = sectionHeader(doc, 'Public Holiday Shifts (1.5× Rate)', y, WARM);
    y = tableHeader(doc, ['Date', 'Holiday', 'Clock In', 'Clock Out', 'Hours', 'Rate/hr', 'Amount'], y, W);
    for (const s of data.phShifts) {
      y = tableRow(doc, [
        fmtDate(s.date),
        s.holidayName,
        fmtTime(s.clockIn),
        fmtTime(s.clockOut),
        s.hours.toFixed(2),
        `$${s.rate.toFixed(2)}`,
        `$${s.amount.toFixed(2)}`
      ], y, W, s.isAmended);
    }
  }

  // Totals
  y += 10;
  totalsBox(doc, [
    ['Total Hours Worked', `${data.totalHours.toFixed(2)} hrs`],
    ['Gross Pay', `$${data.grossPay.toFixed(2)}`],
  ], y, W);
  y += 50;
  return y;
}

function drawFulltimeSection(doc, data, y, W) {
  y = sectionHeader(doc, 'Attendance Summary', y);

  if (data.isHighEarner) {
    // Fixed salary
    doc.fontSize(10).fillColor('#333').font('Helvetica')
      .text(`Fixed Monthly Salary: `, 50, y)
      .font('Helvetica-Bold').text(`$${data.salary.toFixed(2)}`, 200, y);
    y += 18;
    doc.font('Helvetica').text(`Days Present: ${data.daysPresent}`, 50, y); y += 18;

    if (data.phShifts.length > 0) {
      y += 6;
      y = sectionHeader(doc, 'Public Holiday Shifts (Manual — See Notes)', y, WARM);
      y = tableHeader(doc, ['Date', 'Holiday', 'Hours', 'Notes'], y, W);
      for (const s of data.phShifts) {
        y = tableRow(doc, [
          fmtDate(s.date), s.holidayName || '—', s.hours.toFixed(2), s.notes || 'To be handled by manager'
        ], y, W, false);
      }
    }

    totalsBox(doc, [
      ['Days Present', String(data.daysPresent)],
      ['Gross Pay (Fixed)', `$${data.grossPay.toFixed(2)}`],
    ], y + 10, W);
    y += 60;
  } else {
    // OT applies
    y = tableHeader(doc, ['Date', 'Clock In', 'Clock Out', 'Hours', 'OT hrs', 'PH?', 'Notes'], y, W);
    for (const s of data.shifts) {
      y = tableRow(doc, [
        fmtDate(s.date),
        fmtTime(s.clockIn),
        fmtTime(s.clockOut),
        s.hours.toFixed(2),
        s.isPH ? '—' : (computeOTHrs(s.hours) > 0 ? computeOTHrs(s.hours).toFixed(2) : '—'),
        s.isPH ? '✓' : '—',
        s.notes || '—'
      ], y, W, s.isAmended);
    }

    y += 10;
    totalsBox(doc, [
      ['Base Salary', `$${data.salary.toFixed(2)}`],
      [`OT (${data.otHours.toFixed(2)} hrs @ 1.5×)`, `+$${data.otPay.toFixed(2)}`],
      ['Gross Pay', `$${data.grossPay.toFixed(2)}`],
    ], y, W);
    y += 65;
  }
  return y;
}

function drawCPFSection(doc, data, y, W) {
  y += 8;
  y = sectionHeader(doc, 'Deductions', y);

  const rows = [['Gross Pay', `$${data.grossPay.toFixed(2)}`]];

  if (data.cpfExempt) {
    rows.push(['CPF Exempt', '—']);
  } else if (data.employeeCPF > 0) {
    const cpfRates = data.cpf || {};
    const rate = cpfRates.rates?.employee_rate || '';
    rows.push([`Employee CPF${rate ? ' (' + rate + '%)' : ''} (–)`, `–$${data.employeeCPF.toFixed(2)}`]);
  }
  if (data.shgAmount > 0 && data.shgName) {
    rows.push([`${data.shgName} (–)`, `–$${data.shgAmount.toFixed(2)}`]);
  }
  rows.push(['Net Pay (Take-Home)', `$${(data.netPay || data.grossPay).toFixed(2)}`]);

  // Employer contributions
  if (data.employerCPF > 0) {
    const erRate = (data.cpf || {}).rates?.employer_rate || '';
    rows.push([`Employer CPF${erRate ? ' (' + erRate + '%)' : ''} *`, `$${data.employerCPF.toFixed(2)}`]);
  }
  if (data.sdlAmount > 0) {
    rows.push(['SDL (Skills Development Levy) *', `$${data.sdlAmount.toFixed(2)}`]);
  }

  summaryBox(doc, rows, y, W);
  y += 20 * rows.length + 15;

  if (data.employerCPF > 0 || data.sdlAmount > 0) {
    doc.fontSize(7.5).fillColor('#999').font('Helvetica-Oblique')
      .text('* Employer contributions are for payroll records only and are not deducted from employee pay.', 50, y);
    y += 16;
  }
  return y;
}

// ─── PDF HELPERS ──────────────────────────────────────────────────────────────

function sectionHeader(doc, text, y, color = NAVY) {
  doc.fontSize(10).font('Helvetica-Bold').fillColor(color).text(text, 50, y);
  y += 14;
  doc.moveTo(50, y).lineTo(550, y).strokeColor(color).lineWidth(0.5).stroke();
  return y + 4;
}

const COL_CONFIGS = {
  7: [70, 65, 65, 40, 45, 55, 55],  // 7 cols
  4: [100, 120, 80, 245],            // 4 cols
  3: [120, 80, 245],
  2: [200, 255],
};

function getColWidths(n, W) {
  if (COL_CONFIGS[n]) return COL_CONFIGS[n];
  const w = Math.floor(W / n);
  return Array(n).fill(w);
}

function tableHeader(doc, cols, y, W) {
  const widths = getColWidths(cols.length, W);
  let x = 50;
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
  doc.rect(50, y, W, 15).fill(NAVY);
  for (let i = 0; i < cols.length; i++) {
    doc.fillColor('#fff').text(cols[i], x + 2, y + 3, { width: widths[i] - 4, ellipsis: true });
    x += widths[i];
  }
  return y + 16;
}

function tableRow(doc, vals, y, W, amended = false) {
  const widths = getColWidths(vals.length, W);
  let x = 50;
  const bg = amended ? '#FFF8F0' : (y % 32 < 16 ? '#F8F9FB' : '#fff');
  doc.rect(50, y, W, 14).fill(bg);
  doc.fontSize(8).font(amended ? 'Helvetica-Oblique' : 'Helvetica').fillColor(amended ? WARM : '#333');
  for (let i = 0; i < vals.length; i++) {
    doc.text(String(vals[i] || '—'), x + 2, y + 2, { width: widths[i] - 4, ellipsis: true });
    x += widths[i];
  }
  // bottom border
  doc.moveTo(50, y + 14).lineTo(50 + W, y + 14).strokeColor('#eee').lineWidth(0.3).stroke();
  return y + 15;
}

function totalsBox(doc, rows, y, W) {
  doc.rect(50, y, W, rows.length * 18 + 8).fill('#EEF2F7');
  let ty = y + 6;
  for (const [label, val] of rows) {
    const isBold = label.startsWith('Gross') || label.startsWith('Net');
    doc.fontSize(isBold ? 10 : 9)
       .font(isBold ? 'Helvetica-Bold' : 'Helvetica')
       .fillColor(isBold ? NAVY : '#333')
       .text(label, 60, ty)
       .text(val, 400, ty, { width: 140, align: 'right' });
    ty += 18;
  }
}

function summaryBox(doc, rows, y, W) {
  let sy = y;
  for (let i = 0; i < rows.length; i++) {
    const [label, val] = rows[i];
    const isNetPay = label.startsWith('Net Pay');
    const isEmpCPF = label.startsWith('Employee CPF');
    const bg = isNetPay ? NAVY : (i % 2 === 0 ? '#F8F9FB' : '#fff');
    const tc = isNetPay ? '#fff' : (isEmpCPF ? '#cc2200' : '#333');
    doc.rect(50, sy, W, 16).fill(bg);
    doc.fontSize(isNetPay ? 10 : 9)
       .font(isNetPay ? 'Helvetica-Bold' : 'Helvetica')
       .fillColor(tc)
       .text(label, 60, sy + 3)
       .text(val, 400, sy + 3, { width: 140, align: 'right' });
    sy += 17;
  }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(day)} ${months[parseInt(m) - 1]} ${y}`;
}

function fmtTime(dt) {
  if (!dt) return '—';
  try {
    return new Date(dt).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return dt.slice(11, 16); }
}

function computeOTHrs(hours) {
  return Math.max(0, hours - 8);
}

module.exports = router;
