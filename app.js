/* app.js - Plataforma de apostas para diversão
   INSTRUÇÕES:
   - Para usar modo online com Firebase, defina um objeto global FIREBASE_CONFIG no index.html (veja comentário no index.html).
   - Se FIREBASE_CONFIG estiver ausente, o app usa localStorage (modo Local).
   - Para Firebase: crie projeto, habilite Firestore e Autenticação Anônima.
*/

(async function(){
  // ---------- Config & State ----------
  const USE_FIREBASE = (typeof FIREBASE_CONFIG !== 'undefined');
  const MODE_NAME = USE_FIREBASE ? 'Firebase (online)' : 'Local (localStorage)';
  document.getElementById('mode-name').innerText = MODE_NAME;

  // Simple utils
  const uid = () => 'u_' + Math.random().toString(36).slice(2,10);
  const nowISO = ()=>new Date().toISOString();

  // Default data structure (for local mode)
  const STORAGE_KEY = 'betfun_v1';
  let state = {
    users: {},      // id -> {id, name, balance}
    events: {},     // evId -> {...}
    bets: {},       // betId -> {...}
    createdAt: nowISO()
  };

  // ---------- Firebase setup (if provided) ----------
  let db = null, auth = null;
  if (USE_FIREBASE){
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    // sign in anonymously
    await auth.signInAnonymously().catch(console.warn);
  }

  // ---------- Persistence helpers ----------
  async function saveState(){
    if (USE_FIREBASE){
      // Save root doc (single doc) - simple approach
      const docRef = db.collection('betfun').doc('state');
      await docRef.set(state).catch(err=>console.error(err));
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  }
  async function loadState(){
    if (USE_FIREBASE){
      const doc = await db.collection('betfun').doc('state').get().catch(()=>null);
      if (doc && doc.exists){
        state = doc.data();
      } else {
        await saveState();
      }
    } else {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state = JSON.parse(raw);
      else await saveState();
    }
  }

  // ---------- User (simple) ----------
  let currentUser = null;
  async function ensureUser(){
    if (USE_FIREBASE){
      const firebaseUid = auth.currentUser ? auth.currentUser.uid : uid();
      currentUser = {id: 'fb_' + firebaseUid, name: 'Jogador', balance: 1000};
      if (!state.users[currentUser.id]) state.users[currentUser.id] = currentUser;
      await saveState();
    } else {
      let stored = localStorage.getItem('betfun_user');
      if (stored) currentUser = JSON.parse(stored);
      else {
        currentUser = {id: uid(), name: 'Jogador', balance: 1000};
        localStorage.setItem('betfun_user', JSON.stringify(currentUser));
        if (!state.users[currentUser.id]) state.users[currentUser.id] = currentUser;
        await saveState();
      }
    }
    renderUser();
  }

  // ---------- Rendering ----------
  function renderUser(){
    document.getElementById('user-id').innerText = currentUser.id.slice(0,10);
    document.getElementById('user-balance').innerText = parseInt(state.users[currentUser.id].balance);
  }

  function computeOdds(event){
    // Odds by pool, returns map option->odd (payout multiplier)
    const totals = {};
    event.options.forEach(o=>totals[o]=0);
    for (let bId in state.bets){
      const b = state.bets[bId];
      if (b.eventId !== event.id) continue;
      totals[b.choice] += Number(b.amount);
    }
    // avoid division by zero: if pool empty, equal odds 2x
    const pool = Object.values(totals).reduce((a,b)=>a+b,0);
    const odds = {};
    event.options.forEach(o=>{
      if (pool === 0) odds[o] = 2.0;
      else {
        // inverse proportional: more money => lower multiplier
        const share = (totals[o] || 0) / (pool || 1);
        // base payout = (1 / share) * 0.9 (house cut simulated)
        odds[o] = share === 0 ? 5.0 : Math.max(1.2, (1/share)*0.9);
      }
      odds[o] = Math.round(odds[o]*100)/100;
    });
    return odds;
  }

  function renderEvents(){
    const list = document.getElementById('events-list');
    list.innerHTML = '';
    const evs = Object.values(state.events).sort((a,b)=> (a.createdAt>b.createdAt? -1:1));
    if (evs.length === 0) list.innerHTML = '<div class="small">Nenhum evento. Crie um!</div>';
    evs.forEach(ev=>{
      const el = document.createElement('div'); el.className = 'event';
      const title = document.createElement('div'); title.innerHTML = `<b>${ev.name}</b> <span class="small">[${ev.id.slice(0,6)}]</span>`;
      const whenTxt = ev.endsAt ? `<div class="small">Termina: ${new Date(ev.endsAt).toLocaleString()}</div>` : '';
      const status = ev.resolved ? `<span class="good small">Resultado: ${ev.result}</span>` : (ev.endsAt && new Date() > new Date(ev.endsAt) ? `<span class="bad small">Encerrado (aguardando resultado)</span>` : `<span class="small">Aberto</span>`);
      el.appendChild(title);
      el.insertAdjacentHTML('beforeend', whenTxt + status);

      // options and bet buttons
      const odds = computeOdds(ev);
      ev.options.forEach(opt=>{
        const row = document.createElement('div'); row.className='option';
        row.innerHTML = `<div>${opt} <span class="small"> (odds ${odds[opt]})</span></div>`;
        const btn = document.createElement('button'); btn.textContent='Apostar';
        btn.onclick = ()=>openBetModal(ev.id, opt);
        row.appendChild(btn);
        el.appendChild(row);
      });

      // admin controls: declare result
      const adminRow = document.createElement('div'); adminRow.className='row';
      const resSel = document.createElement('select');
      ev.options.forEach(o=>{ const optEl=document.createElement('option'); optEl.value=o; optEl.text=o; resSel.appendChild(optEl)});
      const resBtn = document.createElement('button'); resBtn.textContent='Declarar Resultado';
      resBtn.onclick = ()=>declareResult(ev.id, resSel.value);
      adminRow.appendChild(resSel); adminRow.appendChild(resBtn);

      // view bets button
      const viewB = document.createElement('button'); viewB.textContent='Ver Apostas'; viewB.className='secondary';
      viewB.onclick = ()=>showBets(ev.id);
      adminRow.appendChild(viewB);

      el.appendChild(adminRow);
      list.appendChild(el);
    });
  }

  function renderLeaderboard(){
    const lb = document.getElementById('leaderboard-list');
    const users = Object.values(state.users).sort((a,b)=> b.balance - a.balance);
    lb.innerHTML = users.slice(0,10).map(u=>`<div>${u.name} <b>${u.balance}</b> <span class="small">(${u.id.slice(0,8)})</span></div>`).join('');
  }

  // ---------- Actions ----------
  async function createEvent(name, options, endsAt=null){
    const ev = {
      id: 'ev_' + Math.random().toString(36).slice(2,9),
      name: name,
      options: options,
      createdAt: nowISO(),
      endsAt: endsAt,
      resolved: false,
      result: null
    };
    state.events[ev.id] = ev;
    await saveState();
    renderEvents();
  }

  function openBetModal(evId, choice){
    const ev = state.events[evId];
    const amt = prompt(`Apostar em "${choice}" do evento "${ev.name}"\nSaldo: ${state.users[currentUser.id].balance}\nDigite o valor da aposta (somente números):`, "100");
    if (!amt) return;
    const n = Number(amt);
    if (isNaN(n) || n <= 0) return alert('Valor inválido');
    if (n > state.users[currentUser.id].balance) return alert('Saldo insuficiente');
    placeBet(evId, choice, n);
  }

  async function placeBet(evId, choice, amount){
    const bet = {
      id: 'b_' + Math.random().toString(36).slice(2,9),
      eventId: evId,
      choice: choice,
      amount: Number(amount),
      userId: currentUser.id,
      createdAt: nowISO()
    };
    state.bets[bet.id] = bet;
    // debit user
    state.users[currentUser.id].balance = Number(state.users[currentUser.id].balance) - Number(amount);
    await saveState();
    renderUser(); renderEvents(); renderLeaderboard();
    alert('Aposta registrada!');
  }

  async function declareResult(evId, resultChoice){
    const ev = state.events[evId];
    if (ev.resolved) return alert('Evento já resolvido');
    if (!confirm(`Declarar "${resultChoice}" como vencedor do evento "${ev.name}"? Isso irá pagar automaticamente.`)) return;
    ev.resolved = true;
    ev.result = resultChoice;
    // calculate payouts
    const odds = computeOdds(ev);
    // pay each bet on this event
    for (let bId in state.bets){
      const b = state.bets[bId];
      if (b.eventId !== evId) continue;
      if (b.choice === resultChoice){
        const payout = Math.round(b.amount * odds[b.choice]);
        state.users[b.userId].balance = (Number(state.users[b.userId].balance) || 0) + payout;
      }
    }
    await saveState();
    renderUser(); renderEvents(); renderLeaderboard();
    alert('Resultado declarado e pagamentos aplicados (créditos virtuais).');
  }

  function showBets(evId){
    const ev = state.events[evId];
    const bets = Object.values(state.bets).filter(b=>b.eventId===evId);
    if (bets.length === 0) return alert('Nenhuma aposta neste evento.');
    const lines = bets.map(b=>`${b.userId.slice(0,8)} apostou ${b.amount} em ${b.choice}`).join('\n');
    alert(`Apostas para "${ev.name}":\n\n` + lines);
  }

  // ---------- Import / Export ----------
  function exportJSON(){
    const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'betfun_backup.json'; a.click();
    URL.revokeObjectURL(url);
  }
  async function importJSON(){
    const f = document.createElement('input'); f.type='file'; f.accept='application/json';
    f.onchange = async ()=> {
      const file = f.files[0];
      if (!file) return;
      const txt = await file.text();
      try{
        const data = JSON.parse(txt);
        state = data;
        // store user local as well
        if (!USE_FIREBASE) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        await saveState();
        alert('Importado com sucesso.');
        renderAll();
      } catch(e){ alert('Arquivo inválido') }
    };
    f.click();
  }

  // ---------- UI bindings ----------
  function bindUI(){
    document.getElementById('new-event-btn').onclick = ()=> document.getElementById('create-event').classList.toggle('hidden');
    document.getElementById('create-ev-cancel').onclick = ()=> document.getElementById('create-event').classList.add('hidden');
    document.getElementById('create-ev-confirm').onclick = async ()=>{
      const name = document.getElementById('ev-name').value.trim();
      const opts = document.getElementById('ev-opts').value.split(',').map(s=>s.trim()).filter(Boolean);
      const whenVal = document.getElementById('ev-when').value;
      if (!name || opts.length < 2) return alert('Nome e pelo menos 2 opções obrigatórios');
      const endsAt = whenVal ? new Date(whenVal).toISOString() : null;
      await createEvent(name, opts, endsAt);
      document.getElementById('ev-name').value=''; document.getElementById('ev-opts').value=''; document.getElementById('ev-when').value='';
      document.getElementById('create-event').classList.add('hidden');
    };
    document.getElementById('export-btn').onclick = exportJSON;
    document.getElementById('import-btn').onclick = importJSON;
  }

  function renderAll(){ renderUser(); renderEvents(); renderLeaderboard(); }

  // ---------- Init ----------
  await loadState();
  await ensureUser();
  bindUI();
  renderAll();

  // Periodic sync (if firebase, reload from cloud every 5s)
  if (USE_FIREBASE){
    setInterval(async ()=>{
      await loadState();
      renderAll();
    }, 5000);
  }

})();
