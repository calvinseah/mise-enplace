'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');

// GET all companies
router.get('/', (req, res) => {
  try { res.json(db.all('SELECT * FROM companies WHERE is_active=1 ORDER BY name')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// POST add company
router.post('/', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, uen } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    db.run('INSERT INTO companies (name, uen) VALUES (?,?)', [name, uen || null]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update company
router.put('/:id', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, uen } = req.body;
  try {
    db.run('UPDATE companies SET name=?,uen=? WHERE id=?', [name, uen || null, req.params.id]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE company
router.delete('/:id', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    db.run('UPDATE companies SET is_active=0 WHERE id=?', [req.params.id]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
