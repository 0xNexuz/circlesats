const $ = id => document.getElementById(id);
let state = null;
let selected = null;
let toastTimer;
let lastSnapshot;
let me = null;
let nwc = null;
let nwcNetwork = null;
let initialRefreshReported = false;
let entryMode = 'choose';

// A guest's demo wallet may be a private Alby sandbox wallet (real NWC invoices,
// test sats). Copy must then say so instead of calling payments simulated.
// Practice wallets: 'mainnet' (real Bitcoin Lightning, paid from the visitor's
// own wallet), 'mutinynet' (real Lightning payments on the Mutinynet test
// network, paid by its faucet) or 'alby-sandbox' (wallet-to-wallet test sats).
const practiceKind = () => ['mainnet', 'mutinynet', 'alby-sandbox'].includes(me?.wallet?.kind) ? me.wallet.kind : null;
const sandboxWallet = () => practiceKind() !== null;
const realPractice = () => practiceKind() === 'mutinynet';
const mainnetPractice = () => practiceKind() === 'mainnet';
let mainnetWatch = null;

function paymentLabel() {
  if (state.mode === 'demo') return mainnetPractice() ? 'BITCOIN LIGHTNING · REAL SATS' : realPractice() ? 'MUTINYNET LIGHTNING · TEST COINS' : sandboxWallet() ? 'ALBY SANDBOX · TEST SATS' : 'SIMULATED SATS';
  if (state.environment === 'alby-sandbox') return 'ALBY SANDBOX · TEST SATS';
  return `${state.environment.toUpperCase()} · ${state.network.toUpperCase()}`;
}

function reportInitialReadiness(ok) {
  if (initialRefreshReported) return;
  initialRefreshReported = true;
  window.__circleCriticalReady = { ok };
  window.dispatchEvent(new CustomEvent('circlesats:critical-ready', { detail: { ok } }));
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

async function mutate(path, payload = {}) {
  return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me?.csrf || '' }, body: JSON.stringify(payload) });
}

function action(label, callback, secondary = false, busyLabel = 'Working…') {
  const button = document.createElement('button');
  button.type = 'button'; button.className = `action${secondary ? ' secondary' : ''}`; button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = busyLabel;
    try { await callback(); } catch (error) { toast(error.message); }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = label; }
  });
  return button;
}

function scrollToSection(id) {
  $(id).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function organizerGuide() {
  const guide = document.createElement('details'); guide.className = 'organizer-guide';
  if (window.__CIRCLESATS_STATIC_DEMO) {
    guide.innerHTML = mainnetPractice()
      ? '<summary>About this public demo <span aria-hidden="true">↗</span></summary><div class="organizer-guide-body"><p>This preview runs a private practice circle in your browser. Your contribution is a real Bitcoin Lightning payment: the invoice comes from the circle’s demo treasurer wallet and you pay it from your own Lightning wallet. It moves real sats (100 sats, a few cents) and is not refunded. No wallet? At the payment step you can switch to free Mutinynet test coins. Your receipt shows the payment hash and, when the wallet provides it, the preimage, so you can check that SHA-256(preimage) equals the hash. Other members’ payments, approvals, and payouts are simulated. Your demo resets when you reload the page.</p></div>'
      : realPractice()
      ? '<summary>About this public demo <span aria-hidden="true">↗</span></summary><div class="organizer-guide-body"><p>This preview runs a private practice circle in your browser. Your contribution is a real Lightning payment on Mutinynet, a public Bitcoin test network: the invoice comes from the circle treasurer’s node and the Mutinynet faucet’s node pays it over a real Lightning channel. The coins are test coins with no market value. Your receipt shows the payment hash and preimage, so you can check that SHA-256(preimage) equals the hash. Other members’ payments, approvals, and payouts are simulated. Your demo resets when you reload the page.</p></div>'
      : sandboxWallet()
      ? '<summary>About this public demo <span aria-hidden="true">↗</span></summary><div class="organizer-guide-body"><p>This preview runs a private practice circle in your browser. Your demo wallet is a private Alby Developer Sandbox wallet: your contribution is a real Lightning invoice paid over Nostr Wallet Connect with test sats that have no value. Other members’ payments, approvals, and payouts are simulated. Your demo resets when you reload the page.</p></div>'
      : '<summary>About this public demo <span aria-hidden="true">↗</span></summary><div class="organizer-guide-body"><p>This preview runs a private simulation in your browser. Sats, receipts, approvals, and payouts here are simulated. Your demo resets when you reload the page. Member access and Lightning receiving require the separately hosted Node app.</p></div>';
    return guide;
  }
  if (state.environment === 'alby-sandbox' && state.mode === 'lightning') {
    guide.innerHTML = `<summary>How do sandbox payments work? <span aria-hidden="true">↗</span></summary>
      <div class="organizer-guide-body"><p>CircleSats uses two Alby Developer Sandbox wallets: one receives and one pays. The sats and invoices are fake and cannot move real Bitcoin. The sandbox wallet reports “mainnet” through NWC, so the app also checks the designated payer wallet’s public key.</p>
      <ol><li>Sign in with your member access code and create your 100 sat invoice.</li><li>Pay with the designated sandbox payer wallet in this tab, or copy the invoice into that same sandbox wallet.</li><li>CircleSats checks the receiver’s settled invoice, verifies its amount and hash, and saves the receipt before the round can be approved.</li></ol>
      <div class="guide-links"><a href="https://guides.getalby.com/developer-guide/developer-guide/developer-sandbox" target="_blank" rel="noopener noreferrer">Alby Developer Sandbox ↗</a></div>
      <p class="guide-secret-note">The receiving connection stays on the server. Treat both sandbox NWC URLs as private credentials.</p></div>`;
    return guide;
  }
  guide.innerHTML = `<summary>Setting up real testnet payments? <span aria-hidden="true">↗</span></summary>
    <div class="organizer-guide-body"><p>This instance is ${state.mode === 'demo' ? 'a simulation. It needs a testnet receiving wallet before external wallets can pay here.' : 'connected to Lightning. Members need an access code and a wallet on the same network.'} The receiver and payer are separate.</p>
    <ol><li><strong>Receiver:</strong> use a signet Lightning wallet that supports receive-only NWC (<code>make_invoice</code> and <code>lookup_invoice</code>), or a signet-backed LNbits wallet.</li><li><strong>CircleSats:</strong> set <code>LIGHTNING_PROVIDER=nwc</code> and <code>NWC_RECEIVER_CONNECTION_SECRET</code>, or choose <code>lnbits</code> with its invoice key. Set <code>PAYMENT_ENVIRONMENT=signet</code> and <code>LNBITS_NETWORK=signet</code> for either path. Keep the receiver secret on the server.</li><li><strong>Payer:</strong> fund a separate compatible test wallet, then pay a test invoice externally or connect a small-budget NWC connection with <code>pay_invoice</code> permission.</li></ol>
    <div class="guide-links"><a href="https://docs.voltage.cloud/development-sandbox" target="_blank" rel="noopener noreferrer">Voltage test environment ↗</a><a href="https://docs.lnbits.com/guide/installation/first-setup" target="_blank" rel="noopener noreferrer">LNbits setup ↗</a><a href="https://faucet.mutinynet.com/" target="_blank" rel="noopener noreferrer">Mutinynet faucet ↗</a><a href="https://guides.getalby.com/user-guide/alby-hub/alby-hub-flavors/desktop" target="_blank" rel="noopener noreferrer">Alby Hub for Windows ↗</a></div>
    <p class="guide-secret-note">Keep receiving-wallet keys on the server. Only a limited payer connection belongs in this page.</p></div>`;
  return guide;
}

function renderMemberLogin(panel) {
  const header = document.createElement('div'); header.className = 'entry-form-head';
  const back = document.createElement('button'); back.type = 'button'; back.className = 'entry-back'; back.textContent = '← All options';
  back.addEventListener('click', () => { entryMode = 'choose'; renderWallet(); });
  header.append(back);
  const title = document.createElement('h4'); title.textContent = 'Enter your circle';
  const description = document.createElement('p'); description.textContent = 'Use the private access code supplied by your circle organizer. Payments are linked to the member account you choose.';
  header.append(title, description);
  const form = document.createElement('form'); form.className = 'login-form entry-login-form';
  const select = document.createElement('select'); select.required = true; select.setAttribute('aria-label', 'Member name');
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose your name'; select.append(placeholder);
  for (const member of state.group.members) { const option = document.createElement('option'); option.value = member.id; option.textContent = member.name; select.append(option); }
  if (selected) select.value = selected;
  const code = document.createElement('input'); code.type = 'password'; code.required = true; code.autocomplete = 'one-time-code'; code.placeholder = 'Private access code'; code.setAttribute('aria-label', 'Private access code');
  const submit = document.createElement('button'); submit.className = 'action'; submit.type = 'submit'; submit.textContent = 'Sign in to continue';
  form.append(select, code, submit);
  form.addEventListener('submit', async event => { event.preventDefault(); submit.disabled = true; submit.setAttribute('aria-busy', 'true'); submit.textContent = 'Signing in…';
    try { me = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId: select.value, code: code.value }) }); code.value = ''; selected = me.memberId; await refresh(true); toast('Signed in.'); }
    catch (error) { toast(error.message); submit.disabled = false; submit.removeAttribute('aria-busy'); submit.textContent = 'Sign in to continue'; }
  });
  panel.append(header, form);
}

