'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const db      = require('../database');

// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const user = db.get(`SELECT * FROM users WHERE username=? AND is_active=1`, [username.trim().toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Incorrect username or password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Incorrect username or password' });

    // Get assigned outlets for managers
    let outlets = [];
    if (user.role === 'manager') {
      outlets = db.all(
        `SELECT o.id, o.name FROM user_outlets uo JOIN outlets o ON uo.outlet_id=o.id WHERE uo.user_id=?`,
        [user.id]
      );
    }

    req.session.user = {
      id:       user.id,
      username: user.username,
      name:     user.name || user.username,
      role:     user.role,
      outlets:  outlets.map(o => o.id),
      outletNames: outlets.map(o => o.name),
    };
    res.json({ success: true, role: user.role, name: user.name || user.username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Logout ────────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const u = req.session?.user;
  res.json({ loggedIn: !!u, role: u?.role, name: u?.name, username: u?.username, outlets: u?.outlets || [] });
});

// ── User management (admin only) ──────────────────────────────────────────────
router.get('/users', (req, res) => {
  try {
    const users = db.all(`SELECT id, username, role, name, is_active, created_at FROM users ORDER BY role, username`);
    const withOutlets = users.map(u => {
      const outlets = db.all(
        `SELECT o.id, o.name FROM user_outlets uo JOIN outlets o ON uo.outlet_id=o.id WHERE uo.user_id=?`,
        [u.id]
      );
      return { ...u, outlets };
    });
    res.json(withOutlets);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/users', async (req, res) => {
  const { username, password, role, name, outlet_ids } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!['admin','manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const existing = db.get(`SELECT id FROM users WHERE username=?`, [username.trim().toLowerCase()]);
    if (existing) return res.status(400).json({ error: 'Username already exists' });

    const hashed = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (username, password, role, name, is_active, created_at) VALUES (?,?,?,?,1,?)`,
      [username.trim().toLowerCase(), hashed, role, name || username, new Date().toISOString()]
    );
    const newUser = db.get(`SELECT id FROM users WHERE username=?`, [username.trim().toLowerCase()]);

    if (role === 'manager' && outlet_ids?.length) {
      for (const oid of outlet_ids) {
        db.run(`INSERT OR IGNORE INTO user_outlets (user_id, outlet_id) VALUES (?,?)`, [newUser.id, oid]);
      }
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/users/:id', async (req, res) => {
  const { name, role, password, is_active, outlet_ids } = req.body;
  try {
    const user = db.get(`SELECT * FROM users WHERE id=?`, [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Prevent demoting last admin
    if (role && role !== 'admin' && user.role === 'admin') {
      const adminCount = db.get(`SELECT COUNT(*) as cnt FROM users WHERE role='admin' AND is_active=1`);
      if (adminCount.cnt <= 1) return res.status(400).json({ error: 'Cannot remove the last admin account' });
    }

    if (name !== undefined)      db.run(`UPDATE users SET name=? WHERE id=?`,      [name, req.params.id]);
    if (role !== undefined)      db.run(`UPDATE users SET role=? WHERE id=?`,      [role, req.params.id]);
    if (is_active !== undefined) db.run(`UPDATE users SET is_active=? WHERE id=?`, [is_active ? 1 : 0, req.params.id]);
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      db.run(`UPDATE users SET password=? WHERE id=?`, [hashed, req.params.id]);
    }

    if (outlet_ids !== undefined) {
      db.run(`DELETE FROM user_outlets WHERE user_id=?`, [req.params.id]);
      for (const oid of (outlet_ids || [])) {
        db.run(`INSERT OR IGNORE INTO user_outlets (user_id, outlet_id) VALUES (?,?)`, [req.params.id, oid]);
      }
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/users/:id', (req, res) => {
  try {
    const user = db.get(`SELECT role FROM users WHERE id=?`, [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.role === 'admin') {
      const cnt = db.get(`SELECT COUNT(*) as cnt FROM users WHERE role='admin' AND is_active=1`);
      if (cnt.cnt <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
    }
    db.run(`UPDATE users SET is_active=0 WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
