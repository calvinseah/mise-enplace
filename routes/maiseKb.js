'use strict';
const express = require('express');
const router = express.Router();
const db = require('../database');

const CATEGORIES = ['Suppliers & Ordering', 'Recipes', 'SOPs', 'Brand Info', 'HR & Policies', 'Other'];

router.get('/categories', (req, res) => res.json(CATEGORIES));

router.get('/', (req, res) => {
  const { category } = req.query;
  try {
    let sql = 'SELECT * FROM maise_kb WHERE 1=1';
    const params = [];
    if (category) { sql += ' AND category=?'; params.push(category); }
    sql += ' ORDER BY category, title';
    res.json(db.all(sql, params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', (req, res) => {
  const actor = req.session?.user?.username || 'admin';
  const { category, title, content } = req.body;
  if (!category || !title || !content) return res.status(400).json({ error: 'Missing fields' });
  try {
    const now = new Date().toISOString();
    db.run('INSERT INTO maise_kb (category, title, content, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [category, title, content, actor, now, now]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', (req, res) => {
  const { category, title, content } = req.body;
  try {
    db.run('UPDATE maise_kb SET category=?, title=?, content=?, updated_at=? WHERE id=?',
      [category, title, content, new Date().toISOString(), req.params.id]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    db.run('DELETE FROM maise_kb WHERE id=?', [req.params.id]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
