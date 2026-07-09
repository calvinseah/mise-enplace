'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');

// Build a rich context snapshot for MAIse to reason over
function buildContext({ from, to, outletId }) {
  const today = new Date().toISOString().slice(0,10);
  const fromDate = from || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
  const toDate   = to   || today;

  // ── Attendance & labour cost ───────────────────────────────────────────────
  let attSql = `SELECT a.*, s.name, s.role, s.staff_type, s.hourly_rate, s.monthly_salary, o.name as outlet_name
                FROM attendance a JOIN staff s ON a.staff_id=s.id LEFT JOIN outlets o ON a.outlet_id=o.id
                WHERE substr(a.clock_in,1,10)>=? AND substr(a.clock_in,1,10)<=? AND a.clock_out IS NOT NULL`;
  const ap = [fromDate, toDate];
  if (outletId) { attSql += ` AND a.outlet_id=?`; ap.push(outletId); }
  const attendance = db.all(attSql, ap);

  // ── Revenue / sales ────────────────────────────────────────────────────────
  let revSql = `SELECT * FROM revenue_entries WHERE week_start>=? AND week_start<=?`;
  const rp = [fromDate, toDate];
  if (outletId) { revSql += ` AND outlet_id=?`; rp.push(outletId); }
  const revenue = db.all(revSql, rp);

  // ── Staff list ─────────────────────────────────────────────────────────────
  const staff = db.all(`SELECT id,name,role,staff_type,hourly_rate,monthly_salary FROM staff WHERE is_active=1`);

  // ── Roster schedule (current + next month) ─────────────────────────────────
  const now = new Date();
  const curM = now.getMonth()+1, curY = now.getFullYear();
  const nextM = curM === 12 ? 1 : curM+1, nextY = curM === 12 ? curY+1 : curY;
  let sched = db.all(
    `SELECT rs.*, s.name as staff_name, s.role FROM roster_schedule rs
     JOIN staff s ON rs.staff_id=s.id
     WHERE ((rs.year=? AND rs.month=?) OR (rs.year=? AND rs.month=?)) AND rs.removed=0`,
    [curY, curM, nextY, nextM]
  );

  // ── Roster availability ────────────────────────────────────────────────────
  const avail = db.all(
    `SELECT ra.*, s.name as staff_name FROM roster_availability ra
     JOIN staff s ON ra.staff_id=s.id
     WHERE ra.year=? AND ra.month=? AND ra.available=1`,
    [nextY, nextM]
  );

  // ── Aggregate by day of week (for trend analysis) ─────────────────────────
  const salesByDow = {}; // 0=Sun..6=Sat
  revenue.forEach(r => {
    if (!r.revenue) return;
    const dow = new Date(r.week_start).getDay();
    if (!salesByDow[dow]) salesByDow[dow] = { revenue: 0, orders: 0, days: 0 };
    salesByDow[dow].revenue += r.revenue;
    salesByDow[dow].orders  += r.orders || 0;
    salesByDow[dow].days++;
  });
  const dowAvg = {};
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  Object.entries(salesByDow).forEach(([dow,v]) => {
    dowAvg[DOW[dow]] = { avgRevenue: Math.round(v.revenue/v.days), avgOrders: Math.round(v.orders/v.days) };
  });

  // ── Labour % by week ──────────────────────────────────────────────────────
  const weeklyLabour = {};
  attendance.forEach(a => {
    const wk = getWeekKey(a.clock_in.slice(0,10));
    if (!weeklyLabour[wk]) weeklyLabour[wk] = 0;
    weeklyLabour[wk] += a.total_cost || 0;
  });
  const weeklyRevenue = {};
  revenue.forEach(r => {
    const wk = getWeekKey(r.week_start);
    if (!weeklyRevenue[wk]) weeklyRevenue[wk] = 0;
    weeklyRevenue[wk] += r.revenue || 0;
  });
  const weeklyPct = {};
  Object.keys(weeklyLabour).forEach(wk => {
    const rev = weeklyRevenue[wk] || 0;
    weeklyPct[wk] = rev > 0 ? Math.round(weeklyLabour[wk] / rev * 1000) / 10 : null;
  });

  // ── Staff hours summary ────────────────────────────────────────────────────
  const staffHours = {};
  attendance.forEach(a => {
    if (!staffHours[a.name]) staffHours[a.name] = { hours: 0, cost: 0, shifts: 0 };
    staffHours[a.name].hours  += a.total_hours || 0;
    staffHours[a.name].cost   += a.total_cost  || 0;
    staffHours[a.name].shifts++;
  });

  const totalLabour  = attendance.reduce((s,a) => s + (a.total_cost||0), 0);
  const totalRevenue = revenue.reduce((s,r) => s + (r.revenue||0), 0);

  return {
    period: { from: fromDate, to: toDate },
    today,
    outlet: outletId ? db.get('SELECT name FROM outlets WHERE id=?',[outletId])?.name : 'All outlets',
    summary: {
      totalLabour:  Math.round(totalLabour*100)/100,
      totalRevenue: Math.round(totalRevenue*100)/100,
      labourPct:    totalRevenue > 0 ? Math.round(totalLabour/totalRevenue*1000)/10 : null,
      totalShifts:  attendance.length,
      totalStaff:   staff.length,
    },
    weeklyLabourPct: weeklyPct,
    salesByDayOfWeek: dowAvg,
    staffHoursSummary: Object.fromEntries(
      Object.entries(staffHours).map(([n,v]) => [n, { hours: Math.round(v.hours*10)/10, cost: Math.round(v.cost*100)/100, shifts: v.shifts }])
    ),
    dailySales: revenue.map(r => ({ date: r.week_start, revenue: r.revenue, orders: r.orders||0, pax: r.pax||0 })),
    staff: staff.map(s => ({ name: s.name, role: s.role, type: s.staff_type, rate: s.staff_type==='parttime' ? s.hourly_rate : Math.round(s.monthly_salary/26/8*100)/100 })),
    rosterNextMonth: {
      month: `${MONTHS[nextM-1]} ${nextY}`,
      schedule: sched.map(e => ({ name: e.staff_name, role: e.role, day: e.day, shiftLabel: e.shift_label, group: e.role_group })),
      availability: avail.reduce((acc, a) => {
        if (!acc[a.staff_name]) acc[a.staff_name] = {};
        if (!acc[a.staff_name][a.day]) acc[a.staff_name][a.day] = [];
        acc[a.staff_name][a.day].push(a.shift_type);
        return acc;
      }, {}),
    },
  };
}