function renderEntry(panel) {
  const intro = document.createElement('div'); intro.className = 'entry-intro';
  intro.innerHTML = window.__CIRCLESATS_STATIC_DEMO
    ? '<span class="entry-eyebrow">A CLEAR WAY IN <span aria-hidden="true">✳</span></span><h4>Your circle starts here.</h4><p>Explore a private simulation in this browser. It resets when you reload.</p>'
    : '<span class="entry-eyebrow">A CLEAR WAY IN <span aria-hidden="true">✳</span></span><h4>Your circle starts here.</h4><p>Take a private, simulated tour or enter with your member access code.</p>';
  panel.append(intro);
  if (entryMode === 'choose') {
    const choices = document.createElement('div'); choices.className = 'entry-choices';
    const demo = document.createElement('article'); demo.className = 'entry-choice entry-choice-featured';
    demo.innerHTML = '<span class="entry-choice-symbol" aria-hidden="true">◎</span><span class="entry-choice-tag">01 · NO SETUP</span><h5>Explore the demo</h5><p>Try a contribution, approve a payout, and follow the full rotation through four rounds.</p><span class="entry-choice-foot">Private sample ledger · no real funds</span>';
    demo.append(action('Start guided demo ↗', async () => { await request('/api/auth/demo', { method: 'POST' }); selected = null; await refresh(true); scrollToSection('wallet-section'); toast('Your private demo is ready.'); }, false, 'Opening demo…'));
    const member = document.createElement('article'); member.className = 'entry-choice';
    member.innerHTML = '<span class="entry-choice-symbol" aria-hidden="true">ϟ</span><span class="entry-choice-tag">02 · MEMBER ACCESS</span><h5>I’m in this circle</h5><p>Use the access code from your organizer to make a contribution under your member account.</p><span class="entry-choice-foot">Your account · your receipt</span>';
    member.append(action('Enter member code ↗', () => { entryMode = 'member'; renderWallet(); $('wallet-panel').querySelector('select')?.focus(); }, true));
    choices.append(demo);
    if (!window.__CIRCLESATS_STATIC_DEMO) choices.append(member);
    panel.append(choices);
  } else renderMemberLogin(panel);
  panel.append(organizerGuide());
}

