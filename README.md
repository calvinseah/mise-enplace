# 🍺 Mise — Staff Attendance & Payroll System

A full-stack web application for managing staff attendance, clock-in/out, and payslip generation for Mise.

**Address:** 778 North Bridge Road, Singapore 198746

---

## Features

- 📱 **Mobile-first clock-in/out** with PIN authentication
- 🔐 **4-digit PIN system** with bcrypt hashing and lockout after 3 failed attempts
- 🎉 **Public holiday detection** — auto-applies 1.5× rate for part-timers
- 📊 **Manager dashboard** with filterable attendance records and inline amendments
- 👥 **Staff management** — add, edit, deactivate, assign/reset PINs
- 💰 **Payslip PDF generation** with itemised shifts and CPF calculations
- 🧮 **Full CPF logic**: citizen/PR/foreigner, age bands, PR graduated rates, OW ceiling

---

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: sql.js (SQLite, pure JavaScript — no native build required)
- **PDF**: PDFKit
- **Auth**: bcryptjs (PIN hashing)
- **Frontend**: Server-rendered HTML with embedded CSS/JS

---

## Local Development

### Prerequisites
- Node.js 18+

### Setup

```bash
git clone <your-repo>
cd app
npm install
cp .env.example .env
# Edit .env if needed
node server.js
```

The app starts on http://localhost:3000

### Default Seed Users

| Name | Role | Type | PIN |
|------|------|------|-----|
| Jamie Tan | Crew | Part-Time ($9.50/hr) | 1001 |
| Marcus Lim | Supervisor | Full-Time ($2,400/mo) | 2001 |
| Sarah Ng | Manager | Full-Time ($3,200/mo) | 3001 |

### Pages

| URL | Description |
|-----|-------------|
| `/` | Mobile clock-in/out page (public) |
| `/dashboard` | Manager attendance dashboard |
| `/staff` | Staff management |
| `/payslip` | Payslip generator |

---

## Deployment

### Railway

1. Create account at [railway.app](https://railway.app)
2. Click **New Project → Deploy from GitHub repo**
3. Connect your repository
4. Railway auto-detects Node.js and runs `npm start`
5. Add environment variables under **Variables**:
   ```
   PORT=3000
   BASE_URL=https://your-app.railway.app
   DB_PATH=./attendance.db
   ```
6. Under **Settings → Networking**, generate a public domain
7. Your app is live at the generated URL

> **Note:** Railway's filesystem is ephemeral on free tier. For persistent data, upgrade to a paid plan or use Railway's volume storage. Set `DB_PATH=/app/data/attendance.db` and create a volume mounted at `/app/data`.

### Render

1. Create account at [render.com](https://render.com)
2. Click **New → Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Add environment variables:
   ```
   PORT=10000
   BASE_URL=https://your-app.onrender.com
   DB_PATH=./attendance.db
   ```
6. Click **Create Web Service**

> **Note:** Render free tier spins down after 15 minutes of inactivity. For production use, upgrade to a paid instance. For persistent SQLite, use a **Render Disk** mounted at `/data` and set `DB_PATH=/data/attendance.db`.

#### Render with Persistent Disk

1. After creating the service, go to **Disks** in the service settings
2. Add disk: Mount Path `/data`, Size 1 GB
3. Set `DB_PATH=/data/attendance.db` in environment variables

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `BASE_URL` | `http://localhost:3000` | Public URL (used in links) |
| `DB_PATH` | `./attendance.db` | Path to SQLite database file |

---

## Business Logic Notes

### Overtime (Full-Time Staff)
- **Salary > $2,600/month**: No OT calculation. Fixed salary regardless of hours.
- **Salary ≤ $2,600/month**: OT at 1.5× hourly equivalent (monthly salary ÷ 26 ÷ 8) for hours beyond 8/day.

### Public Holidays (Part-Time Staff)
- Shifts on public holidays automatically detected via the Public Holidays table
- Paid at 1.5× hourly rate
- Itemised separately on payslip

### Public Holidays (Full-Time Staff)
- PH shifts are flagged on payslip with a notes field
- Manager handles PH compensation manually (MVP scope)

### CPF Calculation
- Applies to Citizens and PRs only
- Part-timers: CPF only if gross pay > $50/month
- OW Ceiling: $7,400/month — payslip shows a warning if exceeded
- PR graduated rates: Year 1 (5% employee / 4% employer), Year 2 (15% / 9%), Year 3+ (citizen rates)

### PIN Security
- PINs stored as bcrypt hashes (cost factor 10)
- 3 failed attempts → 5-minute lockout
- Manager can set/reset any PIN without knowing the old one

---

## API Reference

### Attendance
```
GET  /api/attendance/active-staff     — Staff with PINs (for clock-in dropdown)
GET  /api/attendance/current/:id      — Current clock-in status
GET  /api/attendance/holiday-check    — Check if date is public holiday
POST /api/attendance/verify-pin       — Verify staff PIN
POST /api/attendance/clock-in         — Clock in
POST /api/attendance/clock-out        — Clock out with break
GET  /api/attendance/records          — Attendance records (filterable)
PUT  /api/attendance/records/:id      — Amend record
GET  /api/attendance/holidays         — List public holidays
POST /api/attendance/holidays         — Add public holiday
DEL  /api/attendance/holidays/:id     — Remove public holiday
```

### Staff
```
GET    /api/staff             — All staff
GET    /api/staff/:id         — Single staff
POST   /api/staff             — Create staff
PUT    /api/staff/:id         — Update staff
POST   /api/staff/:id/pin     — Set/reset PIN
DELETE /api/staff/:id/pin     — Remove PIN
PATCH  /api/staff/:id/status  — Toggle active/inactive
```

### Payslip
```
GET /api/payslip/preview   — Payslip JSON data
GET /api/payslip/download  — Download PDF
```

---

## File Structure

```
/app
  server.js           Main Express app
  database.js         SQLite setup, schema, seed, business logic
  .env                Environment variables
  .env.example        Template
  README.md           This file
  /routes
    attendance.js     Clock-in/out, records, holidays
    staff.js          Staff CRUD and PIN management
    payslip.js        Payslip generation and PDF
  /public
    clock-in.html     Mobile clock-in page
    dashboard.html    Manager dashboard
    staff.html        Staff management
    payslip.html      Payslip generator
  package.json
```
