/* MAIse — AI Manager Assistant floating widget */
(function() {
  const CSS = `
    #maise-btn {
      position: fixed; bottom: 28px; right: 16px; z-index: 1000;
      width: 54px; height: 54px; border-radius: 50%;
      background: #3D5240; border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(61,82,64,.35);
      display: flex; align-items: center; justify-content: center;
      transition: transform .15s, box-shadow .15s;
      font-family: 'DM Serif Display', serif;
    }
    #maise-btn:hover { transform: scale(1.07); box-shadow: 0 6px 28px rgba(61,82,64,.45); }
    #maise-btn .m-label { font-size: 20px; color: #fff; line-height: 1; font-style: italic; }
    #maise-btn .ai-dot { position: absolute; top: 8px; right: 8px; width: 9px; height: 9px; border-radius: 50%; background: #86EFAC; border: 2px solid #3D5240; }

    #maise-panel {
      position: fixed; bottom: 92px; right: 28px; z-index: 1000;
      width: 380px; max-height: 600px;
      max-width: calc(100vw - 20px);
      background: #fff; border-radius: 20px;
      box-shadow: 0 8px 40px rgba(26,35,24,.18), 0 0 0 1px rgba(26,35,24,.06);
      display: none; flex-direction: column; overflow: hidden;
      font-family: 'Inter', sans-serif;
    }
    #maise-panel.open { display: flex; }

    .maise-header {
      background: #1A2318; color: #fff;
      padding: 14px 18px; display: flex; align-items: center; gap: 10px; flex-shrink: 0;
    }
    .maise-header-icon {
      width: 32px; height: 32px; background: #3D5240; border-radius: 8px;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .maise-header-icon span { font-family: 'DM Serif Display', serif; font-size: 17px; color: #fff; font-style: italic; line-height: 1; }
    .maise-header-title { flex: 1; }
    .maise-header-title div:first-child { font-size: 14px; font-weight: 600; }
    .maise-header-title div:last-child { font-size: 11px; color: rgba(255,255,255,.45); margin-top: 1px; }
    .maise-close { background: none; border: none; cursor: pointer; color: rgba(255,255,255,.5); padding: 4px; border-radius: 6px; transition: color .12s; }
    .maise-close:hover { color: #fff; }
    .maise-close svg { width: 16px; height: 16px; stroke: currentColor; display: block; }

    .maise-context {
      background: #F0F2EC; border-bottom: 1px solid rgba(26,35,24,.08);
      padding: 8px 16px; display: flex; gap: 16px; flex-shrink: 0;
    }
    .maise-ctx-item { font-size: 11px; color: rgba(26,35,24,.5); }
    .maise-ctx-item strong { color: #3D5240; font-weight: 600; }

    .maise-messages {
      flex: 1; overflow-y: auto; padding: 14px 16px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .maise-msg { display: flex; flex-direction: column; gap: 3px; }
    .maise-msg.user { align-items: flex-end; }
    .maise-msg.assistant { align-items: flex-start; }
    .maise-bubble {
      max-width: 85%; padding: 9px 13px; border-radius: 14px;
      font-size: 13px; line-height: 1.55; white-space: pre-wrap;
    }
    .maise-msg.user .maise-bubble { background: #3D5240; color: #fff; border-bottom-right-radius: 4px; }
    .maise-msg.assistant .maise-bubble { background: #F0F2EC; color: #1A2318; border-bottom-left-radius: 4px; }
    .maise-msg.assistant .maise-bubble.thinking { color: rgba(26,35,24,.4); font-style: italic; }

    .maise-suggestions {
      padding: 0 16px 10px; display: flex; flex-wrap: wrap; gap: 6px; flex-shrink: 0;
    }
    .maise-chip {
      background: #F0F2EC; border: 1px solid rgba(26,35,24,.1);
      border-radius: 20px; padding: 5px 12px; font-size: 11.5px;
      color: #3D5240; cursor: pointer; transition: all .12s; font-family: inherit;
    }
    .maise-chip:hover { background: #C8D5B9; }

    .maise-input-row {
      display: flex; gap: 8px; padding: 12px 14px;
      border-top: 1px solid rgba(26,35,24,.08); flex-shrink: 0;
    }
    .maise-input {
      flex: 1; height: 38px; border: 1px solid rgba(26,35,24,.12);
      border-radius: 10px; padding: 0 12px; font-size: 13px;
      font-family: inherit; color: #1A2318; background: #F0F2EC; outline: none;
      transition: border-color .12s;
    }
    .maise-input:focus { border-color: #3D5240; background: #fff; }
    .maise-send {
      width: 38px; height: 38px; border-radius: 10px; background: #3D5240;
      border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: opacity .12s; flex-shrink: 0;
    }
    .maise-send:hover { opacity: .85; }
    .maise-send:disabled { opacity: .4; cursor: not-allowed; }
    .maise-send svg { width: 16px; height: 16px; stroke: #fff; }

    .maise-date-row {
      display: flex; gap: 8px; padding: 0 14px 10px; flex-shrink: 0;
    }
    .maise-date-row input {
      flex: 1; height: 28px; border: 1px solid rgba(26,35,24,.1);
      border-radius: 7px; padding: 0 8px; font-size: 11.5px; font-family: inherit;
      color: #1A2318; background: #F0F2EC; outline: none;
    }
    .maise-date-row label { font-size: 10.5px; color: rgba(26,35,24,.4); display: flex; align-items: center; }
  `;

  // Inject styles
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // Default date range: last 30 days
  const today = new Date();
  const from30 = new Date(today - 30*24*60*60*1000).toISOString().slice(0,10);
  const toStr  = today.toISOString().slice(0,10);

  // Build widget HTML
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <button id="maise-btn" onclick="maiseToggle()" title="MAIse — AI Manager Assistant">
      <span class="m-label">M</span>
      <div class="ai-dot"></div>
    </button>

    <div id="maise-panel">
      <div class="maise-header">
        <div class="maise-header-icon"><span>M</span></div>
        <div class="maise-header-title">
          <div>MAIse</div>
          <div>AI Manager Assistant</div>
        </div>
        <button class="maise-close" onclick="maiseToggle()">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="maise-context" id="maiseCtx">
        <div class="maise-ctx-item">Period: <strong id="maiseCtxPeriod">Last 30 days</strong></div>
        <div class="maise-ctx-item">Labour: <strong id="maiseCtxPct">—</strong></div>
      </div>

      <div class="maise-date-row">
        <label>From</label>
        <input type="date" id="maiseFrom" value="${from30}" onchange="maiseUpdateCtx()">
        <label>To</label>
        <input type="date" id="maiseTo" value="${toStr}" onchange="maiseUpdateCtx()">
      </div>

      <div class="maise-messages" id="maiseMessages">
        <div class="maise-msg assistant">
          <div class="maise-bubble">Hi! I'm MAIse. Ask me about your labour costs, overstaffing, sales trends, or roster suggestions — I'll pull the real numbers.</div>
        </div>
      </div>

      <div class="maise-suggestions" id="maiseSuggestions">
        <button class="maise-chip" onclick="maiseSend('Why was labour % high last week?')">Why was labour % high last week?</button>
        <button class="maise-chip" onclick="maiseSend('Which shifts are overstaffed?')">Which shifts are overstaffed?</button>
        <button class="maise-chip" onclick="maiseSend('Suggest next week\\'s roster based on sales trends.')">Suggest next week's roster</button>
        <button class="maise-chip" onclick="maiseSend('Which day of the week has the highest sales?')">Busiest day of the week?</button>
        <button class="maise-chip" onclick="maiseSend('Who are my highest cost staff this month?')">Highest cost staff?</button>
      </div>

      <div class="maise-input-row">
        <input class="maise-input" id="maiseInput" placeholder="Ask anything about your restaurant…" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();maiseSendInput();}">
        <button class="maise-send" id="maiseSendBtn" onclick="maiseSendInput()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(wrapper);

  // State
  let history = [];
  let isOpen  = false;

  window.maiseToggle = function() {
    isOpen = !isOpen;
    document.getElementById('maise-panel').classList.toggle('open', isOpen);
    if (isOpen) {
      maiseUpdateCtx();
      document.getElementById('maiseInput').focus();
    }
  };

  window.maiseUpdateCtx = async function() {
    const from = document.getElementById('maiseFrom').value;
    const to   = document.getElementById('maiseTo').value;
    if (!from || !to) return;
    document.getElementById('maiseCtxPeriod').textContent = `${from} – ${to}`;
    try {
      const r = await fetch(`/api/revenue/summary?from=${from}&to=${to}`);
      const d = await r.json();
      const pctEl = document.getElementById('maiseCtxPct');
      if (d.pct !== null && d.pct !== undefined) {
        pctEl.textContent = d.pct + '%';
        pctEl.style.color = d.pct <= 30 ? '#2E6B3E' : d.pct <= 40 ? '#B7791F' : '#C0392B';
      } else {
        pctEl.textContent = 'No data';
      }
    } catch(e) {}
  };

  window.maiseSend = function(msg) {
    document.getElementById('maiseInput').value = msg;
    maiseSendInput();
  };

  window.maiseSendInput = async function() {
    const input = document.getElementById('maiseInput');
    const msg   = input.value.trim();
    if (!msg) return;
    input.value = '';
    document.getElementById('maiseSuggestions').style.display = 'none';

    // Add user message
    appendMsg('user', msg);
    history.push({ role: 'user', content: msg });

    // Thinking indicator
    const thinkId = appendMsg('assistant', 'Thinking…', true);
    document.getElementById('maiseSendBtn').disabled = true;

    const from = document.getElementById('maiseFrom').value;
    const to   = document.getElementById('maiseTo').value;

    try {
      const r = await fetch('/api/maise/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, history: history.slice(-6), from, to })
      });
      const d = await r.json();
      removeMsg(thinkId);

      if (d.reply) {
        appendMsg('assistant', d.reply);
        history.push({ role: 'assistant', content: d.reply });
        // Keep history from getting too long
        if (history.length > 12) history = history.slice(-12);
      } else {
        appendMsg('assistant', 'Sorry, I couldn\'t get a response. ' + (d.error || ''));
      }
    } catch(e) {
      removeMsg(thinkId);
      appendMsg('assistant', 'Network error. Please try again.');
    }

    document.getElementById('maiseSendBtn').disabled = false;
  };

  let msgCounter = 0;
  function appendMsg(role, text, thinking = false) {
    const id = 'maise-msg-' + (++msgCounter);
    const el = document.createElement('div');
    el.className = `maise-msg ${role}`;
    el.id = id;
    el.innerHTML = `<div class="maise-bubble${thinking ? ' thinking' : ''}">${escHtml(text)}</div>`;
    document.getElementById('maiseMessages').appendChild(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return id;
  }

  function removeMsg(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Initial context load
  setTimeout(maiseUpdateCtx, 500);
})();