function renderWallet() {
  const panel = $('wallet-panel'); panel.replaceChildren();
  $('network-label').textContent = paymentLabel();
  if (!me?.memberId) {
    renderEntry(panel); return;
  }
  const name = state.group.members.find(member => member.id === me.memberId)?.name || 'Member';
  const guest = me.kind === 'guest-demo';
  const heading = document.createElement('p'); heading.className = 'wallet-greeting'; heading.textContent = guest ? `Your private demo · ${name}` : `Signed in as ${name}`;
  panel.append(heading);
  if (guest) {
    const guestNote = document.createElement('p'); guestNote.className = 'guest-note'; guestNote.textContent = realPractice() || mainnetPractice()
      ? 'This is an isolated practice circle with its own invoices. It does not verify your identity or change the circle’s shared ledger.'
      : sandboxWallet()
      ? 'This is an isolated practice circle with its own sandbox wallets. It does not verify your identity or change the circle’s shared ledger.'
      : 'This is an isolated simulation. It does not verify your identity or change the circle’s shared ledger.'; panel.append(guestNote);
  }
  if (state.mode === 'demo') {
    if (guest) {
      const progress = document.createElement('div'); progress.className = 'demo-steps';
      const currentStep = !me.wallet ? 1 : !me.wallet.claimed ? 2 : statusOf(me.memberId) === 'paid' ? 4 : 3;
      for (const [index, label] of ['Create wallet', 'Get demo sats', 'Make contribution'].entries()) {
        const step = document.createElement('span'); step.className = `demo-step${currentStep > index + 1 ? ' done' : ''}${currentStep === index + 1 ? ' active' : ''}`;
        step.textContent = `${String(index + 1).padStart(2, '0')} ${label}`; progress.append(step);
      }
      panel.append(progress);
    }
    const balance = document.createElement('strong'); balance.className = 'wallet-balance'; balance.textContent = me.wallet ? `${me.wallet.balanceSats} ${mainnetPractice() ? 'sats to pay from your wallet' : realPractice() ? 'test sats to pay' : sandboxWallet() ? 'test sats' : 'demo sats'}` : 'No demo wallet yet'; panel.append(balance);
    const note = document.createElement('p'); note.textContent = mainnetPractice()
      ? 'Your contribution is a real Bitcoin Lightning payment from your own wallet to this circle’s demo treasurer wallet. It moves real sats and is not refunded. No Lightning wallet? You can switch to free test coins at the payment step.'
      : realPractice()
      ? 'Your demo wallet pays through the public Mutinynet faucet: each payment is a real Lightning payment from the faucet’s node to this circle’s treasurer node on the Mutinynet test network. Test coins only; they have no market value.'
      : sandboxWallet()
      ? 'Your demo wallet is a private Alby Developer Sandbox wallet. Contributions are real Lightning invoices paid over Nostr Wallet Connect, using test sats with no real value.'
      : 'Demo sats are simulated and cannot be sent to a real Lightning wallet.'; panel.append(note);
    const externalNote = document.createElement('p'); externalNote.className = 'wallet-hint'; externalNote.textContent = 'To use an external testnet wallet, the organizer first needs to connect a Lightning receiver. See the setup guide below.'; panel.append(externalNote);
    const controls = document.createElement('div'); controls.className = 'actions';
    if (!me.wallet) controls.append(action('Create demo wallet', async () => { await mutate('/api/wallet/create'); await refresh(true); }, false, 'Creating wallet…'));
    else if (!me.wallet.claimed) controls.append(action(`Get ${state.group.amountSats * 2} demo sats for this round`, async () => { await mutate('/api/wallet/claim-demo'); await refresh(true); }, false, 'Adding demo sats…'));
    else controls.append(action(statusOf(me.memberId) === 'paid' ? 'View my receipt' : 'Go to my contribution', () => selectMember(me.memberId), true));
    if (guest) controls.append(action('Explore the savings cycle', () => scrollToSection('cycle-section'), true));
    if (guest && statusOf(me.memberId) === 'paid') controls.append(action('Replay demo', async () => { await mutate('/api/auth/logout'); me = null; await request('/api/auth/demo', { method: 'POST' }); selected = null; await refresh(true); }, true, 'Resetting demo…'));
    panel.append(controls);
  } else {
    const note = document.createElement('p'); note.textContent = state.environment === 'alby-sandbox'
      ? 'This is the Alby Developer Sandbox. Payments use fake test sats. Connect only this circle’s designated sandbox payer wallet; its NWC connection stays in this browser tab.'
      : 'Connect a Nostr Wallet Connect wallet to pay here, or use any external wallet with the invoice link. The NWC connection stays in this browser tab.'; panel.append(note);
    const form = document.createElement('form'); form.className = 'login-form';
    const uri = document.createElement('input'); uri.type = 'password'; uri.placeholder = 'nostr+walletconnect://…'; uri.setAttribute('aria-label', 'NWC connection secret');
    uri.autocomplete = 'off'; uri.autocapitalize = 'off'; uri.spellcheck = false; uri.required = true;
    const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'action'; submit.textContent = nwc ? 'Replace wallet' : 'Connect external wallet';
    form.append(uri, submit);
    form.addEventListener('submit', async event => { event.preventDefault(); submit.disabled = true; submit.setAttribute('aria-busy', 'true'); submit.textContent = 'Connecting…';
      try { const { connectNwc } = await import('/nwc.bundle.js'); const result = await connectNwc(uri.value.trim());
        if (state.network === 'unknown' || result.network !== state.network) { result.client.close(); throw new Error('Wallet network must match the configured receiving network.'); }
        if (state.environment === 'alby-sandbox' && (!state.sandboxPayerWalletPubkey || result.walletPubkey !== state.sandboxPayerWalletPubkey)) {
          result.client.close(); throw new Error('Use the designated Alby sandbox payer wallet. This invoice uses fake test sats.');
        }
        nwc?.close(); nwc = result.client; nwcNetwork = result.network; uri.value = ''; renderWallet(); renderPayment(); toast(`${result.alias} connected.`);
      } catch (error) { toast(error.message); } finally { submit.disabled = false; submit.removeAttribute('aria-busy'); submit.textContent = nwc ? 'Replace wallet' : 'Connect external wallet'; }
    });
    panel.append(form);
    const connected = document.createElement('p'); connected.className = 'wallet-hint'; connected.textContent = nwc
      ? state.environment === 'alby-sandbox' ? 'Sandbox payer connected · fake test sats.' : `Connected on ${nwcNetwork}. Payment permission is controlled in your wallet.`
      : state.environment === 'alby-sandbox' ? 'The sandbox wallet reports mainnet, but its sats are fake. A real mainnet wallet cannot be connected here.'
        : 'NWC requires pay_invoice permission. Use a wallet connection with a small budget.'; panel.append(connected);
    if (nwc) panel.append(action('Disconnect wallet', () => {
      nwc.close(); nwc = null; nwcNetwork = null; renderWallet(); renderPayment(); toast('Wallet disconnected from this tab.');
    }, true));
  }
  panel.append(action(guest ? 'Leave demo' : 'Sign out', async () => { await mutate('/api/auth/logout'); me = null; nwc?.close(); nwc = null; selected = null; entryMode = 'choose'; await refresh(true); }, true, 'Leaving…'));
  panel.append(organizerGuide());
}

