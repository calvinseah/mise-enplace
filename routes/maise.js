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

    const systemPrompt = `You are MAIse, an AI manager assistant for a restaurant management platform called Mise.
You are smart, direct, and concise — like a sharp operations manager, not a chatbot.
You have access to real data from the restaurant's attendance, sales, and roster systems.

CURRENT DATA CONTEXT:
${JSON.stringify(context, null, 2)}

GUIDELINES:
- Answer in 2-5 sentences max unless a detailed breakdown is requested
- Quote specific numbers from the data (e.g. "Labour was 42% last week, $1,240 above the 30% target")
- For roster suggestions, name specific staff and days based on availability data
- If the data doesn't cover the question, say so clearly rather than guessing
- Use Singapore context (SGD, F&B industry norms: healthy labour % is 25-35%, concern above 40%)
- Never make up data that isn't in the context
- When suggesting rosters, prioritise staff who marked availability and consider sales trends by day of week
- Format roster suggestions as a clear list: Day → Staff names → Estimated hours`;

    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const reply = data.content?.[0]?.text || 'No response';
    res.json({ reply, context_summary: {
      period: context.period,
      labourPct: context.summary.labourPct,
      totalRevenue: context.summary.totalRevenue,
    }});
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
