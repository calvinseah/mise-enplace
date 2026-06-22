'use strict';

const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { encrypt, decrypt } = require('./crypto');

const DB_PATH = process.env.DB_PATH || './attendance.db';
let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  createSchema();
  await seedData();
  saveDB();
  return db;
}

function saveDB() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function run(sql, params = []) { db.run(sql, params); saveDB(); }

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ─── SCHEMA ──────────────────────────────────────────────────────────────────
function createSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS outlets (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    address TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS staff (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL,
    staff_type      TEXT NOT NULL CHECK(staff_type IN ('fulltime','parttime')),
    monthly_salary  REAL,
    hourly_rate     REAL,
    date_of_birth   TEXT,
    pr_status       TEXT NOT NULL DEFAULT 'citizen' CHECK(pr_status IN ('citizen','pr','foreigner')),
    pr_year         INTEGER,
    nric_last4      TEXT,
    nric_full_enc   TEXT,
    bank_name       TEXT,
    bank_account_enc TEXT,
    pin             TEXT,
    pin_active      INTEGER NOT NULL DEFAULT 1,
    is_active       INTEGER NOT NULL DEFAULT 1
  )`);

  // Migrate: add new columns if upgrading existing DB
  const cols = all(`PRAGMA table_info(staff)`).map(r => r.name);
  if (!cols.includes('nric_full_enc'))    db.run(`ALTER TABLE staff ADD COLUMN nric_full_enc TEXT`);
  if (!cols.includes('bank_name'))        db.run(`ALTER TABLE staff ADD COLUMN bank_name TEXT`);
  if (!cols.includes('bank_account_enc')) db.run(`ALTER TABLE staff ADD COLUMN bank_account_enc TEXT`);
  if (!cols.includes('pin_active'))       db.run(`ALTER TABLE staff ADD COLUMN pin_active INTEGER NOT NULL DEFAULT 1`);

  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id         INTEGER NOT NULL,
    outlet_id        INTEGER,
    clock_in         TEXT NOT NULL,
    clock_out        TEXT,
    break_minutes    INTEGER DEFAULT 0,
    total_hours      REAL,
    total_cost       REAL,
    is_public_holiday INTEGER DEFAULT 0,
    notes            TEXT,
    is_amended       INTEGER DEFAULT 0,
    amended_by       TEXT,
    amended_at       TEXT,
    FOREIGN KEY(staff_id)  REFERENCES staff(id),
    FOREIGN KEY(outlet_id) REFERENCES outlets(id)
  )`);

  // Migrate attendance
  const aCols = all(`PRAGMA table_info(attendance)`).map(r => r.name);
  if (!aCols.includes('outlet_id')) db.run(`ALTER TABLE attendance ADD COLUMN outlet_id INTEGER`);

  db.run(`CREATE TABLE IF NOT EXISTS public_holidays (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pin_lockouts (
    staff_id     INTEGER NOT NULL PRIMARY KEY,
    attempts     INTEGER DEFAULT 0,
    locked_until TEXT
  )`);
}