function latest(memberId) {
  const roundId = state.round?.id || state.cycle.rounds.at(-1)?.id;
  return [...state.records].reverse().find(record => record.memberId === memberId && record.roundId === roundId);
}

function statusOf(memberId) {
  return latest(memberId)?.status || 'due';
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
}

function renderCycle() {
  const panel = $('cycle-panel'); panel.replaceChildren();
  const group = state.group; const cycle = state.cycle; const round = state.round;
  const guest = me?.kind === 'guest-demo';
  $('cycle-intro').textContent = `${group.name} · ${group.members.length} members · ${group.amountSats} sats each · ${group.frequency}`;

  const overview = element('div', 'cycle-overview');
  const overviewText = element('div', 'cycle-overview-copy');
  overviewText.append(element('span', 'cycle-kicker', state.mode === 'demo' ? 'PRIVATE SIMULATION' : paymentLabel()));
  overviewText.append(element('h3', '', cycle.status === 'completed' ? 'Every member had their turn.' : `Round ${round.number} of ${cycle.rounds.length} · ${round.recipientName} receives next`));
  overviewText.append(element('p', '', cycle.status === 'completed'
    ? 'The full rotation is complete. Every payout shown here was simulated unless its round explicitly says otherwise.'
    : `${round.confirmedSats} of ${round.expectedSats} sats confirmed · ${round.paidCount} of ${round.memberCount} contributions · deadline ${new Date(round.deadlineAt).toLocaleDateString()}.`));
  overview.append(overviewText);
  const badge = element('div', 'cycle-status', cycle.status === 'completed' ? 'CYCLE COMPLETE' : round.phase.replaceAll('_', ' ').toUpperCase());
  overview.append(badge); panel.append(overview);

  const timeline = element('ol', 'rotation-timeline'); timeline.setAttribute('aria-label', 'Payout rotation');
  for (const item of cycle.rounds) {
    const card = element('li', `rotation-item ${item.phase}`);
    card.append(element('span', 'rotation-index', `ROUND ${String(item.number).padStart(2, '0')}`));
    card.append(element('strong', '', item.recipientName));
    card.append(element('small', '', item.phase === 'completed' ? 'Payout simulated · completed' : item.phase === 'scheduled' ? 'Upcoming turn' : item.phase.replaceAll('_', ' ')));
    timeline.append(card);
  }
  panel.append(timeline);

  if (guest && cycle.number === 1 && state.records.length === 0) {
    const custom = element('details', 'cycle-custom');
    custom.append(element('summary', '', 'Create your own private demo circle'));
    const form = element('form', 'cycle-custom-form');
    const fields = [
      ['Circle name', 'name', 'text', 'Dakar Market Circle'],
      ['What is this circle for?', 'description', 'text', 'A weekly community savings circle'],
      ['Member names, separated by commas', 'members', 'text', 'Awa, Mamadou, Fatou, Ibrahima'],
      ['Contribution per member (sats)', 'amountSats', 'number', '100'],
      ['Start date', 'startDate', 'date', new Date().toISOString().slice(0, 10)]
    ];
    for (const [labelText, key, type, value] of fields) {
      const label = element('label', '', labelText);
      const input = element('input'); input.name = key; input.type = type; input.value = value; input.required = true;
      if (type === 'number') { input.min = '1'; input.max = '1000000'; }
      label.append(input); form.append(label);
    }
    const frequencyLabel = element('label', '', 'Contribution frequency');
    const frequency = element('select'); frequency.name = 'frequency';
    for (const value of ['weekly','monthly']) { const option = element('option', '', value[0].toUpperCase() + value.slice(1)); option.value = value; frequency.append(option); }
    frequencyLabel.append(frequency); form.append(frequencyLabel);
    const submit = element('button', 'action', 'Create private circle'); submit.type = 'submit'; form.append(submit);
    form.addEventListener('submit', async event => {
      event.preventDefault(); submit.disabled = true; submit.textContent = 'Creating…';
      try {
        const data = new FormData(form);
        await mutate('/api/demo/group', { name: data.get('name'), description: data.get('description'), members: String(data.get('members')).split(',').map(name => name.trim()),
          amountSats: Number(data.get('amountSats')), startDate: data.get('startDate'), frequency: data.get('frequency') });
        selected = null; await refresh(true); toast('Your private circle is ready.');
      } catch (error) { toast(error.message); submit.disabled = false; submit.textContent = 'Create private circle'; }
    });
    custom.append(form); panel.append(custom);
  }

  if (round) {
    const work = element('div', 'cycle-work');
    const contributions = element('article', 'cycle-step-card');
    contributions.append(element('span', 'cycle-step-number', '01 / CONTRIBUTE'));
    contributions.append(element('h3', '', 'Fill this round'));
    contributions.append(element('p', '', `${round.paidCount}/${round.memberCount} members paid. Only confirmed contributions count toward the ${round.expectedSats} sat pool.`));
    const memberList = element('div', 'cycle-member-list');
    for (const member of group.members) {
      const paid = !round.pendingMemberIds.includes(member.id);
      const row = element('div', 'cycle-member');
      row.append(element('span', 'cycle-member-name', member.name));
      row.append(element('span', paid ? 'cycle-paid' : 'cycle-due', paid ? 'PAID' : Date.now() > Date.parse(round.deadlineAt) ? 'OVERDUE' : 'DUE'));
      if (guest && !paid && round.phase === 'open') row.append(action(`Simulate ${member.name}’s payment`, async () => {
        await mutate('/api/demo/contribute', { memberId: member.id }); await refresh(true);
        toast(`${member.name}’s simulated contribution recorded.`);
      }, true, 'Recording…'));
      memberList.append(row);
    }
    contributions.append(memberList);
    if (!guest && round.phase === 'open') contributions.append(element('p', 'cycle-help', window.__CIRCLESATS_STATIC_DEMO
      ? 'Start the guided demo to simulate each member’s contribution.'
      : 'Members sign in with their own access codes and pay from the wallet section.'));
    work.append(contributions);

    const approval = element('article', 'cycle-step-card');
    approval.append(element('span', 'cycle-step-number', '02 / APPROVE'));
    approval.append(element('h3', '', `Approve ${round.recipientName}’s payout`));
    approval.append(element('p', '', `${round.approvals.length}/${round.approvalsRequired} approvals · ${round.expectedSats} sats proposed. The recipient cannot approve their own payout.`));
    if (round.phase === 'open') approval.append(element('p', 'cycle-help', 'Awaiting all member contributions.'));
    else {
      for (const member of group.members.filter(item => item.id !== round.recipientId)) {
        const approved = round.approvals.some(item => item.memberId === member.id);
        const row = element('div', 'cycle-member'); row.append(element('span', 'cycle-member-name', member.name));
        row.append(element('span', approved ? 'cycle-paid' : 'cycle-due', approved ? 'APPROVED' : 'AWAITING'));
        if (!approved && ['funded','approved'].includes(round.phase) && (guest || me?.memberId === member.id)) row.append(action(guest ? `Simulate ${member.name}’s approval` : 'Approve payout', async () => {
          await mutate('/api/round/approve', guest ? { memberId: member.id } : {}); await refresh(true);
          toast('Approval recorded. No payout has been sent.');
        }, true, 'Recording…'));
        approval.append(row);
      }
    }
    work.append(approval);

    const payout = element('article', 'cycle-step-card cycle-payout');
    payout.append(element('span', 'cycle-step-number', '03 / SETTLE'));
    payout.append(element('h3', '', 'Record the payout'));
    payout.append(element('p', '', round.phase === 'approved' ? 'Payout approved — transfer not yet confirmed.' :
      round.phase === 'settlement_pending' ? 'A transfer reference was recorded. The transfer remains unverified and this round cannot advance.' :
      'Settlement can begin only after every required approval.'));
    if (round.phase === 'approved' && state.mode === 'demo' && (guest || me?.memberId === group.organizerId)) payout.append(action('Simulate payout & open next round', async () => {
      await mutate('/api/round/settle-demo'); selected = null; await refresh(true);
      toast('Simulated payout recorded. The next scheduled round is open.');
    }, false, 'Advancing…'));
    if (round.phase === 'approved' && state.mode === 'lightning' && me?.memberId === group.organizerId) {
      const form = element('form', 'settlement-form');
      const label = element('label', '', 'External payment reference (unverified claim)');
      const input = element('input'); input.required = true; input.minLength = 8; input.maxLength = 160; input.placeholder = 'Payment hash or transfer reference'; label.append(input); form.append(label);
      const submit = element('button', 'action secondary', 'Record unverified claim'); submit.type = 'submit'; form.append(submit);
      form.addEventListener('submit', async event => { event.preventDefault(); submit.disabled = true;
        try { await mutate('/api/round/settlement-claim', { reference: input.value }); await refresh(true); }
        catch (error) { toast(error.message); submit.disabled = false; }
      }); payout.append(form);
    }
    if (round.settlement.reference) payout.append(element('small', 'cycle-reference', `Reference: ${round.settlement.reference}`));
    work.append(payout); panel.append(work);
  } else {
    const complete = element('div', 'cycle-complete');
    complete.append(element('span', 'cycle-kicker', 'A COMPLETE ROTATION'));
    complete.append(element('h3', '', `${cycle.rounds.length} rounds. ${cycle.rounds.length} scheduled recipients.`));
    complete.append(element('p', '', 'The completed rounds and their simulated settlement records are preserved below.'));
    if (guest || me?.memberId === group.organizerId) complete.append(action('Start another cycle', async () => {
      await mutate('/api/cycle/new'); selected = null; await refresh(true); toast('A new cycle is open.');
    }, false, 'Starting…'));
    panel.append(complete);
  }

  const history = element('details', 'cycle-history');
  history.append(element('summary', '', `Round history & audit · ${cycle.rounds.filter(item => item.phase === 'completed').length} completed`));
  for (const item of cycle.rounds.filter(item => item.phase === 'completed')) {
    const line = element('div', 'cycle-history-row');
    line.append(element('strong', '', `Round ${item.number} · ${item.recipientName}`));
    line.append(element('span', '', `${item.confirmedSats} sats contributed · ${item.approvals.length} approvals · ${item.settlement.status} payout`));
    history.append(line);
  }
  for (const old of state.cycles.filter(item => item.id !== cycle.id && item.status === 'completed')) {
    history.append(element('p', 'cycle-history-row', `Cycle ${old.number}: ${old.rounds.length} rounds completed · ${new Date(old.completedAt).toLocaleDateString()}`));
  }
  panel.append(history);
}

