'use strict';
const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const router  = express.Router();
const db      = require('../database');

const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET revenue entries
router.get('/', (req, res) => {
  try {
    const { year, outletId, from, to } = req.query;
    let sql = `SELECT r.*, o.name as outlet_name FROM revenue_entries r
               LEFT JOIN outlets o ON r.outlet_id=o.id WHERE 1=1`;
    const params = [];
    if (year)     { sql += ` AND substr(r.week_start,1,4)=?`; params.push(year); }
    if (outletId) { sql += ` AND r.outlet_id=?`;              params.push(outletId); }
    if (from)     { sql += ` AND r.week_start>=?`;             params.push(from); }
    if (to)       { sql += ` AND r.week_start<=?`;             params.push(to); }
    sql += ` ORDER BY r.week_start DESC`;
    res.json(db.all(sql, params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST add single entry
router.post('/', (req, res) => {
  const { week_start, outlet_id, revenue, notes, orders, pax } = req.body;
  if (!week_start || revenue == null) return res.status(400).json({ error: 'week_start and revenue required' });
  try {
    db.run(
      `INSERT OR REPLACE INTO revenue_entries (week_start, outlet_id, revenue, notes, orders, pax, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [week_start, outlet_id || null, parseFloat(revenue), notes || null,
       parseInt(orders)||0, parseInt(pax)||0, new Date().toISOString()]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE entry
router.delete('/:id', (req, res) => {
  try { db.run(`DELETE FROM revenue_entries WHERE id=?`, [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// GET summary (labour vs revenue)
router.get('/summary', (req, res) => {
  try {
    const { from, to, outletId } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    let labourSql = `SELECT COALESCE(SUM(a.total_cost),0) as total_labour FROM attendance a
                     WHERE substr(a.clock_in,1,10)>=? AND substr(a.clock_in,1,10)<=? AND a.clock_out IS NOT NULL`;
    const lp = [from, to];
    if (outletId) { labourSql += ` AND a.outlet_id=?`; lp.push(outletId); }
    let revSql = `SELECT COALESCE(SUM(revenue),0) as total_revenue, COALESCE(SUM(orders),0) as total_orders,
                  COALESCE(SUM(pax),0) as total_pax FROM revenue_entries WHERE week_start>=? AND week_start<=?`;
    const rp = [from, to];
    if (outletId) { revSql += ` AND outlet_id=?`; rp.push(outletId); }
    const labourRow = db.get(labourSql, lp);
    const revRow    = db.get(revSql, rp);
    const labour    = labourRow?.total_labour  || 0;
    const revenue   = revRow?.total_revenue    || 0;
    const pct       = revenue > 0 ? Math.round((labour / revenue) * 1000) / 10 : null;
    res.json({ labour, revenue, pct, from, to,
               orders: revRow?.total_orders || 0, pax: revRow?.total_pax || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST upload CSV/Excel sales report
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { outlet_id } = req.body;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    let imported = 0, skipped = 0;
    let location = null;

    for (const row of rows) {
      // Find date column (flexible)
      const dateRaw = row['Date'] || row['date'] || row['DATE'] || '';
      if (!dateRaw) { skipped++; continue; }

      // Normalise date — handle "2026-6-1" → "2026-06-01"
      const dateParts = String(dateRaw).trim().split('-');
      if (dateParts.length !== 3) { skipped++; continue; }
      const dateStr = `${dateParts[0]}-${String(dateParts[1]).padStart(2,'0')}-${String(dateParts[2]).padStart(2,'0')}`;

      // Revenue — prefer excl. GST
      const parseAmt = v => parseFloat(String(v || '0').replace(/[$,\s]/g,'')) || 0;
      const revenue = parseAmt(row['Amount(Excl.Gst)'] || row['Amount(Excl. GST)'] || row['Revenue'] || row['Amount'] || 0);

      // Skip zero-revenue days
      if (revenue === 0) { skipped++; continue; }

      const orders = parseInt(row['No. of Orders'] || row['Orders'] || 0) || 0;
      const pax    = parseInt(row['Pax'] || row['Covers'] || 0) || 0;

      // Location from first non-empty row
      if (!location && row['Location']) location = String(row['Location']).trim();

      db.run(
        `INSERT OR REPLACE INTO revenue_entries (week_start, outlet_id, revenue, orders, pax, notes, location, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [dateStr, outlet_id || null, revenue, orders, pax,
         `Imported from sales report${location ? ' — '+location : ''}`,
         location || null, new Date().toISOString()]
      );
      imported++;
    }

    res.json({ success: true, imported, skipped,
               message: `Imported ${imported} days of sales data${skipped ? `, skipped ${skipped} zero/invalid rows` : ''}.` });
  } catch(e) {
    res.status(400).json({ error: 'Could not parse file: ' + e.message });
  }
});

module.exports = router;
