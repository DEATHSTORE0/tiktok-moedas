const state = { user: null, packages: [], pendingPackageId: null, referrals: null };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const money = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Ocorreu um erro. Tente novamente.');
    error.status = response.status; error.code = data.code; throw error;
  }
  return data;
}
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}
function message(id, text, good = false) {
  const el = $(id); if (!el) return;
  el.textContent = text; el.style.color = good ? '#11865b' : '#e51d46';
}
function route(page, replace = false) {
  const known = ['recarga','login','cadastro','forgot','perfil','historico','indicacoes'];
  if (!known.includes(page)) page = 'recarga';
  $$('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
  $$('[data-page]').forEach(el => {
    if (el.classList.contains('mobile-nav') || el.closest('.mobile-nav')) el.classList.toggle('active', el.dataset.page === page);
  });
  if (replace) history.replaceState({ page }, '', `#${page}`);
  else if (location.hash !== `#${page}`) history.pushState({ page }, '', `#${page}`);
  if (page === 'perfil') renderProfile();
  if (page === 'historico') loadOrders();
  if (page === 'indicacoes') loadReferrals();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function requireLogin(page, packageId = null) {
  if (!state.user) {
    state.pendingPackageId = packageId;
    sessionStorage.setItem('pendingPackageId', packageId || '');
    sessionStorage.setItem('pendingPage', page || '');
    route('login');
    toast('Entre ou crie uma conta para continuar.');
    return false;
  }
  return true;
}
function renderHeader() {
  $('#header-balance').textContent = state.user ? Number(state.user.balance).toLocaleString('pt-BR') : '—';
  $('#avatar').textContent = state.user ? state.user.name.trim().charAt(0).toUpperCase() : '?';
}
function renderPackages() {
  $('#packages').innerHTML = state.packages.map(p => `
    <article class="package-card ${p.free ? 'free' : ''}">
      <div class="package-coin" aria-hidden="true">¢</div>
      <div class="package-main"><h3>${escapeHtml(p.label)}</h3><p>${p.free ? 'Resgate sujeito à análise' : 'Pagamento pelo checkout Cakto'}</p><div class="package-price">${escapeHtml(p.displayPrice)}</div></div>
      <button class="pink-button buy-button" data-buy="${escapeHtml(p.id)}">${p.free ? 'Resgatar 700 moedas grátis' : 'Comprar'}</button>
    </article>`).join('');
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function buyPackage(packageId) {
  const product = state.packages.find(p => p.id === packageId);
  if (!product) return toast('Pacote inválido.');
  if (product.free) {
    if (!requireLogin('indicacoes')) return;
    route('indicacoes');
    return;
  }
  if (!requireLogin('recarga', packageId)) return;
  try {
    const result = await api('/api/orders', { method: 'POST', body: JSON.stringify({ packageId }) });
    // Record is stored as pending before checkout opens. Do not trust return URLs for payment confirmation.
    window.open(result.checkoutUrl, '_blank', 'noopener,noreferrer');
    toast('Pedido registrado como pendente. O pagamento ainda precisa ser confirmado.');
    state.pendingPackageId = null;
    sessionStorage.removeItem('pendingPackageId');
  } catch (error) {
    if (error.status === 401) return requireLogin('recarga', packageId);
    toast(error.message);
  }
}
async function loadMe() {
  try { const result = await api('/api/me'); state.user = result.user; }
  catch { state.user = null; }
  renderHeader();
}
async function renderProfile() {
  if (!requireLogin('perfil')) return;
  try {
    const { user } = await api('/api/profile');
    $('#profile-avatar').textContent = user.name.trim().charAt(0).toUpperCase();
    $('#profile-name').textContent = user.name;
    $('#profile-email').textContent = user.email;
    $('#profile-balance').textContent = Number(user.balance).toLocaleString('pt-BR');
  } catch (error) { if (error.status === 401) route('login'); }
}
async function loadOrders() {
  if (!requireLogin('historico')) { $('#orders-list').innerHTML = '<div class="empty">Entre para consultar seus pedidos.</div>'; return; }
  $('#orders-list').innerHTML = '<div class="loading">Carregando pedidos…</div>';
  try {
    const { orders } = await api('/api/orders');
    if (!orders.length) { $('#orders-list').innerHTML = '<div class="empty">Você ainda não tem pedidos.</div>'; return; }
    $('#orders-list').innerHTML = `<div class="order-row order-head"><div>Pacote</div><div>Data</div><div>Valor</div><div>Status</div></div>` + orders.map(o => `
      <div class="order-row"><div><strong>${escapeHtml(o.packageLabel)}</strong><br><small>${o.coins.toLocaleString('pt-BR')} moedas</small></div>
      <div>${new Date(o.createdAt).toLocaleString('pt-BR')}</div><div>${escapeHtml(o.amount)}</div>
      <div><span class="status ${o.status}">${({pending:'Pendente',paid:'Pago',cancelled:'Cancelado',refunded:'Reembolsado'})[o.status] || o.status}</span></div></div>`).join('');
    const status = await api('/api/integrations/payment-status');
    $('#payment-status').textContent = status.message;
  } catch (error) { $('#orders-list').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
async function loadReferrals() {
  if (!requireLogin('indicacoes')) return;
  try {
    const data = await api('/api/referrals'); state.referrals = data;
    $('#ref-link').value = data.link;
    $('#ref-signups').textContent = data.signups;
    $('#ref-buyers').textContent = data.qualifiedBuyers;
    $('#ref-pending').textContent = data.pendingBuyers;
    $('#ref-progress').textContent = `${data.nextRewardProgress}/3`;
  } catch (error) { toast(error.message); }
}
async function handleForm(form, endpoint, messageId, successMessage, onSuccess) {
  const submit = form.querySelector('button[type="submit"]');
  const payload = Object.fromEntries(new FormData(form).entries());
  submit.disabled = true;
  try {
    const result = await api(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    if (result.user) { state.user = result.user; renderHeader(); }
    message(messageId, successMessage || result.message || 'Concluído.', true);
    form.reset();
    if (onSuccess) await onSuccess(result);
  } catch (error) { message(messageId, error.message); }
  finally { submit.disabled = false; }
}

document.addEventListener('click', event => {
  const pageLink = event.target.closest('[data-page]');
  if (pageLink) { event.preventDefault(); route(pageLink.dataset.page); return; }
  const buy = event.target.closest('[data-buy]');
  if (buy) { buyPackage(buy.dataset.buy); return; }
});
$('#profile-button').addEventListener('click', () => route(state.user ? 'perfil' : 'login'));
$('#login-form').addEventListener('submit', event => {
  event.preventDefault();
  handleForm(event.currentTarget, '/api/auth/login', '#login-message', 'Login realizado.', async () => {
    const pending = sessionStorage.getItem('pendingPackageId');
    const page = sessionStorage.getItem('pendingPage');
    sessionStorage.removeItem('pendingPackageId'); sessionStorage.removeItem('pendingPage');
    if (pending) { route('recarga'); await buyPackage(pending); }
    else route(page && ['perfil','historico','indicacoes'].includes(page) ? page : 'recarga');
  });
});
$('#register-form').addEventListener('submit', event => {
  event.preventDefault();
  const referralCode = new URLSearchParams(location.search).get('ref');
  if (referralCode) new FormData(event.currentTarget).append('referralCode', referralCode);
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  if (referralCode) payload.referralCode = referralCode;
  const form = event.currentTarget, submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  api('/api/auth/register', { method:'POST', body: JSON.stringify(payload) })
    .then(async result => {
      state.user = result.user; renderHeader(); message('#register-message','Conta criada.',true); form.reset();
      const pending = sessionStorage.getItem('pendingPackageId');
      sessionStorage.removeItem('pendingPackageId'); sessionStorage.removeItem('pendingPage');
      if (pending) { route('recarga'); await buyPackage(pending); } else route('recarga');
    }).catch(error => message('#register-message',error.message)).finally(() => submit.disabled = false);
});
$('#forgot-form').addEventListener('submit', event => { event.preventDefault(); handleForm(event.currentTarget,'/api/auth/forgot-password','#forgot-message','Se o e-mail estiver cadastrado, enviaremos instruções de recuperação.'); });
$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout',{method:'POST',body:'{}'}); state.user = null; renderHeader(); route('recarga'); toast('Você saiu da conta.'); }
  catch (error) { toast(error.message); }
});
$('#copy-ref').addEventListener('click', async () => {
  const input = $('#ref-link');
  try { await navigator.clipboard.writeText(input.value); message('#ref-message','Link copiado!',true); }
  catch { input.select(); document.execCommand('copy'); message('#ref-message','Link copiado!',true); }
});
$('#claim-free').addEventListener('click', async () => {
  if (!requireLogin('indicacoes')) return;
  const button = $('#claim-free'); button.disabled = true;
  try { const result = await api('/api/free-claim',{method:'POST',body:'{}'}); message('#claim-message',result.message,true); }
  catch (error) { message('#claim-message',error.message); }
  finally { button.disabled = false; }
});
window.addEventListener('popstate', () => route(location.hash.slice(1) || 'recarga', true));

async function init() {
  const params = new URLSearchParams(location.search);
  const ref = params.get('ref');
  if (ref) sessionStorage.setItem('signupReferralCode', ref);
  const resetToken = params.get('reset');
  if (resetToken) {
    // Token reset is accepted only by server API; show reset UI by reusing form area.
    route('forgot', true);
    const card = document.querySelector('#page-forgot .auth-card');
    card.querySelector('h1').textContent = 'Escolher nova senha';
    card.querySelector('.muted').textContent = 'O link é válido por 30 minutos e pode ser usado uma vez.';
    card.querySelector('form').innerHTML = `<label>Nova senha (mínimo 10 caracteres)<input id="new-password" type="password" minlength="10" maxlength="128" required autocomplete="new-password"></label><button class="pink-button full" id="reset-password-button" type="button">Salvar nova senha</button><p class="form-message" id="reset-message"></p>`;
    $('#reset-password-button').addEventListener('click', async () => {
      try { const result = await api('/api/auth/reset-password',{method:'POST',body:JSON.stringify({token:resetToken,password:$('#new-password').value})}); message('#reset-message',result.message,true); }
      catch (error) { message('#reset-message',error.message); }
    });
    history.replaceState({},'',location.pathname+'#forgot');
  }
  try {
    const config = await api('/api/config'); state.packages = config.packages; renderPackages();
  } catch { $('#packages').innerHTML = '<div class="empty">Não foi possível carregar os pacotes.</div>'; }
  await loadMe();
  const page = location.hash.slice(1);
  if (['recarga','login','cadastro','forgot','perfil','historico','indicacoes'].includes(page)) route(page,true);
  if (state.user && sessionStorage.getItem('pendingPackageId')) {
    const pending = sessionStorage.getItem('pendingPackageId');
    sessionStorage.removeItem('pendingPackageId'); sessionStorage.removeItem('pendingPage');
    route('recarga',true); await buyPackage(pending);
  }
}
init();
