'use strict';
const express = require('express');
const router = express.Router();
const db = require('../database');

// ── Singapore time ────────────────────────────────────────────────────────────
// Same rule as attendance: the server runs UTC, the business runs SGT (UTC+8).
// Date windows must be evaluated in SGT or an announcement starting "today"
// won't appear until 8am.
const SG_OFFSET_MS = 8 * 3600 * 1000;
function sgToday() {
  return new Date(Date.now() + SG_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Schema ────────────────────────────────────────────────────────────────────
// Created on first load so no separate migration step is needed.
try {
  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    body        TEXT,
    image_url   TEXT,
    link_url    TEXT,
    link_label  TEXT,
    active      INTEGER DEFAULT 1,
    starts_on   TEXT,
    ends_on     TEXT,
    created_by  TEXT,
    created_at  TEXT,
    updated_at  TEXT
  )`);
  db.saveDB();
} catch (e) {
  console.error('[announcements] table init failed:', e.message);
}

function isAdmin(req) { return req.session?.user?.role === 'admin'; }
function isManager(req) {
  const r = req.session?.user?.role;
  return r === 'admin' || r === 'manager';
}

// ── Staff-facing: the one announcement to show right now ──────────────────────
// Public on purpose — the clock pages have no login, so staff must be able to
// read this without a session. Returns null when there is nothing to show.
router.get('/active', (req, res) => {
  try {
    const today = sgToday();
    const row = db.get(
      `SELECT id, title, body, image_url, link_url, link_label
         FROM announcements
        WHERE active = 1
          AND (starts_on IS NULL OR starts_on = '' OR starts_on <= ?)
          AND (ends_on   IS NULL OR ends_on   = '' OR ends_on   >= ?)
        ORDER BY id DESC LIMIT 1`,
      [today, today]
    );
    res.json(row || null);
  } catch (e) {
    // Never let this break a page it's embedded in.
    res.json(null);
  }
});

// ── Admin: list all ───────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  if (!isManager(req)) return res.status(401).json({ error: 'Please log in.' });
  try {
    res.json(db.all(`SELECT * FROM announcements ORDER BY id DESC`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: create ─────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required.' });
  const { title, body, image_url, link_url, link_label, starts_on, ends_on, active } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required' });
  try {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO announcements
         (title, body, image_url, link_url, link_label, active, starts_on, ends_on, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [String(title).trim(), body || '', image_url || null, link_url || null, link_label || null,
       active === 0 ? 0 : 1, starts_on || null, ends_on || null,
       req.session?.user?.username || 'admin', now, now]
    );
    db.saveDB();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: update ─────────────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required.' });
  const { title, body, image_url, link_url, link_label, starts_on, ends_on, active } = req.body || {};
  try {
    db.run(
      `UPDATE announcements
          SET title=?, body=?, image_url=?, link_url=?, link_label=?,
              active=?, starts_on=?, ends_on=?, updated_at=?
        WHERE id=?`,
      [title, body || '', image_url || null, link_url || null, link_label || null,
       active ? 1 : 0, starts_on || null, ends_on || null,
       new Date().toISOString(), req.params.id]
    );
    db.saveDB();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: toggle on/off ──────────────────────────────────────────────────────
router.post('/:id/toggle', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required.' });
  try {
    const row = db.get(`SELECT active FROM announcements WHERE id=?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.run(`UPDATE announcements SET active=?, updated_at=? WHERE id=?`,
      [row.active ? 0 : 1, new Date().toISOString(), req.params.id]);
    db.saveDB();
    res.json({ success: true, active: row.active ? 0 : 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: delete ─────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required.' });
  try {
    db.run(`DELETE FROM announcements WHERE id=?`, [req.params.id]);
    db.saveDB();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
