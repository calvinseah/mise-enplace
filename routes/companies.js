'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');

// GET all companies
router.get('/', (req, res) => {
  try {
    res.json(db.all('SELECT * FROM companies WHERE is_active=1 ORDER BY name'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update company UEN
router.put('/:id', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, uen, address } = req.body;
  try {
    db.run('UPDATE companies SET name=?,uen=?,address=? WHERE id=?', [name, uen||null, address||null, req.params.id]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