function render() {
  if (!state) return;
  const viewRound = state.round || state.cycle.rounds.at(-1);
  const paid = state.group.members.filter(member => statusOf(member.id) === 'paid').length;
  const remaining = state.group.members.length - paid;
  $('collected').textContent = new Intl.NumberFormat().format(viewRound.confirmedSats);
  $('paid-count').textContent = String(paid);
  $('round-member-count').textContent = String(state.group.members.length);
  $('hero-group-name').textContent = state.group.name.toUpperCase();
  $('round-name').textContent = state.round ? `Round ${viewRound.number} · ${viewRound.recipientName}’s turn` : 'Cycle complete · every turn counted';
  $('contribution-amount').innerHTML = `${new Intl.NumberFormat().format(state.group.amountSats)} <small>sats</small>`;
  $('round-target').innerHTML = `${new Intl.NumberFormat().format(viewRound.expectedSats)} <small>sats</small>`;
  $('member-count-label').textContent = `${state.group.members.length} MEMBERS`;
  $('progress-value').textContent = `${Math.round(paid / state.group.members.length * 100)}%`;
  $('donut').style.setProperty('--progress', `${paid / state.group.members.length * 100}%`);
  $('remaining').innerHTML = `${new Intl.NumberFormat().format(viewRound.remainingSats)} <small>sats</small>`;
  $('remaining-members').textContent = `${remaining} contribution${remaining === 1 ? '' : 's'} remaining`;
  $('connection').classList.toggle('off', !state.walletConnected && !sandboxWallet());
  $('connection').lastElementChild.textContent = state.walletConnected || sandboxWallet() ? paymentLabel() : 'Simulated demo';
  $('round-mode-label').textContent = state.cycle.status === 'completed' ? 'CYCLE COMPLETE' : state.mode === 'demo' ? `DEMO ROUND ${viewRound.number}` : `ROUND ${viewRound.number}`;
  $('dashboard-kicker').textContent = me?.kind === 'guest-demo' ? 'YOUR PRACTICE SPACE' : 'YOUR SHARED SPACE';
  $('dashboard-description').textContent = me?.kind === 'guest-demo' ? 'A private sample, separate from the circle’s shared records.' : 'Everything you need for this round, together in one place.';
  $('trust-copy').textContent = state.walletConnected ? 'Payment status checked with the Lightning wallet'
    : mainnetPractice() || realPractice() ? 'Your contribution is a real Lightning payment; other members are simulated'
    : sandboxWallet() ? 'Your contribution uses Alby sandbox test sats; other members are simulated'
    : 'Explore the flow with clearly simulated sats';
  $('ledger-copy').textContent = me?.kind === 'guest-demo' ? 'Your private sample ledger is temporary and separate from the shared circle.' : state.walletConnected ? 'Only Lightning wallet-confirmed payments count toward the total.' : 'Only completed simulated contributions count toward the demo total.';
  $('members-description').textContent = me?.kind === 'guest-demo' ? 'A private practice round. Try Awa’s contribution, then replay whenever you like.'
    : window.__CIRCLESATS_STATIC_DEMO ? 'Start the guided demo to explore this simulated four-member circle.'
    : 'Sign in with your member access code, then contribute from a demo wallet or a connected Lightning wallet.';

  const list = $('members');
  list.replaceChildren();
  for (const member of state.group.members) {
    const status = statusOf(member.id);
    const row = document.createElement('div'); row.className = `member-row${selected === member.id ? ' selected' : ''}`;
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = member.name[0];
    const info = document.createElement('div'); info.className = 'member-info';
    const name = document.createElement('strong'); name.textContent = member.name;
    const amount = document.createElement('small'); amount.textContent = `${state.group.amountSats} sats · round ${viewRound.number}`;
    info.append(name, amount);
    const chip = document.createElement('span'); chip.className = `status ${status}`; chip.textContent = status === 'paid' ? 'PAID' : status === 'pending' ? 'PENDING' : status === 'expired' ? 'CHECKING' : 'DUE';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = status === 'paid' ? 'Receipt' : status === 'expired' ? 'Check' : status === 'pending' ? 'View' : me?.memberId === member.id ? 'Pay' : 'View'; button.setAttribute('aria-label', `${status === 'paid' ? 'View receipt for' : status === 'expired' ? 'Check payment status for' : status === 'pending' ? 'View invoice for' : me?.memberId === member.id ? 'Contribute for' : 'View contribution for'} ${member.name}`);
    button.addEventListener('click', () => selectMember(member.id));
    row.append(avatar, info, chip, button); list.append(row);
  }
  renderWallet();
  renderCycle();
  if (selected) renderPayment();
}