function getWeekKey(dateStr) {
  const d = new Date(dateStr);
  const dayOfWeek = d.getDay();
  const diff = d.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  const mon = new Date(d.setDate(diff));
  return mon.toISOString().slice(0,10);
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── MAIse chat endpoint ────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  const { message, history = [], from, to, outletId } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  try {
    const context = buildContext({ from, to, outletId });

    let systemPrompt = `You are MAIse, the AI assistant for The Black Hole Group (TBHG), a Singapore-based multi-brand F&B hospitality group.
You are smart, direct, and concise — like a sharp operations manager, not a chatbot.
You help with: live payroll and labour data, staff management, roster planning, leave queries, recipes, supplier info, SOPs, and any operational questions.
If the answer is in the knowledge base, use it. If it's a general hospitality/culinary question, answer from your knowledge. If it needs live data, use the data provided.
RECIPES: If a recipe IS in the RECIPE BOOK below, use only that version — its exact ingredients, quantities, and method are the source of truth, and you must not alter them from your own knowledge. If a recipe is NOT in the Recipe Book, you may suggest one from your culinary knowledge, but clearly label it as a suggestion that is NOT from the Recipe Book and has not been saved. You cannot add recipes to the Recipe Book yourself — if the user wants to keep a suggestion, tell them they can add it in the Recipe Book.
Always be practical and action-oriented.
If you genuinely cannot answer a question because the information is not in your knowledge base or data, start your response with the exact text 'UNANSWERED:' followed by your response. Do not use UNANSWERED: if you can give a useful answer, even a partial one.

CURRENT DATA CONTEXT:
${JSON.stringify(context, null, 2)}

GUIDELINES:
- Answer in 2-5 sentences max unless a detailed breakdown is requested
- Quote specific numbers from the data (e.g. "Labour was 42% last week, $1,240 above the 30% target")
- For roster suggestions, name specific staff and days based on availability data
- If the data doesn't cover the question, say so clearly rather than guessing
- Use Singapore context (SGD, F&B industry norms: healthy labour % is 25-35%, concern above 40%)
- Never make up data that isn't in the context
- RECIPES: For recipes in the RECIPE BOOK, cite only the book's exact ingredients, quantities, and method — never a modified version. For recipes not in the book, you may offer a suggestion, but clearly mark it as "not from the Recipe Book" and never imply it has been saved.
- When suggesting rosters, prioritise staff who marked availability and consider sales trends by day of week
- Format roster suggestions as a clear list: Day → Staff names → Estimated hours`;


  // Load outlets and knowledge base
  let kbContext = '';
  try {
    const db = require('../database');

    // Outlets
    const outlets = db.all('SELECT name, address FROM outlets WHERE is_active=1 ORDER BY name');
    if (outlets.length) {
      kbContext += '\n\nOUTLETS:\n' + outlets.map(o =>
        o.name + (o.address ? ' — ' + o.address : '')
      ).join('\n');
    }

    // Knowledge base entries
    const kbEntries = db.all('SELECT category, title, content FROM maise_kb ORDER BY category, title');
    if (kbEntries.length) {
      kbContext += '\n\nKNOWLEDGE BASE:\n' + kbEntries.map(e =>
        '[' + e.category + '] ' + e.title + ':\n' + e.content
      ).join('\n\n');
    }

    // Recipe Book — the ONLY permitted source for recipes
    const recipes = db.all('SELECT id, name, category, base_servings FROM recipes ORDER BY category, name');
    if (recipes.length) {
      kbContext += '\n\nRECIPE BOOK (the ONLY source for any recipe — ingredients, quantities, methods):';
      recipes.forEach(rc => {
        const ings  = db.all('SELECT name, amount, unit FROM recipe_ingredients WHERE recipe_id=? ORDER BY sort_order', [rc.id]);
        const steps = db.all('SELECT content FROM recipe_steps WHERE recipe_id=? ORDER BY sort_order', [rc.id]);
        kbContext += `\n\n● ${rc.name} [${rc.category}]` + (rc.base_servings ? ` (base servings: ${rc.base_servings})` : '');
        kbContext += '\n  Ingredients: ' + (ings.length ? ings.map(i => `${i.amount}${i.unit || ''} ${i.name}`).join(', ') : '—');
        kbContext += '\n  Method: '      + (steps.length ? steps.map((s, i) => `${i + 1}. ${s.content}`).join(' ') : '—');
      });
    } else {
      kbContext += '\n\nRECIPE BOOK: (no recipes saved yet)';
    }
  } catch(e) {}

    systemPrompt += kbContext;

    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'AI error: ' + err });
    }

    const data = await response.json();
    let reply = data.content?.[0]?.text || 'No response';

    // Log unanswered questions
    if (reply.startsWith('UNANSWERED:')) {
      try {
        const dbMod = require('../database');
        dbMod.run(
          'INSERT INTO maise_unanswered (question, asked_by, created_at) VALUES (?,?,?)',
          [message, req.session?.user?.username || 'staff', new Date().toISOString()]
        );
        dbMod.saveDB();
      } catch(e) {}
      reply = reply.replace('UNANSWERED:', '').trim();
    }

    res.json({ reply, context_summary: {
      period: context.period,
      labourPct: context.summary.labourPct,
      totalRevenue: context.summary.totalRevenue,
    }});
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Home-page suggestion chips ──────────────────────────────────────────────────
router.get('/suggestions', (req, res) => {
  try {
    res.json(db.all('SELECT id, icon, label, prompt FROM maise_suggestions ORDER BY sort_order, id'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/suggestions', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const list = Array.isArray(req.body.suggestions) ? req.body.suggestions : [];
  try {
    db.run('DELETE FROM maise_suggestions');
    list.forEach((s, i) => {
      const label = (s.label || '').toString().trim().slice(0, 80);
      if (!label) return;
      const icon   = (s.icon || '💬').toString().trim().slice(0, 8) || '💬';
      const prompt = ((s.prompt || '').toString().trim() || label).slice(0, 300);
      db.run('INSERT INTO maise_suggestions (icon,label,prompt,sort_order) VALUES (?,?,?,?)', [icon, label, prompt, i]);
    });
    db.saveDB();
    res.json({ success: true, suggestions: db.all('SELECT id, icon, label, prompt FROM maise_suggestions ORDER BY sort_order, id') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
