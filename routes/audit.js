'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');

// Helper to write audit log — called from other routes
function writeLog(actor, action, entity, entityId, staffName, details) {
  try {
    db.run(
      `INSERT INTO audit_log (actor, action, entity, entity_id, staff_name, details, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [actor, action, entity, entityId || null, staffName || null,
       typeof details === 'object' ? JSON.stringify(details) : (details || null),
       new Date().toISOString()]
    );
  } catch(e) { console.error('[Audit]', e.message); }
}

// GET audit log (admin only)
router.get('/', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { limit = 100, offset = 0, entity, actor } = req.query;
  try {
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];
    if (entity) { sql += ' AND entity=?'; params.push(entity); }
    if (actor)  { sql += ' AND actor=?'; params.push(actor); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    res.json(db.all(sql, params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, writeLog };
