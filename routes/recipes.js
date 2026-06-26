'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const db = require('../database');

const CATEGORIES = ['Mains', 'Sauces', 'Meats', 'Aioli & Dressings', 'Prep & Components', 'Soups', 'Sides', 'Desserts', 'Drinks', 'Snacks', 'Other'];
const ICONS = { 'Mains':'🍽️', 'Sauces':'🥫', 'Meats':'🥩', 'Aioli & Dressings':'🥣', 'Prep & Components':'🧂', 'Soups':'🍲', 'Sides':'🥗', 'Desserts':'🍮', 'Drinks':'🥤', 'Snacks':'🍟', 'Other':'📋' };

router.get('/categories', (req, res) => res.json(CATEGORIES));
router.get('/icons', (req, res) => res.json(ICONS));

// List recipes
router.get('/', (req, res) => {
  try {
    const { outlet_id, category, q } = req.query;
    let sql = 'SELECT r.*, o.name as outlet_name, (SELECT GROUP_CONCAT(outlet_id) FROM recipe_outlets WHERE recipe_id=r.id) AS outlet_ids FROM recipes r LEFT JOIN outlets o ON r.outlet_id=o.id WHERE 1=1';
    const params = [];
    if (outlet_id) { sql += ' AND (r.is_shared=1 OR r.outlet_id=? OR EXISTS (SELECT 1 FROM recipe_outlets ro WHERE ro.recipe_id=r.id AND ro.outlet_id=?))'; params.push(outlet_id, outlet_id); }
    if (category)  { sql += ' AND r.category=?'; params.push(category); }
    if (q)         { sql += ' AND r.name LIKE ?'; params.push('%'+q+'%'); }
    sql += ' ORDER BY r.category, r.name';
    res.json(db.all(sql, params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bulk import from bundled seed file. Idempotent: skips recipes whose name
// already exists, so it is safe to run more than once.
// IMPORTANT: must be defined before the '/:id' route below, or '/:id' shadows it.
// Trigger once after deploy:  /api/recipes/import-seed?token=mise-recipes-2026
router.get('/import-seed', (req, res) => {
  if (req.query.token !== 'mise-recipes-2026') return res.status(403).json({ error: 'Forbidden' });
  try {
    const seedPath = path.join(__dirname, '..', 'recipes-seed.json');
    if (!fs.existsSync(seedPath)) return res.status(404).json({ error: 'Seed file not found' });
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const now = new Date().toISOString();
    let created = 0, skipped = 0;
    const createdNames = [];
    for (const r of seed) {
      if (!r.name || !r.category) { skipped++; continue; }
      const exists = db.get('SELECT id FROM recipes WHERE name=?', [r.name]);
      if (exists) { skipped++; continue; }
      db.run(
        'INSERT INTO recipes (name,category,outlet_id,description,icon,base_servings,allergens,notes,is_shared,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [r.name, r.category, r.outlet_id||null, r.description||'', r.icon||ICONS[r.category]||'🍽️',
         r.base_servings||1, JSON.stringify(r.allergens||[]), r.notes||'', r.is_shared===0?0:1,
         'import', now, now]
      );
      const idRow = db.get('SELECT id FROM recipes WHERE name=? AND created_at=? ORDER BY id DESC LIMIT 1', [r.name, now]);
      const id = idRow ? idRow.id : db.get('SELECT MAX(id) as id FROM recipes').id;
      (r.ingredients||[]).forEach((ing, i) => {
        db.run('INSERT INTO recipe_ingredients (recipe_id,sort_order,name,amount,unit,cost_per_unit) VALUES (?,?,?,?,?,?)',
          [id, i, ing.name, ing.amount, ing.unit||null, ing.cost_per_unit||0]);
      });
      (r.steps||[]).forEach((step, i) => {
        db.run('INSERT INTO recipe_steps (recipe_id,sort_order,title,content,timer_seconds) VALUES (?,?,?,?,?)',
          [id, i, step.title, step.content, step.timer_seconds||null]);
      });
      created++; createdNames.push(r.name);
    }
    db.saveDB();
    res.json({ success: true, created, skipped, total: seed.length, createdNames });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// One-time: assign all imported recipes to every Tipo-branded outlet, so they
// show across Tipo (Pasta Bar + Strada) but not the other brands.
// Trigger once:  /api/recipes/assign-tipo?token=mise-recipes-2026
const TIPO_OUTLETS = [7, 8, 11, 12, 9, 5]; // Aliwal, Waterloo, Great World, Keong Saik, Novena, Wheelock
router.get('/assign-tipo', (req, res) => {
  if (req.query.token !== 'mise-recipes-2026') return res.status(403).json({ error: 'Forbidden' });
  try {
    const recs = db.all("SELECT id FROM recipes WHERE created_by='import'");
    let updated = 0;
    for (const r of recs) {
      db.run('UPDATE recipes SET is_shared=0, outlet_id=NULL WHERE id=?', [r.id]);
      db.run('DELETE FROM recipe_outlets WHERE recipe_id=?', [r.id]);
      for (const oid of TIPO_OUTLETS) {
        db.run('INSERT OR IGNORE INTO recipe_outlets (recipe_id,outlet_id) VALUES (?,?)', [r.id, oid]);
      }
      updated++;
    }
    db.saveDB();
    res.json({ success: true, updated, outlets: TIPO_OUTLETS });
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
    recipe.outlet_ids = db.all('SELECT outlet_id FROM recipe_outlets WHERE recipe_id=?', [req.params.id]).map(x => x.outlet_id).join(',');
    res.json(recipe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create recipe
router.post('/', (req, res) => {
  const actor = req.session?.user?.username || 'admin';
  const { name, category, outlet_id, description, icon, base_servings, allergens, notes, is_shared, ingredients, steps, outlet_ids } = req.body;
  if (!name || !category) return res.status(400).json({ error: 'Name and category required' });
  try {
    const now = new Date().toISOString();
    db.run(
      'INSERT INTO recipes (name,category,outlet_id,description,icon,base_servings,allergens,notes,is_shared,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [name, category, outlet_id||null, description||'', icon||ICONS[category]||'🍽️', base_servings||4, JSON.stringify(allergens||[]), notes||'', is_shared?1:0, actor, now, now]
    );
    const idRow = db.get('SELECT id FROM recipes WHERE name=? AND created_at=? ORDER BY id DESC LIMIT 1', [name, now]);
    const id = idRow ? idRow.id : db.get('SELECT MAX(id) as id FROM recipes').id;
    if (Array.isArray(outlet_ids) && outlet_ids.length) {
      outlet_ids.forEach(oid => db.run('INSERT OR IGNORE INTO recipe_outlets (recipe_id,outlet_id) VALUES (?,?)', [id, oid]));
    }
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
  const { name, category, outlet_id, description, icon, base_servings, allergens, notes, is_shared, ingredients, steps, outlet_ids } = req.body;
  try {
    const now = new Date().toISOString();
    db.run(
      'UPDATE recipes SET name=?,category=?,outlet_id=?,description=?,icon=?,base_servings=?,allergens=?,notes=?,is_shared=?,updated_at=? WHERE id=?',
      [name, category, outlet_id||null, description||'', icon||ICONS[category]||'🍽️', base_servings||4, JSON.stringify(allergens||[]), notes||'', is_shared?1:0, now, req.params.id]
    );
    db.run('DELETE FROM recipe_ingredients WHERE recipe_id=?', [req.params.id]);
    db.run('DELETE FROM recipe_steps WHERE recipe_id=?', [req.params.id]);
    // Rebuild outlet links to exactly match what the form sent
    db.run('DELETE FROM recipe_outlets WHERE recipe_id=?', [req.params.id]);
    if (Array.isArray(outlet_ids) && outlet_ids.length) {
      outlet_ids.forEach(oid => db.run('INSERT OR IGNORE INTO recipe_outlets (recipe_id,outlet_id) VALUES (?,?)', [req.params.id, oid]));
    }
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