function selectMember(memberId) {
  selected = memberId;
  render();
  scrollToSection(!me?.memberId && statusOf(memberId) !== 'paid' ? 'wallet-section' : 'payment-section');
}

function renderPayment() {
  const panel = $('payment-panel');
  panel.replaceChildren(); panel.classList.add('active');
  const member = state.group.members.find(item => item.id === selected);
  if (!member) { selected = null; return; }
  const record = latest(selected);
  const title = document.createElement('h4'); title.textContent = `${member.name}'s contribution`;
  const summary = document.createElement('p'); summary.textContent = `${state.group.amountSats} sats · round ${state.round?.number || state.cycle.rounds.length}`;
  panel.append(title, summary);
  if (record?.status === 'paid') {
    const receipt = document.createElement('div'); receipt.className = 'receipt';
    if (['mainnet', 'mutinynet', 'alby-sandbox'].includes(record.provider)) {
      const proof = `${record.paymentHash ? ` · Payment hash: ${record.paymentHash}` : ''}${record.preimage ? ` · Preimage: ${record.preimage}` : ''}`;
      receipt.textContent = record.provider === 'mainnet'
        ? `Round ${state.round?.number || state.cycle.rounds.length} · ${record.amountSats} sats · Bitcoin Lightning (mainnet) · real sats · Confirmed ${new Date(record.paidAt).toLocaleString()} · Paid from the visitor’s own Lightning wallet; the treasurer wallet confirmed settlement${record.preimage ? ' and the preimage was verified' : '; the wallet did not provide a preimage'}; payer identity not verified${proof}`
        : record.provider === 'mutinynet'
        ? `Round ${state.round?.number || state.cycle.rounds.length} · ${record.amountSats} sats · Mutinynet Lightning · test coins · Confirmed ${new Date(record.paidAt).toLocaleString()} · Paid by the Mutinynet faucet node over Lightning; the treasurer node confirmed settlement and the preimage was verified; payer identity not verified${proof}`
        : `Round ${state.round?.number || state.cycle.rounds.length} · ${record.amountSats} sats · Alby sandbox Lightning · test sats · Confirmed ${new Date(record.paidAt).toLocaleString()} · Paid from your sandbox wallet over NWC; receiving wallet confirmed and preimage verified; identity not verified${proof}`;
      panel.append(receipt); return;
    }
    const attribution = record.attribution === 'member-proof' ? 'Payment proof linked to the signed-in member account' : record.attribution === 'demo-wallet' ? me?.kind === 'guest-demo' ? 'Simulated guest payment; identity not verified' : 'Paid from this member’s simulated wallet' : record.attribution === 'demo-facilitator' ? 'Recorded by the demo facilitator; no wallet payment or identity check' : 'Payment received; payer identity unverified';
    receipt.textContent = `Round ${state.round?.number || state.cycle.rounds.length} · ${record.amountSats} sats · ${record.provider === 'demo' ? 'Simulated' : `${record.provider?.toUpperCase()} · ${paymentLabel()}`} · Confirmed ${new Date(record.paidAt).toLocaleString()} · ${attribution}${record.paymentHash ? ` · ${state.mode === 'demo' ? 'Demo reference' : 'Payment hash'}: ${record.paymentHash}` : ' · Sign in to view the payment reference'}`;
    panel.append(receipt); return;
  }
  if (record?.status === 'expired' && state.mode === 'lightning') {
    panel.append(element('p', '', 'This invoice has expired. CircleSats is still checking the receiving wallet for a final status before another invoice can be issued.'));
    panel.append(action('Check payment status', () => refresh(true), true));
    return;
  }
  if (!state.round) { const note = document.createElement('p'); note.textContent = 'This cycle is complete. Start a new cycle to contribute again.'; panel.append(note); return; }
  if (me?.memberId !== selected) {
    const note = document.createElement('p'); note.textContent = me?.kind === 'guest-demo' ? 'This guest tour covers Awa’s contribution. Leave the demo and sign in with a member code to use another account.' : 'Only this member can create or pay their contribution. Sign in with their private access code.'; panel.append(note); return;
  }
  if (record?.status === 'pending') {
    if (state.mode === 'demo' && record.provider === 'mainnet') {
      // Pay from your own wallet: reuses the Lightning-mode invoice elements.
      const label = document.createElement('div'); label.className = 'invoice-label'; label.textContent = 'LIGHTNING INVOICE · REAL SATS';
      const qr = document.createElement('img'); qr.className = 'invoice-qr'; qr.src = `/api/practice/qr?invoice=${encodeURIComponent(record.paymentRequest)}`;
      qr.alt = `Scan to pay ${record.amountSats} sats for ${member.name}'s round ${state.round.number} contribution`;
      qr.width = 256; qr.height = 256; qr.loading = 'lazy';
      const invoice = document.createElement('div'); invoice.className = 'invoice'; invoice.textContent = record.paymentRequest;
      const actions = document.createElement('div'); actions.className = 'actions';
      const copy = document.createElement('button'); copy.className = 'action'; copy.textContent = 'Copy invoice';
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(record.paymentRequest); toast('Invoice copied.'); } catch { toast('Copy unavailable. Select the invoice text instead.'); } });
      const open = document.createElement('a'); open.className = 'action secondary'; open.textContent = 'Open external wallet'; open.href = `lightning:${record.paymentRequest}`;
      actions.append(copy, open, action('Check payment', async () => { await mutate('/api/wallet/pay-demo'); await refresh(true); toast('Lightning payment received by the treasurer wallet.'); }, true, 'Checking…'));
      actions.append(action('No Lightning wallet? Use free test coins', async () => {
        const result = await mutate('/api/demo/use-test-coins'); await refresh(true);
        toast(result.switched ? 'Switched to free test coins. Pay with your demo wallet.' : 'Your real payment had already arrived.');
      }, true, 'Switching…'));
      panel.append(label, qr, invoice, actions);
      const hint = document.createElement('p'); hint.textContent = `Pay ${record.amountSats} sats from any Lightning wallet. This is a real Bitcoin payment to the circle’s demo treasurer wallet and is not refunded. CircleSats checks for it automatically. Invoice expires ${new Date(record.expiresAt).toLocaleTimeString()}.`;
      panel.append(hint);
      panel.append(connectedWalletPay(record));
      watchMainnet(record.id);
      return;
    }
    if (state.mode === 'demo') {
      const lightningPractice = record.provider === 'alby-sandbox' || record.provider === 'mutinynet';
      const note = document.createElement('p'); note.textContent = record.provider === 'mutinynet'
        ? `Pay this ${state.group.amountSats}-sat Lightning invoice. The Mutinynet faucet’s node pays it over the Mutinynet Lightning network to the circle treasurer’s node. This can take up to a minute. Test coins only.`
        : lightningPractice
        ? `Pay this ${state.group.amountSats}-sat Lightning invoice from your sandbox wallet. Test sats only; no real Bitcoin moves.`
        : `Pay ${state.group.amountSats} simulated sats from your built-in wallet. This is a local demonstration, not a Lightning transaction.`; panel.append(note);
      const controls = document.createElement('div'); controls.className = 'actions';
      controls.append(action('Pay with demo wallet', async () => { await mutate('/api/wallet/pay-demo'); await refresh(true);
        toast(lightningPractice ? 'Lightning payment confirmed by the receiving wallet.' : 'Demo contribution recorded.'); }, false, lightningPractice ? 'Paying over Lightning…' : 'Recording payment…'));
      panel.append(controls); return;
    }
    if (Date.now() >= Date.parse(record.expiresAt)) {
      panel.append(element('p', '', 'The invoice time has passed. Check the receiving wallet status before trying to pay or requesting another invoice.'));
      panel.append(action('Check payment status', () => refresh(true), true));
      return;
    }
    const label = document.createElement('div'); label.className = 'invoice-label'; label.textContent = 'LIGHTNING INVOICE';
    const qr = document.createElement('img'); qr.className = 'invoice-qr'; qr.src = `/api/invoice-qr?id=${encodeURIComponent(record.id)}`;
    qr.alt = `Scan to pay ${record.amountSats} sats for ${member.name}'s round ${state.round.number} contribution`;
    qr.width = 256; qr.height = 256; qr.loading = 'lazy';
    const invoice = document.createElement('div'); invoice.className = 'invoice'; invoice.textContent = record.paymentRequest;
    const actions = document.createElement('div'); actions.className = 'actions';
    const copy = document.createElement('button'); copy.className = 'action'; copy.textContent = 'Copy invoice';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(record.paymentRequest); toast('Invoice copied.'); } catch { toast('Copy unavailable. Select the invoice text instead.'); } });
    const open = document.createElement('a'); open.className = 'action secondary'; open.textContent = 'Open external wallet'; open.href = `lightning:${record.paymentRequest}`;
    const check = document.createElement('button'); check.className = 'action secondary'; check.textContent = 'Check payment'; check.addEventListener('click', refresh);
    actions.append(copy, open, check); panel.append(label, qr, invoice, actions);
    if (nwc) actions.append(action('Pay with connected wallet', async () => {
      const payment = await nwc.payInvoice({ invoice: record.paymentRequest });
      if (!payment.preimage) throw new Error('Wallet paid but did not return proof. Check the receipt after confirmation.');
      await mutate('/api/proofs', { preimage: payment.preimage });
      await refresh(true); toast('Payment and member proof confirmed.');
    }));
    const hint = document.createElement('p'); hint.textContent = `Invoice expires ${new Date(record.expiresAt).toLocaleTimeString()}. A manual wallet payment confirms receipt but does not prove who paid. Connected wallet payment can provide a preimage as member-account proof.`; panel.append(hint);
    return;
  }
  const explanation = document.createElement('p'); explanation.textContent = state.walletConnected ? 'Create a unique Lightning invoice for your member account.'
    : mainnetPractice() ? 'Create a real Bitcoin Lightning invoice from the circle’s demo treasurer wallet, then pay it from your own wallet.'
    : realPractice() ? 'Create a Mutinynet Lightning invoice from the circle treasurer’s node for your contribution.'
    : sandboxWallet() ? 'Create a Lightning invoice for your contribution, to pay from your sandbox wallet.' : 'Create a simulated contribution for your demo wallet.';
  const actions = document.createElement('div'); actions.className = 'actions';
  const create = document.createElement('button'); create.className = 'action'; create.textContent = state.mode === 'demo' ? 'Create demo contribution' : `Create ${state.group.amountSats} sat invoice`;
  create.addEventListener('click', () => createInvoice(member.id, create)); actions.append(create); panel.append(explanation, actions);
}

