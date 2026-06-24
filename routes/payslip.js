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
function fmtMoney(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function generatePDF(data, stream) {
  const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
  // Register custom fonts
  try { doc.registerFont('DMSerif', require('path').join(__dirname, '../fonts/DMSerif-Regular.ttf')); } catch(e) {}
  doc.pipe(stream);

  const PW = doc.page.width;
  const PH = doc.page.height;
  const ML = 45, MR = 45, MT = 0;
  const CW = PW - ML - MR;

  // ── Colors ──
  const INK    = '#1A2318';
  const GREEN  = '#3D5240';
  const SAGE   = '#C8D5B9';
  const SURFACE= '#F0F2EC';
  const MUTED  = '#888888';
  const DANGER = '#C0392B';
  const LINE   = '#E0E5DA';

  // ── Header banner ──
  doc.rect(0, 0, PW, 82).fill(INK);

  const coName = data.companyName || 'Mise';
  doc.fontSize(17).fillColor('#ffffff').font(doc._fontFamilies?.DMSerif ? 'DMSerif' : 'Helvetica-Bold').text(coName, ML, 20, { width: CW * 0.65 });
  if (data.companyUen && data.companyUen !== 'TBC') {
    doc.fontSize(8).fillColor(SAGE).font('Helvetica').text('UEN ' + data.companyUen, ML, 38);
  }
  doc.fontSize(9).fillColor(SAGE).font('Helvetica-Bold').text('PAYSLIP', 0, 32, { align: 'right', width: PW - MR });

  // ── Info grid ──
  let y = 88;
  const col1 = ML, col2 = ML + CW * 0.35, col3 = ML + CW * 0.65;

  function infoCell(label, value, x, cy, w) {
    doc.fontSize(7).fillColor(MUTED).font('Helvetica-Bold').text(label, x, cy, { width: w, characterSpacing: 0.3 });
    doc.fontSize(9).fillColor(INK).font('Helvetica').text(value || '—', x, cy + 9, { width: w });
  }

  infoCell('EMPLOYEE', data.staffName, col1, y, CW * 0.33);
  infoCell('PAY PERIOD', fmtDate(data.from) + ' – ' + fmtDate(data.to), col3, y, CW * 0.35);
  y += 26;
  infoCell('ROLE', (data.role||'') + ' · ' + (data.staff_type === 'fulltime' ? 'Full-time' : 'Part-time'), col1, y, CW * 0.33);
  infoCell('GENERATED', new Date().toLocaleDateString('en-SG', {day:'2-digit',month:'short',year:'numeric'}), col3, y, CW * 0.35);
  y += 26;
  if (data.nricLast4) { infoCell('NRIC', '****' + data.nricLast4, col1, y, CW * 0.33); }
  if (data.outlets)   { infoCell('OUTLET', data.outlets, col2, y, CW * 0.3); }
  y += 22;

  doc.moveTo(ML, y).lineTo(PW - MR, y).strokeColor(LINE).lineWidth(1).stroke();
  y += 12;

  // ── Section header helper ──
  function secHeader(label, cy) {
    doc.fontSize(7).fillColor(GREEN).font('Helvetica-Bold').text(label, ML, cy, { characterSpacing: 0.8 });
    doc.moveTo(ML, cy + 11).lineTo(PW - MR, cy + 11).strokeColor(LINE).lineWidth(0.8).stroke();
    return cy + 18;
  }

  // ── Line row helper ──
  function lineRow(label, value, cy, opts = {}) {
    const lColor = opts.net ? GREEN : opts.danger ? DANGER : opts.muted ? MUTED : INK;
    const vColor = opts.net ? GREEN : opts.danger ? DANGER : opts.muted ? MUTED : INK;
    const fw = opts.bold || opts.net ? 'Helvetica-Bold' : 'Helvetica';
    const fs = opts.net ? 10 : 9;
    if (opts.net) {
      doc.rect(ML, cy - 3, CW, 18).fill(SURFACE);
    }
    doc.fontSize(fs).fillColor(lColor).font(fw).text(label, ML + 4, cy, { width: CW * 0.7 });
    doc.fontSize(fs).fillColor(vColor).font(fw).text(value, 0, cy, { align: 'right', width: PW - MR });
    return cy + (opts.net ? 20 : 16);
  }

  // ── EARNINGS ──
  y = secHeader('EARNINGS', y);

  if (data.staff_type === 'parttime') {
    const reg = data.regularShifts || [];
    const ph  = data.phShifts || [];
    if (reg.length > 0) {
      const regHrs = reg.reduce((s,r) => s + (r.hours||0), 0);
      y = lineRow('Regular hours (' + regHrs.toFixed(1) + ' hrs × $' + (data.hourlyRate||0).toFixed(2) + '/hr)',
                  '$' + reg.reduce((s,r) => s + (r.cost||0), 0).toFixed(2), y);
    }
    ph.forEach(s => {
      y = lineRow('Public holiday – ' + fmtDate(s.date) + ' (' + (s.hours||0).toFixed(1) + ' hrs × 1.5×)',
                  '+$' + Number(s.cost||0).toLocaleString('en-SG',{minimumFractionDigits:2,maximumFractionDigits:2}), y);
    });
  } else {
    y = lineRow('Base Salary', fmtMoney(data.salary), y);
    y = lineRow('Overtime (' + (data.otHours||0).toFixed(1) + ' hrs @ 1.5×)', (data.otPay||0) > 0 ? '+' + fmtMoney(data.otPay) : '$0.00', y, { muted: (data.otPay||0) === 0 });
    if ((data.phShifts||[]).length > 0) {
      y = lineRow('Public Holiday shifts (' + data.phShifts.length + ')', 'Included', y, { muted: true });
    }
  }

  doc.moveTo(ML, y).lineTo(PW - MR, y).strokeColor(LINE).lineWidth(0.5).stroke();
  y += 6;
  y = lineRow('Gross Pay', fmtMoney(data.grossPay), y, { bold: true });
  y += 6;

  // ── DEDUCTIONS ──
  y = secHeader('DEDUCTIONS', y);

  const empCPF = data.employeeCPF || 0;
  if (data.cpfExempt) {
    y = lineRow('CPF Exempt', '—', y, { muted: true });
  } else if (empCPF > 0) {
    const cpfRates = data.cpf || {};
    const rate = cpfRates.rates?.employee_rate || '';
    y = lineRow('Employee CPF' + (rate ? ' (' + rate + '%)' : ''), ('–' + fmtMoney(empCPF)), y, { danger: true });
  }
  if ((data.shgAmount||0) > 0 && data.shgName) {
    y = lineRow(data.shgName, ('–' + fmtMoney(data.shgAmount)), y, { danger: true });
  }

  y += 4;
  y = lineRow('Net Pay (Take-Home)', fmtMoney(data.netPay), y, { net: true });
  y += 8;

  // ── EMPLOYER CONTRIBUTIONS ──
  const empCPFer = data.employerCPF || 0;
  const sdl = data.sdlAmount || 0;
  if (empCPFer > 0 || sdl > 0) {
    y = secHeader('EMPLOYER CONTRIBUTIONS (FOR RECORDS)', y);
    if (empCPFer > 0) {
      const erRate = (data.cpf||{}).rates?.employer_rate || '';
      y = lineRow('Employer CPF' + (erRate ? ' (' + erRate + '%)' : ''), fmtMoney(empCPFer), y, { muted: true });
    }
    if (sdl > 0) {
      y = lineRow('SDL — Skills Development Levy', fmtMoney(sdl), y, { muted: true });
    }
    doc.fontSize(7).fillColor(MUTED).font('Helvetica-Oblique')
      .text('* Employer contributions are for records only and not deducted from staff pay.', ML, y + 4, { width: CW });
    y += 18;
  }

  // ── FOOTER ──
  const footerY = PH - 30;
  doc.moveTo(ML, footerY).lineTo(PW - MR, footerY).strokeColor(LINE).lineWidth(0.8).stroke();
  doc.fontSize(7.5).fillColor(MUTED).font('Helvetica')
    .text('This is a computer-generated payslip · Not a tax document', ML, footerY + 6, { align: 'center', width: CW });

  doc.end();
}

module.exports = router;