// ─── SEED ─────────────────────────────────────────────────────────────────────
async function seedData() {
  // Outlets
  const noOutlets = get('SELECT COUNT(*) as cnt FROM outlets');
  if (!noOutlets || noOutlets.cnt === 0) {
    db.run(`INSERT INTO outlets (name, address) VALUES
      ('North Bridge Road', '778 North Bridge Road, Singapore 198746')`);
  }

  // Staff
  const noStaff = get('SELECT COUNT(*) as cnt FROM staff');
  if (noStaff && noStaff.cnt > 0) return;

  const staffSeed = [
    { name: 'Jamie Tan',  role: 'Crew',       staff_type: 'parttime', hourly_rate: 9.50,   pr_status: 'citizen', date_of_birth: '2001-03-15', pin: '1001' },
    { name: 'Marcus Lim', role: 'Supervisor',  staff_type: 'fulltime', monthly_salary: 2400, pr_status: 'citizen', date_of_birth: '1990-07-22', pin: '2001' },
    { name: 'Sarah Ng',   role: 'Manager',     staff_type: 'fulltime', monthly_salary: 3200, pr_status: 'pr', pr_year: 2022, date_of_birth: '1988-11-05', pin: '3001' },
  ];

  for (const s of staffSeed) {
    const hashedPin = await bcrypt.hash(s.pin, 10);
    db.run(
      `INSERT INTO staff (name, role, staff_type, monthly_salary, hourly_rate, date_of_birth,
        pr_status, pr_year, pin, pin_active, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
      [s.name, s.role, s.staff_type, s.monthly_salary || null, s.hourly_rate || null,
       s.date_of_birth, s.pr_status, s.pr_year || null, hashedPin]
    );
  }

  // Public holidays 2025 & 2026
  const holidays = [
    ['2025-01-01',"New Year's Day"],['2025-01-29','Chinese New Year'],['2025-01-30','Chinese New Year Holiday'],
    ['2025-03-31','Hari Raya Puasa'],['2025-04-18','Good Friday'],['2025-05-01','Labour Day'],
    ['2025-05-12','Vesak Day'],['2025-06-06','Hari Raya Haji'],['2025-08-09','National Day'],
    ['2025-10-20','Deepavali'],['2025-12-25','Christmas Day'],
    ['2026-01-01',"New Year's Day"],['2026-01-17','Chinese New Year'],['2026-01-18','Chinese New Year Holiday'],
    ['2026-03-20','Hari Raya Puasa'],['2026-04-03','Good Friday'],['2026-05-01','Labour Day'],
    ['2026-05-31','Vesak Day'],['2026-05-27','Hari Raya Haji'],['2026-08-10','National Day'],
    ['2026-11-07','Deepavali'],['2026-12-25','Christmas Day'],
  ];
  for (const [date, name] of holidays) {
    db.run('INSERT OR IGNORE INTO public_holidays (date, name) VALUES (?, ?)', [date, name]);
  }
}

// ─── ENCRYPTION HELPERS ───────────────────────────────────────────────────────
function encryptField(val) { return encrypt(val); }
function decryptField(val) { return decrypt(val); }

// ─── CPF ──────────────────────────────────────────────────────────────────────
function getAge(dob) {
  if (!dob) return null;
  const today = new Date(), birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function getCPFRates(staff, periodEnd) {
  if (staff.pr_status === 'foreigner') return null;
  const age = staff.date_of_birth ? getAge(staff.date_of_birth) : null;
  if (age === null) return null;
  let empRate, erRate;
  if (age < 55)      { empRate = 0.20;  erRate = 0.17; }
  else if (age < 60) { empRate = 0.15;  erRate = 0.15; }
  else if (age < 65) { empRate = 0.095; erRate = 0.115; }
  else if (age < 70) { empRate = 0.07;  erRate = 0.09; }
  else               { empRate = 0.05;  erRate = 0.075; }
  if (staff.pr_status === 'pr' && staff.pr_year) {
    const prYears = new Date(periodEnd || new Date()).getFullYear() - staff.pr_year;
    if (prYears <= 0)      { empRate = Math.min(empRate, 0.05); erRate = Math.min(erRate, 0.04); }
    else if (prYears === 1) { empRate = Math.min(empRate, 0.15); erRate = Math.min(erRate, 0.09); }
  }
  return { empRate, erRate };
}

function computeCPF(staff, grossPay, periodEnd) {
  const rates = getCPFRates(staff, periodEnd);
  if (!rates) return null;
  const OW_CEILING = 7400;
  const cappedGross = Math.min(grossPay, OW_CEILING);
  const exceedsCeiling = grossPay > OW_CEILING;
  const empCPF = Math.round(cappedGross * rates.empRate * 100) / 100;
  const erCPF  = Math.round(cappedGross * rates.erRate  * 100) / 100;
  return { empCPF, erCPF, netPay: grossPay - empCPF, cappedGross, exceedsCeiling };
}

// ─── SHIFT COST ───────────────────────────────────────────────────────────────
function computeShiftCost(staff, hours, isPublicHoliday) {
  if (staff.staff_type === 'parttime') {
    const rate = staff.hourly_rate || 0;
    return isPublicHoliday
      ? { cost: hours * rate * 1.5, rate: rate * 1.5, isOT: false, isPH: true }
      : { cost: hours * rate, rate, isOT: false, isPH: false };
  }
  const salary = staff.monthly_salary || 0;
  const hourlyEquiv = salary / 26 / 8;
  if (salary > 2600) {
    return { cost: hours * hourlyEquiv, rate: hourlyEquiv, isOT: false, isPH: isPublicHoliday };
  }
  const regularHours = Math.min(hours, 8);
  const otHours = Math.max(0, hours - 8);
  const cost = (regularHours * hourlyEquiv) + (otHours * hourlyEquiv * 1.5);
  return { cost, rate: hourlyEquiv, otHours, isOT: otHours > 0, isPH: isPublicHoliday };
}

module.exports = {
  initDB, run, get, all, saveDB,
  encryptField, decryptField,
  computeShiftCost, computeCPF, getCPFRates, getAge,
};