// Pay a real-sats invoice from the visitor's own wallet over Nostr Wallet
// Connect (NIP-47), inside this tab. The connection string stays in this tab's
// memory; CircleSats never sends it anywhere. The treasurer wallet still has to
// confirm the payment before the contribution counts.
function connectedWalletPay(record) {
  const box = element('div', 'nwc-pay');
  box.append(element('p', 'wallet-hint', nwc
    ? `Wallet connected over Nostr Wallet Connect${nwcNetwork ? ` (${nwcNetwork})` : ''}. Payment permission and budget are controlled in your wallet.`
    : 'Or connect your wallet with Nostr Wallet Connect and pay here. Your connection string stays in this browser tab.'));
  const payConnected = async () => {
    const payment = await nwc.payInvoice({ invoice: record.paymentRequest });
    for (let attempt = 0; attempt < 6; attempt++) {
      try { await mutate('/api/wallet/pay-demo'); await refresh(true); toast('Paid from your connected wallet and confirmed by the treasurer wallet.'); return; }
      catch { await new Promise(resolve => setTimeout(resolve, 1500)); }
    }
    await refresh(true);
    toast(payment?.preimage ? 'Payment sent. Waiting for the treasurer wallet to confirm it.' : 'Payment submitted. Waiting for the treasurer wallet to confirm it.');
  };
  if (nwc) {
    const controls = element('div', 'actions');
    controls.append(action('Pay with connected wallet', payConnected, false, 'Paying…'),
      action('Disconnect wallet', () => { nwc.close(); nwc = null; nwcNetwork = null; renderPayment(); toast('Wallet disconnected from this tab.'); }, true));
    box.append(controls);
    return box;
  }
  const form = element('form', 'login-form');
  const uri = element('input'); uri.type = 'password'; uri.placeholder = 'nostr+walletconnect://…'; uri.setAttribute('aria-label', 'Nostr Wallet Connect connection string');
  uri.autocomplete = 'off'; uri.autocapitalize = 'off'; uri.spellcheck = false; uri.required = true;
  const submit = element('button', 'action secondary', 'Connect wallet & pay'); submit.type = 'submit';
  form.append(uri, submit);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; submit.setAttribute('aria-busy', 'true'); submit.textContent = 'Connecting…';
    try {
      const { connectNwc } = await import('/nwc.bundle.js');
      const result = await connectNwc(uri.value.trim());
      if (result.network && result.network !== 'mainnet') { result.client.close(); throw new Error(`This wallet is on ${result.network}. Real-sat invoices need a mainnet Lightning wallet.`); }
      nwc?.close(); nwc = result.client; nwcNetwork = result.network || 'mainnet'; uri.value = '';
      toast(`${result.alias} connected. Paying…`); submit.textContent = 'Paying…';
      await payConnected();
    } catch (error) { toast(error.message || 'The wallet could not pay this invoice.'); renderPayment(); }
  });
  box.append(form);
  return box;
}

