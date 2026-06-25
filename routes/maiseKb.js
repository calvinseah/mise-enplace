'use strict';
const express = require('express');
const router = express.Router();
const db = require('../database');

const DEFAULT_CATEGORIES = ['Suppliers & Ordering', 'Recipes', 'SOPs', 'Brand Info', 'HR & Policies', 'Other'];

// Seed default categories if none exist
function ensureCategories() {
  const existing = db.all('SELECT name FROM maise_categories ORDER BY sort_order, name');
  if (!existing.length) {
    DEFAULT_CATEGORIES.forEach((name, i) => {
      db.run('INSERT OR IGNORE INTO maise_categories (name, sort_order) VALUES (?,?)', [name, i]);
    });
  }
}

router.get('/categories', (req, res) => {
  try {
    ensureCategories();
    const cats = db.all('SELECT id, name FROM maise_categories ORDER BY sort_order, name');
    res.json(cats.map(c => c.name));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add category
router.post('/categories', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const max = db.get('SELECT MAX(sort_order) as m FROM maise_categories')?.m || 0;
    db.run('INSERT INTO maise_categories (name, sort_order) VALUES (?,?)', [name.trim(), max + 1]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete category
router.delete('/categories/:name', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    db.run('DELETE FROM maise_categories WHERE name=?', [decodeURIComponent(req.params.name)]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

// Unanswered questions
router.get('/unanswered', (req, res) => {
  try {
    const rows = db.all('SELECT * FROM maise_unanswered WHERE resolved=0 ORDER BY created_at DESC');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/unanswered/:id/resolve', (req, res) => {
  try {
    db.run('UPDATE maise_unanswered SET resolved=1 WHERE id=?', [req.params.id]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/unanswered/:id', (req, res) => {
  try {
    db.run('DELETE FROM maise_unanswered WHERE id=?', [req.params.id]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
