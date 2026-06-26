'use strict';
const express = require('express');
const router = express.Router();
const db = require('../database');

const CATEGORIES = ['Mains', 'Soups', 'Desserts', 'Sauces', 'Sides', 'Drinks', 'Snacks', 'Other'];
const ICONS = { 'Mains':'🍽️', 'Soups':'🍲', 'Desserts':'🍮', 'Sauces':'🥫', 'Sides':'🥗', 'Drinks':'🥤', 'Snacks':'🍟', 'Other':'📋' };

router.get('/categories', (req, res) => res.json(CATEGORIES));
router.get('/icons', (req, res) => res.json(ICONS));

// List recipes
router.get('/', (req, res) => {
  try {
    const { outlet_id, category, q } = req.query;
    let sql = 'SELECT r.*, o.name as outlet_name FROM recipes r LEFT JOIN outlets o ON r.outlet_id=o.id WHERE 1=1';
    const params = [];
    if (outlet_id) { sql += ' AND (r.outlet_id=? OR r.is_shared=1)'; params.push(outlet_id); }
    if (category)  { sql += ' AND r.category=?'; params.push(category); }
    if (q)         { sql += ' AND r.name LIKE ?'; params.push('%'+q+'%'); }
    sql += ' ORDER BY r.category, r.name';
    res.json(db.all(sql, params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get single recipe with ingredients + steps
router.get('/:id', (req, res) => {
  try {
    const recipe = db.get('SELECT r.*, o.name as outlet_name FROM recipes r LEFT JOIN outlets o ON r.outlet_id=o.id WHERE r.id=?', [req.params.id]);
    if (!recipe) return res.status(404).json({ error: 'Not found' });
    recipe.allergens = JSON.parse(recipe.allergens || '[]');
    recipe.ingredients = db.all('SELECT * FROM recipe_ingredients WHERE recipe_id=? ORDER BY sort_order', [req.params.id]);
    recipe.steps = db.all('SELECT * FROM recipe_steps WHERE recipe_id=? ORDER BY sort_order', [req.params.id]);
    res.json(recipe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create recipe
router.post('/', (req, res) => {
  const actor = req.session?.user?.username || 'admin';
  const { name, category, outlet_id, description, icon, base_servings, allergens, notes, is_shared, ingredients, steps } = req.body;
  if (!name || !category) return res.status(400).json({ error: 'Name and category required' });
  try {
    const now = new Date().toISOString();
    db.run(
      'INSERT INTO recipes (name,category,outlet_id,description,icon,base_servings,allergens,notes,is_shared,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [name, category, outlet_id||null, description||'', icon||ICONS[category]||'🍽️', base_servings||4, JSON.stringify(allergens||[]), notes||'', is_shared?1:0, actor, now, now]
    );
    const idRow = db.get('SELECT id FROM recipes WHERE name=? AND created_at=? ORDER BY id DESC LIMIT 1', [name, now]);
    const id = idRow ? idRow.id : db.get('SELECT MAX(id) as id FROM recipes').id;
    (ingredients||[]).forEach((ing, i) => {
      db.run('INSERT INTO recipe_ingredients (recipe_id,sort_order,name,amount,unit,cost_per_unit) VALUES (?,?,?,?,?,?)',
        [id, i, ing.name, ing.amount, ing.unit||null, ing.cost_per_unit||0]);
    });
    (steps||[]).forEach((step, i) => {
      db.run('INSERT INTO recipe_steps (recipe_id,sort_order,title,content,timer_seconds) VALUES (?,?,?,?,?)',
        [id, i, step.title, step.content, step.timer_seconds||null]);
    });
    db.saveDB();
    res.json({ success: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update recipe
router.put('/:id', (req, res) => {
  const { name, category, outlet_id, description, icon, base_servings, allergens, notes, is_shared, ingredients, steps } = req.body;
  try {
    const now = new Date().toISOString();
    db.run(
      'UPDATE recipes SET name=?,category=?,outlet_id=?,description=?,icon=?,base_servings=?,allergens=?,notes=?,is_shared=?,updated_at=? WHERE id=?',
      [name, category, outlet_id||null, description||'', icon||ICONS[category]||'🍽️', base_servings||4, JSON.stringify(allergens||[]), notes||'', is_shared?1:0, now, req.params.id]
    );
    db.run('DELETE FROM recipe_ingredients WHERE recipe_id=?', [req.params.id]);
    db.run('DELETE FROM recipe_steps WHERE recipe_id=?', [req.params.id]);
    (ingredients||[]).forEach((ing, i) => {
      db.run('INSERT INTO recipe_ingredients (recipe_id,sort_order,name,amount,unit,cost_per_unit) VALUES (?,?,?,?,?,?)',
        [req.params.id, i, ing.name, ing.amount, ing.unit||null, ing.cost_per_unit||0]);
    });
    (steps||[]).forEach((step, i) => {
      db.run('INSERT INTO recipe_steps (recipe_id,sort_order,title,content,timer_seconds) VALUES (?,?,?,?,?)',
        [req.params.id, i, step.title, step.content, step.timer_seconds||null]);
    });
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete recipe
router.delete('/:id', (req, res) => {
  try {
    db.run('DELETE FROM recipe_ingredients WHERE recipe_id=?', [req.params.id]);
    db.run('DELETE FROM recipe_steps WHERE recipe_id=?', [req.params.id]);
    db.run('DELETE FROM recipes WHERE id=?', [req.params.id]);
    db.saveDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