// While a real-sats invoice is on screen, ask every 5 seconds whether the
// visitor's wallet has paid it (read-only check), for up to 30 minutes.
function watchMainnet(recordId) {
  if (mainnetWatch?.id === recordId) return;
  clearInterval(mainnetWatch?.timer);
  const started = Date.now();
  const stop = () => { clearInterval(mainnetWatch?.timer); mainnetWatch = null; };
  mainnetWatch = { id: recordId, timer: setInterval(async () => {
    const current = state && selected ? latest(selected) : null;
    if (!current || current.id !== recordId || current.status !== 'pending' || Date.now() - started > 30 * 60_000) { stop(); return; }
    if (mainnetWatch?.busy) return;
    mainnetWatch.busy = true;
    try { await mutate('/api/wallet/pay-demo'); stop(); await refresh(true); toast('Lightning payment received by the treasurer wallet.'); }
    catch { /* not paid yet */ }
    finally { if (mainnetWatch) mainnetWatch.busy = false; }
  }, 5000) };
}

async function createInvoice(memberId, button) {
  const original = button.textContent;
  button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Creating…';
  try {
    await mutate('/api/invoices');
    await refresh(); toast('Invoice ready.');
  } catch (error) { toast(error.message); button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = original; }
}

async function refresh(force = false) {
  try {
    const [next, account] = await Promise.all([request('/api/group'), request('/api/me')]);
    me = account;
    const snapshot = JSON.stringify({ walletConnected: next.walletConnected, network: next.network, environment: next.environment, records: next.records, cycle: next.cycle, group: next.group, account });
    state = next;
    if (selected && !state.group.members.some(member => member.id === selected)) selected = null;
    if (!selected && me.memberId) selected = me.memberId;
    if (force || snapshot !== lastSnapshot) render();
    lastSnapshot = snapshot;
    reportInitialReadiness(true);
  }
  catch { reportInitialReadiness(false); toast('Could not load the circle. Check your connection.'); }
}

await refresh();
setInterval(refresh, 12000);

const navTargets = ['overview', 'wallet-section', 'members-section', 'cycle-section', 'how-it-works'];
function setActiveNavigation(id) {
  for (const link of document.querySelectorAll('[data-nav]')) {
    const active = link.dataset.nav === id;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
for (const link of document.querySelectorAll('[data-nav]')) {
  link.addEventListener('click', () => setActiveNavigation(link.dataset.nav));
}
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (navTargets.includes(id)) setActiveNavigation(id);
});
if (navTargets.includes(location.hash.slice(1))) setActiveNavigation(location.hash.slice(1));
