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
  createApplicationsTable();
  await seedData();
  saveDB();
  return db;
}

function exportDB() {
  try { return db.export(); } catch(e) { return null; }
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
    mbmf            INTEGER NOT NULL DEFAULT 0,
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
  if (!cols.includes('mbmf'))             db.run(`ALTER TABLE staff ADD COLUMN mbmf INTEGER NOT NULL DEFAULT 0`);

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
    geo_flagged      INTEGER DEFAULT 0,
    geo_distance_m   REAL,
    FOREIGN KEY(staff_id)  REFERENCES staff(id),
    FOREIGN KEY(outlet_id) REFERENCES outlets(id)
  )`);

  // Migrate attendance
  const aCols = all(`PRAGMA table_info(attendance)`).map(r => r.name);
  if (!aCols.includes('outlet_id')) db.run(`ALTER TABLE attendance ADD COLUMN outlet_id INTEGER`);


  db.run(`CREATE TABLE IF NOT EXISTS breaks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id INTEGER NOT NULL,
    break_start   TEXT NOT NULL,
    break_end     TEXT,
    duration_mins INTEGER,
    FOREIGN KEY(attendance_id) REFERENCES attendance(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS public_holidays (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  )`);


  db.run(`CREATE TABLE IF NOT EXISTS revenue_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL,
    outlet_id  INTEGER,
    revenue    REAL NOT NULL,
    notes      TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(outlet_id) REFERENCES outlets(id)
  )`);


  // Roster tables
  db.run(`CREATE TABLE IF NOT EXISTS roster_settings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    outlet_id       INTEGER,
    year            INTEGER NOT NULL,
    month           INTEGER NOT NULL,
    closed_days     TEXT DEFAULT '[]',
    shift_times     TEXT DEFAULT '{"opening":{"start":"10:00","end":"17:00"},"closing":{"start":"17:00","end":"23:00"},"fullshift":{"start":"10:00","end":"23:00"}}',
    overridden_days TEXT DEFAULT '[]',
    UNIQUE(outlet_id, year, month)
  )`);
  try { db.run("ALTER TABLE roster_settings ADD COLUMN overridden_days TEXT DEFAULT '[]'"); } catch(e) {}

  db.run(`CREATE TABLE IF NOT EXISTS leave_entitlements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id    INTEGER NOT NULL,
    year        INTEGER NOT NULL,
    leave_type  TEXT NOT NULL,
    total_days  REAL NOT NULL DEFAULT 0,
    used_days   REAL NOT NULL DEFAULT 0,
    FOREIGN KEY(staff_id) REFERENCES staff(id),
    UNIQUE(staff_id, year, leave_type)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS leave_applications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id      INTEGER NOT NULL,
    leave_type    TEXT NOT NULL,
    start_date    TEXT NOT NULL,
    end_date      TEXT NOT NULL,
    days          REAL NOT NULL,
    reason        TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    reviewed_by   TEXT,
    reviewed_at   TEXT,
    reject_reason TEXT,
    created_at    TEXT NOT NULL,
    FOREIGN KEY(staff_id) REFERENCES staff(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    entity      TEXT NOT NULL,
    entity_id   INTEGER,
    staff_name  TEXT,
    details     TEXT,
    created_at  TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS staff_entity_assignments (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id  INTEGER NOT NULL,
    company_id INTEGER NOT NULL,
    year      INTEGER NOT NULL,
    month     INTEGER NOT NULL,
    UNIQUE(staff_id, year, month),
    FOREIGN KEY(staff_id) REFERENCES staff(id),
    FOREIGN KEY(company_id) REFERENCES companies(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS maise_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);


  db.run("CREATE TABLE IF NOT EXISTS maise_unanswered (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, asked_by TEXT, created_at TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0)");

  db.run("CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL, outlet_id INTEGER, description TEXT, icon TEXT DEFAULT '🍽', base_servings INTEGER NOT NULL DEFAULT 4, allergens TEXT DEFAULT '[]', notes TEXT, is_shared INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");

  db.run("CREATE TABLE IF NOT EXISTS recipe_ingredients (id INTEGER PRIMARY KEY AUTOINCREMENT, recipe_id INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, amount REAL NOT NULL, unit TEXT, cost_per_unit REAL DEFAULT 0, FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE)");

  db.run("CREATE TABLE IF NOT EXISTS recipe_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, recipe_id INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, content TEXT NOT NULL, timer_seconds INTEGER, FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE)");

  db.run("CREATE TABLE IF NOT EXISTS recipe_outlets (recipe_id INTEGER NOT NULL, outlet_id INTEGER NOT NULL, PRIMARY KEY (recipe_id, outlet_id), FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE)");

  db.run("CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT, expires INTEGER)");

  db.run(`CREATE TABLE IF NOT EXISTS maise_kb (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS companies (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    uen       TEXT,
    address   TEXT,
    is_active INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS roster_availability (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id    INTEGER NOT NULL,
    outlet_id   INTEGER,
    year        INTEGER NOT NULL,
    month       INTEGER NOT NULL,
    day         INTEGER NOT NULL,
    shift_type  TEXT NOT NULL CHECK(shift_type IN ('opening','closing','fullshift')),
    available   INTEGER NOT NULL DEFAULT 0,
    UNIQUE(staff_id, outlet_id, year, month, day, shift_type)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS roster_schedule (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id    INTEGER NOT NULL,
    outlet_id   INTEGER,
    year        INTEGER NOT NULL,
    month       INTEGER NOT NULL,
    day         INTEGER NOT NULL,
    role_group  TEXT NOT NULL DEFAULT 'foh' CHECK(role_group IN ('foh','boh')),
    shift_label TEXT,
    start_time  TEXT,
    end_time    TEXT,
    removed     INTEGER DEFAULT 0,
    UNIQUE(staff_id, outlet_id, year, month, day)
  )`);
  // Add new columns if upgrading existing DB
  try { db.run('ALTER TABLE roster_schedule ADD COLUMN start_time TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE outlets ADD COLUMN lat REAL'); } catch(e) {}
  try { db.run('ALTER TABLE outlets ADD COLUMN lng REAL'); } catch(e) {}
  try { db.run('ALTER TABLE outlets ADD COLUMN radius_m INTEGER DEFAULT 200'); } catch(e) {}
  try { db.run('ALTER TABLE attendance ADD COLUMN geo_flagged INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run("ALTER TABLE applications ADD COLUMN race TEXT"); } catch(e) {}
  try { db.run("ALTER TABLE staff ADD COLUMN cpf_exempt INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE staff ADD COLUMN race TEXT"); } catch(e) {}
  db.run("UPDATE staff SET race='Malay' WHERE race IS NULL OR race=''");
  try { db.run('ALTER TABLE attendance ADD COLUMN geo_distance_m REAL'); } catch(e) {}
  try { db.run('ALTER TABLE attendance ADD COLUMN geo_flagged INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run("ALTER TABLE applications ADD COLUMN race TEXT"); } catch(e) {}
  try { db.run("ALTER TABLE staff ADD COLUMN cpf_exempt INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE staff ADD COLUMN race TEXT"); } catch(e) {}
  db.run("UPDATE staff SET race='Malay' WHERE race IS NULL OR race=''");
  try { db.run('ALTER TABLE attendance ADD COLUMN geo_distance_m REAL'); } catch(e) {}
  try { db.run('ALTER TABLE roster_schedule ADD COLUMN end_time TEXT'); } catch(e) {}


  // Extend revenue_entries with orders + pax if not already there
  const revCols = all('PRAGMA table_info(revenue_entries)').map(r => r.name);
  if (!revCols.includes('orders'))  db.run('ALTER TABLE revenue_entries ADD COLUMN orders INTEGER DEFAULT 0');
  if (!revCols.includes('pax'))     db.run('ALTER TABLE revenue_entries ADD COLUMN pax INTEGER DEFAULT 0');
  if (!revCols.includes('location'))db.run('ALTER TABLE revenue_entries ADD COLUMN location TEXT');


  db.run(`CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE,
    password       TEXT NOT NULL,
    plain_password TEXT,
    role           TEXT NOT NULL DEFAULT 'manager' CHECK(role IN ('admin','manager')),
    name           TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL
  )`);
  // Add plain_password column if upgrading existing DB
  try { db.run('ALTER TABLE users ADD COLUMN plain_password TEXT'); } catch(e) {}

  db.run(`CREATE TABLE IF NOT EXISTS user_outlets (
    user_id   INTEGER NOT NULL,
    outlet_id INTEGER NOT NULL,
    PRIMARY KEY(user_id, outlet_id),
    FOREIGN KEY(user_id)   REFERENCES users(id),
    FOREIGN KEY(outlet_id) REFERENCES outlets(id)
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
    { name: 'Jamie Tan',  role: 'FOH',       staff_type: 'parttime', hourly_rate: 9.50,   pr_status: 'citizen', date_of_birth: '2001-03-15', pin: '1001' },
    { name: 'Marcus Lim', role: 'FOH',  staff_type: 'fulltime', monthly_salary: 2400, pr_status: 'citizen', date_of_birth: '1990-07-22', pin: '2001' },
    { name: 'Sarah Ng',   role: 'BOH',     staff_type: 'fulltime', monthly_salary: 3200, pr_status: 'pr', pr_year: 2022, date_of_birth: '1988-11-05', pin: '3001' },
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



  // Leave tables are in createSchema()


  // Companies are managed via the /companies admin page




  // Seed default admin user — created here, password synced separately
  const existingAdmin = get(`SELECT id FROM users WHERE username='admin'`);
  if (!existingAdmin) {
    // Placeholder hash — will be updated by syncAdminPassword()
    db.run(
      `INSERT INTO users (username, password, role, name, is_active, created_at)
       VALUES ('admin', 'pending', 'admin', 'Administrator', 1, ?)`,
      [new Date().toISOString()]
    );
  }

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

// ─── SHG (Self-Help Group) DONATIONS ──────────────────────────────────────────
// 2026 rates, validated against CPF Board tables. Flat amount by monthly gross wage.
// Each band is [upperBound, amount]; an employee pays the amount of the first band
// whose upper bound their gross wage does not exceed.
const SHG_TABLES = {
  CDAC:  [[2000, 0.50], [3500, 1.00], [5000, 1.50], [7500, 2.00], [Infinity, 3.00]],
  ECF:   [[1000, 2], [1500, 4], [2500, 6], [4000, 9], [7000, 12], [10000, 16], [Infinity, 20]],
  SINDA: [[1000, 1], [1500, 3], [2500, 5], [4500, 7], [7500, 9], [10000, 12], [15000, 18], [Infinity, 30]],
  MBMF:  [[1000, 3], [2000, 4.50], [3000, 6.50], [4000, 15], [6000, 19.50], [8000, 22], [10000, 24], [Infinity, 26]],
};

function shgLookup(table, gross) {
  for (const [bound, amount] of table) {
    if (gross <= bound) return amount;
  }
  return 0;
}

// Returns a breakdown plus total. Community fund is derived from `staff.race`
// (Chinese→CDAC, Indian→SINDA, Eurasian→ECF) and applies to citizens & PRs only.
// `staff.mbmf` (Muslim) adds MBMF on top and applies to all, foreigners included.
const RACE_TO_COMMUNITY = { Chinese: 'CDAC', Indian: 'SINDA', Eurasian: 'ECF' };

function computeSHG(staff, grossWages) {
  const g = grossWages || 0;
  const out = { cdac: 0, ecf: 0, sinda: 0, mbmf: 0, total: 0 };
  if (g <= 0) return out;
  const isLocal = staff.pr_status === 'citizen' || staff.pr_status === 'pr';
  if (isLocal) {
    const community = RACE_TO_COMMUNITY[staff.race];
    if (community === 'CDAC')       out.cdac  = shgLookup(SHG_TABLES.CDAC,  g);
    else if (community === 'SINDA') out.sinda = shgLookup(SHG_TABLES.SINDA, g);
    else if (community === 'ECF')   out.ecf   = shgLookup(SHG_TABLES.ECF,   g);
  }
  if (staff.mbmf) out.mbmf = shgLookup(SHG_TABLES.MBMF, g); // applies to all, incl. foreigners
  out.total = Math.round((out.cdac + out.ecf + out.sinda + out.mbmf) * 100) / 100;
  return out;
}

// ─── SDL (Skills Development Levy) ─────────────────────────────────────────────
// Employer-paid: 0.25% of monthly gross wages, min $2, max $11.25.
function computeSDL(grossWages) {
  const g = grossWages || 0;
  if (g <= 0) return 0;
  const levy = g * 0.0025;
  if (levy < 2) return 2;
  if (levy > 11.25) return 11.25;
  return Math.round(levy * 100) / 100;
}

async function syncAdminPassword() {
  const bcrypt = require('bcryptjs');
  const pw = process.env.ADMIN_PASSWORD || 'admin1234';
  const hashed = await bcrypt.hash(pw, 10);
  run(`UPDATE users SET password=? WHERE username='admin'`, [hashed]);
  saveDB();
  console.log('   Admin:     admin /', pw);
}

module.exports = {
  initDB, syncAdminPassword, run, get, all, saveDB, exportDB,
  encryptField, decryptField,
  computeShiftCost, computeCPF, computeSHG, computeSDL, getCPFRates, getAge,
};

// ─── APPLICATIONS SCHEMA (appended at runtime via initDB migration) ───────────
// Called separately so we can add to existing DBs cleanly
function createApplicationsTable() {
  db.run(`CREATE TABLE IF NOT EXISTS applications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    date_of_birth   TEXT,
    nric_full_enc   TEXT,
    bank_name       TEXT,
    bank_account_enc TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    submitted_at    TEXT NOT NULL,
    reviewed_at     TEXT,
    reviewed_by     TEXT,
    race            TEXT,
    reject_reason   TEXT
  )`);
}

module.exports.createApplicationsTable = createApplicationsTable;
