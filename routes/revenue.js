'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');

// GET revenue entries (filterable by year/outlet)
router.get('/', (req, res) => {
  try {
    const { year, outletId } = req.query;
    let sql = `
      SELECT r.*, o.name as outlet_name
      FROM revenue_entries r
      LEFT JOIN outlets o ON r.outlet_id = o.id
      WHERE 1=1`;
    const params = [];
    if (year)     { sql += ` AND substr(r.week_start,1,4)=?`; params.push(year); }
    if (outletId) { sql += ` AND r.outlet_id=?`;              params.push(outletId); }
    sql += ` ORDER BY r.week_start DESC`;
    res.json(db.all(sql, params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST add revenue entry
router.post('/', (req, res) => {
  const { week_start, outlet_id, revenue, notes } = req.body;
  if (!week_start || revenue == null) return res.status(400).json({ error: 'week_start and revenue required' });
  try {
    db.run(
      `INSERT OR REPLACE INTO revenue_entries (week_start, outlet_id, revenue, notes, created_at)
       VALUES (?,?,?,?,?)`,
      [week_start, outlet_id || null, parseFloat(revenue), notes || null, new Date().toISOString()]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE revenue entry
router.delete('/:id', (req, res) => {
  try {
    db.run(`DELETE FROM revenue_entries WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET labour cost vs revenue summary for a date range
router.get('/summary', (req, res) => {
  try {
    const { from, to, outletId } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });

    // Labour cost from attendance
    let labourSql = `
      SELECT COALESCE(SUM(a.total_cost),0) as total_labour
      FROM attendance a
      WHERE substr(a.clock_in,1,10)>=? AND substr(a.clock_in,1,10)<=?
        AND a.clock_out IS NOT NULL`;
    const labourParams = [from, to];
    if (outletId) { labourSql += ` AND a.outlet_id=?`; labourParams.push(outletId); }
    const labourRow = db.get(labourSql, labourParams);

    // Revenue entries in range
    let revSql = `
      SELECT COALESCE(SUM(revenue),0) as total_revenue
      FROM revenue_entries
      WHERE week_start>=? AND week_start<=?`;
    const revParams = [from, to];
    if (outletId) { revSql += ` AND outlet_id=?`; revParams.push(outletId); }
    const revRow = db.get(revSql, revParams);

    const labour  = labourRow?.total_labour  || 0;
    const revenue = revRow?.total_revenue || 0;
    const pct     = revenue > 0 ? Math.round((labour / revenue) * 1000) / 10 : null;

    res.json({ labour, revenue, pct, from, to });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
