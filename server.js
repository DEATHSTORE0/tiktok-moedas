import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import SQLiteStoreFactory from 'connect-sqlite3';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import nodemailer from 'nodemailer';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || '';
if (isProduction && sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be a random string of at least 32 characters in production.');
}
if (!isProduction && sessionSecret.length < 32) {
  console.warn('WARNING: Set SESSION_SECRET in .env before deployment.');
}

const dataDir = path.resolve(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.resolve(process.env.DATABASE_FILE || path.join(dataDir, 'store.sqlite'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by TEXT REFERENCES users(id),
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  free_claimed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expired INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expired_idx ON sessions(expired);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  package_id TEXT NOT NULL,
  coins INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','paid','cancelled','refunded')),
  checkout_url TEXT,
  provider_reference TEXT,
  callback_token TEXT UNIQUE,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT REFERENCES orders(id),
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_key TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  provider_order_id TEXT,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL REFERENCES users(id),
  referred_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  qualifying_order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  reward_group INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referral_payouts (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL REFERENCES users(id),
  trigger_order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  reward_group INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','reversed')),
  created_at TEXT NOT NULL,
  reversed_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  event TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);
// Backward-compatible migration for databases created by an earlier version.
const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map(column => column.name);
if (!orderColumns.includes('callback_token')) {
  db.exec('ALTER TABLE orders ADD COLUMN callback_token TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_callback_token_idx ON orders(callback_token)');
}

const packages = [
  { id: 'free700', coins: 700, amountCents: 0, label: '700 moedas grátis', displayPrice: 'R$ 0,00', checkoutUrl: null, free: true },
  { id: 'coins350', coins: 350, amountCents: 749, label: '350 moedas', displayPrice: 'R$ 7,49', checkoutUrl: 'https://pay.cakto.com.br/3fzmsu2_1254497' },
  { id: 'coins820', coins: 820, amountCents: 1550, label: '820 moedas', displayPrice: 'R$ 15,50', checkoutUrl: 'https://pay.cakto.com.br/egpnptr_1254529' },
  { id: 'coins1359', coins: 1359, amountCents: 3201, label: '1.359 moedas', displayPrice: 'R$ 32,01', checkoutUrl: 'https://pay.cakto.com.br/dujmnbh_1254544' },
  { id: 'coins2707', coins: 2707, amountCents: 7500, label: '2.707 moedas', displayPrice: 'R$ 75,00', checkoutUrl: 'https://pay.cakto.com.br/846tcw8_1254552' }
];
const packageById = new Map(packages.map(p => [p.id, p]));

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hashToken = value => crypto.createHash('sha256').update(value).digest('hex');
function audit(event, actorUserId = null, details = {}) {
  db.prepare('INSERT INTO audit_log (id, actor_user_id, event, details_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id(), actorUserId, event, JSON.stringify(details), now());
}
function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, referralCode: user.referral_code, balance: user.balance, createdAt: user.created_at };
}
function getUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || null;
}
function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Faça login para continuar.', code: 'AUTH_REQUIRED' });
  req.user = user;
  next();
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Muitas tentativas. Aguarde e tente novamente.' } });
const generalLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'", 'https://pay.cakto.com.br'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  }
}));
app.use(generalLimiter);
if (isProduction) app.set('trust proxy', 1);

// Cakto webhook: verify the official HMAC signature against the untouched raw body.
// Configure CAKTO_WEBHOOK_SECRET from the secret generated in the Cakto webhook panel.
app.post('/webhooks/cakto', express.raw({ type: 'application/json', limit: '256kb' }), (req, res) => {
  const secret = process.env.CAKTO_WEBHOOK_SECRET || '';
  if (!secret || !Buffer.isBuffer(req.body)) {
    return res.status(503).json({ error: 'Webhook Cakto não configurado.' });
  }
  const timestamp = String(req.get('X-Cakto-Timestamp') || '');
  const signature = String(req.get('X-Cakto-Signature') || '');
  if (!/^\d{10,13}$/.test(timestamp) || !signature.startsWith('v1=')) {
    return res.status(401).json({ error: 'Assinatura ausente ou inválida.' });
  }
  const timestampSeconds = Number(timestamp);
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
    return res.status(401).json({ error: 'Webhook expirado.' });
  }
  const expected = 'v1=' + crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`).update(req.body).digest('hex');
  if (!safeEqual(signature, expected)) {
    return res.status(401).json({ error: 'Assinatura inválida.' });
  }

  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); }
  catch { return res.status(400).json({ error: 'JSON inválido.' }); }
  if (!safeEqual(payload?.secret || '', secret)) {
    return res.status(401).json({ error: 'Segredo do webhook inválido.' });
  }
  if (typeof payload.event !== 'string') return res.status(400).json({ error: 'Evento ausente.' });
  const items = Array.isArray(payload.data) ? payload.data : [payload.data];
  if (!items.length || items.some(item => !item || typeof item !== 'object')) {
    return res.status(400).json({ error: 'Dados do evento inválidos.' });
  }

  try {
    const processEvent = db.transaction(() => {
      for (const item of items) {
        // Checkout callback is the opaque internal order ID appended by this server.
        // A redirect alone never changes the order status.
        const callback = typeof item.callback === 'string' ? item.callback : '';
        const order = callback ? db.prepare('SELECT * FROM orders WHERE callback_token=?').get(callback) : null;
        const providerOrderId = typeof item.id === 'string' ? item.id : '';
        const eventKey = `${payload.event}:${providerOrderId || callback}:${item.status || ''}`;
        const seen = db.prepare('SELECT event_key FROM webhook_events WHERE event_key=?').get(eventKey);
        if (seen) continue;

        db.prepare('INSERT INTO webhook_events (event_key,event_name,provider_order_id,received_at) VALUES (?,?,?,?)')
          .run(eventKey, payload.event, providerOrderId || null, now());

        if (!order) {
          audit('cakto_webhook_unmatched', null, { event: payload.event, providerOrderId, hasCallback: !!callback });
          continue;
        }

        if (payload.event === 'purchase_approved' && item.status === 'paid') {
          const paidAmountCents = Math.round(Number(item.amount) * 100);
          if (item.currency !== 'BRL' || !Number.isFinite(paidAmountCents) ||
              paidAmountCents !== order.amount_cents) {
            audit('cakto_webhook_amount_mismatch', order.user_id, {
              orderId: order.id, providerOrderId, currency: item.currency || null, paidAmountCents
            });
            continue;
          }
          if (order.status !== 'paid') {
            const timestampNow = now();
            db.prepare("UPDATE orders SET status='paid', provider_reference=?, paid_at=?, updated_at=? WHERE id=?")
              .run(providerOrderId || null, timestampNow, timestampNow, order.id);
            db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(order.coins, order.user_id);
            db.prepare(`INSERT INTO ledger (id,user_id,order_id,kind,amount,idempotency_key,note,created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
              .run(id(), order.user_id, order.id, 'purchase_credit', order.coins, `purchase:${order.id}`, 'Crédito após webhook Cakto autenticado', timestampNow);
            audit('purchase_credited', order.user_id, { orderId: order.id, providerOrderId, coins: order.coins });

            // A referred user can qualify once only, after a confirmed purchase.
            const buyer = db.prepare('SELECT referred_by FROM users WHERE id=?').get(order.user_id);
            if (buyer?.referred_by) {
              const alreadyQualified = db.prepare('SELECT id FROM referral_rewards WHERE referred_user_id=?').get(order.user_id);
              if (!alreadyQualified) {
                const qualifyingCount = db.prepare('SELECT COUNT(*) AS count FROM referral_rewards WHERE referrer_id=?').get(buyer.referred_by).count;
                const groupNumber = Math.floor(qualifyingCount / 3) + 1;
                db.prepare(`INSERT INTO referral_rewards (id,referrer_id,referred_user_id,qualifying_order_id,reward_group,created_at)
                  VALUES (?,?,?,?,?,?)`).run(id(), buyer.referred_by, order.user_id, order.id, groupNumber, timestampNow);
                const newCount = qualifyingCount + 1;
                if (newCount % 3 === 0) {
                  const payoutId = id();
                  db.prepare('UPDATE users SET balance=balance+700 WHERE id=?').run(buyer.referred_by);
                  db.prepare(`INSERT INTO referral_payouts (id,referrer_id,trigger_order_id,reward_group,status,created_at)
                    VALUES (?,?,?,?, 'active', ?)`).run(payoutId, buyer.referred_by, order.id, groupNumber, timestampNow);
                  db.prepare(`INSERT INTO ledger (id,user_id,order_id,kind,amount,idempotency_key,note,created_at)
                    VALUES (?,?,?,?,?,?,?,?)`)
                    .run(id(), buyer.referred_by, null, 'referral_reward', 700, `referral:${payoutId}`, 'Recompensa por 3 compradores indicados com pagamento confirmado', timestampNow);
                  audit('referral_reward_credited', buyer.referred_by, { groupNumber, qualifyingBuyers: newCount, coins: 700 });
                }
              }
            }
          }
        } else if (['refund', 'chargeback'].includes(payload.event) || ['refunded', 'chargedback', 'canceled'].includes(item.status)) {
          if (order.status === 'paid') {
            const timestampNow = now();
            db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?')
              .run(payload.event === 'refund' || item.status === 'refunded' ? 'refunded' : 'cancelled', timestampNow, order.id);
            // Revoke the available portion without allowing a negative balance; preserve audit trail.
            const user = db.prepare('SELECT balance FROM users WHERE id=?').get(order.user_id);
            const debit = Math.min(user.balance, order.coins);
            if (debit > 0) {
              db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(debit, order.user_id);
              db.prepare(`INSERT INTO ledger (id,user_id,order_id,kind,amount,idempotency_key,note,created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
                .run(id(), order.user_id, order.id, 'purchase_reversal', -debit, `reversal:${order.id}`, 'Estorno após evento Cakto autenticado', timestampNow);
            }
            // A referred buyer only qualifies while they have at least one paid order.
            const buyer = db.prepare('SELECT referred_by FROM users WHERE id=?').get(order.user_id);
            if (buyer?.referred_by) {
              const otherPaid = db.prepare("SELECT id FROM orders WHERE user_id=? AND status='paid' ORDER BY paid_at ASC LIMIT 1").get(order.user_id);
              const rewardRow = db.prepare('SELECT * FROM referral_rewards WHERE referred_user_id=?').get(order.user_id);
              if (!otherPaid && rewardRow) {
                db.prepare('DELETE FROM referral_rewards WHERE referred_user_id=?').run(order.user_id);
                const qualifyingCount = db.prepare('SELECT COUNT(*) AS count FROM referral_rewards WHERE referrer_id=?').get(buyer.referred_by).count;
                const activePayouts = db.prepare("SELECT * FROM referral_payouts WHERE referrer_id=? AND status='active' ORDER BY reward_group DESC").all(buyer.referred_by);
                const allowedPayouts = Math.floor(qualifyingCount / 3);
                for (const payout of activePayouts.slice(allowedPayouts)) {
                  const referrer = db.prepare('SELECT balance FROM users WHERE id=?').get(buyer.referred_by);
                  const rewardDebit = Math.min(referrer.balance, 700);
                  if (rewardDebit > 0) {
                    db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(rewardDebit, buyer.referred_by);
                    db.prepare(`INSERT INTO ledger (id,user_id,order_id,kind,amount,idempotency_key,note,created_at)
                      VALUES (?,?,?,?,?,?,?,?)`)
                      .run(id(), buyer.referred_by, null, 'referral_reversal', -rewardDebit, `referral-reversal:${payout.id}`, 'Reversão de recompensa após reembolso/chargeback de compra indicada', timestampNow);
                  }
                  db.prepare("UPDATE referral_payouts SET status='reversed', reversed_at=? WHERE id=?").run(timestampNow, payout.id);
                  audit('referral_reward_reversed', buyer.referred_by, { payoutId: payout.id, rewardDebit, reason: payload.event });
                }
              } else if (otherPaid && rewardRow && rewardRow.qualifying_order_id === order.id) {
                db.prepare('UPDATE referral_rewards SET qualifying_order_id=? WHERE referred_user_id=?').run(otherPaid.id, order.user_id);
              }
            }
            audit('purchase_reversed', order.user_id, { orderId: order.id, providerOrderId, coinsDebited: debit, originalCoins: order.coins });
          }
        }
      }
    });
    processEvent();
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Cakto webhook processing error:', error);
    return res.status(500).json({ error: 'Erro ao processar webhook.' });
  }
});

app.use(express.json({ limit: '20kb' }));
const SQLiteStore = SQLiteStoreFactory(session);
app.use(session({
  name: 'coinstore.sid',
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: dataDir, table: 'sessions' }),
  secret: sessionSecret || 'development-only-change-this-secret-before-deploying',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    packages: packages.map(({ id, coins, amountCents, label, displayPrice, free }) => ({ id, coins, amountCents, label, displayPrice, free: !!free })),
    brand: 'Coin Store Independente',
    officialDisclaimer: 'Serviço independente e não oficial; não afiliado, endossado ou operado pelo TikTok.'
  });
});
app.get('/api/me', (req, res) => {
  const user = getUser(req);
  if (!user) return res.json({ user: null });
  res.json({ user: publicUser(user) });
});

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(128),
  referralCode: z.string().trim().max(32).optional().nullable()
});
app.post('/api/auth/register', loginLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Confira nome, e-mail e senha (mínimo de 10 caracteres).' });
  const { name, email, password, referralCode } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail)) {
    return res.status(409).json({ error: 'Não foi possível criar a conta com esses dados. Tente entrar ou recuperar a senha.' });
  }
  let referrer = null;
  if (referralCode) {
    referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referralCode);
    if (!referrer) return res.status(400).json({ error: 'Código de indicação inválido.' });
  }
  const userId = id();
  const referral = crypto.randomBytes(6).toString('hex').toUpperCase();
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    db.prepare(`INSERT INTO users (id,name,email,password_hash,referral_code,referred_by,balance,created_at)
      VALUES (?,?,?,?,?,?,0,?)`).run(userId, name, normalizedEmail, passwordHash, referral, referrer?.id || null, now());
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'Não foi possível criar a conta com esses dados.' });
    throw error;
  }
  audit('user_registered', userId, { referredBy: referrer?.id || null });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Erro ao iniciar sessão.' });
    req.session.userId = userId;
    req.session.save(saveErr => {
      if (saveErr) return res.status(500).json({ error: 'Erro ao iniciar sessão.' });
      res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(userId)) });
    });
  });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const parsed = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'E-mail ou senha inválidos.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(parsed.data.email.toLowerCase());
  const valid = user && await bcrypt.compare(parsed.data.password, user.password_hash);
  if (!valid) {
    audit('login_failed', null, { emailHash: hashToken(parsed.data.email.toLowerCase()) });
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Não foi possível iniciar sessão.' });
    req.session.userId = user.id;
    req.session.save(saveErr => {
      if (saveErr) return res.status(500).json({ error: 'Não foi possível iniciar sessão.' });
      audit('login_success', user.id);
      res.json({ user: publicUser(user) });
    });
  });
});
app.post('/api/auth/logout', (req, res) => {
  const user = getUser(req);
  if (user) audit('logout', user.id);
  req.session.destroy(() => {
    res.clearCookie('coinstore.sid', { httpOnly: true, sameSite: 'lax', secure: isProduction });
    res.json({ ok: true });
  });
});

async function sendResetEmail(email, resetUrl) {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) return false;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: String(SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await transporter.sendMail({
    from: SMTP_FROM, to: email, subject: 'Redefinição de senha',
    text: `Recebemos uma solicitação para redefinir sua senha. O link expira em 30 minutos: ${resetUrl}\n\nSe não foi você, ignore esta mensagem.`
  });
  return true;
}
app.post('/api/auth/forgot-password', loginLimiter, async (req, res) => {
  const parsed = z.object({ email: z.string().email().max(254) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(parsed.data.email.toLowerCase());
  // Same generic response whether the account exists or not.
  if (user) {
    const rawToken = token(32);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_resets (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
      .run(hashToken(rawToken), user.id, expiresAt, now());
    const resetUrl = `${BASE_URL}/?reset=${encodeURIComponent(rawToken)}`;
    try {
      const sent = await sendResetEmail(user.email, resetUrl);
      audit('password_reset_requested', user.id, { emailSent: sent });
      if (!sent && !isProduction) console.info(`DEV password reset URL for ${user.email}: ${resetUrl}`);
      if (!sent && isProduction) console.error('Password reset requested but SMTP is not configured.');
    } catch (err) {
      console.error('Password reset email failed:', err.message);
    }
  }
  res.json({ message: 'Se o e-mail estiver cadastrado, enviaremos instruções de recuperação.' });
});
app.post('/api/auth/reset-password', loginLimiter, async (req, res) => {
  const parsed = z.object({ token: z.string().min(20).max(200), password: z.string().min(10).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Link inválido ou senha muito curta (mínimo de 10 caracteres).' });
  const reset = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hashToken(parsed.data.token));
  if (!reset || reset.used_at || reset.expires_at < now()) return res.status(400).json({ error: 'Link inválido ou expirado. Solicite outro.' });
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const transaction = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, reset.user_id);
    db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(now(), reset.token_hash);
    audit('password_reset_completed', reset.user_id);
  });
  transaction();
  res.json({ message: 'Senha alterada. Faça login com a nova senha.' });
});

app.get('/api/orders', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id,package_id,coins,amount_cents,status,created_at,paid_at,updated_at FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ orders: rows.map(row => ({
    id: row.id, packageId: row.package_id, packageLabel: packageById.get(row.package_id)?.label || row.package_id,
    coins: row.coins, amountCents: row.amount_cents, amount: (row.amount_cents / 100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}),
    status: row.status, createdAt: row.created_at, paidAt: row.paid_at
  })) });
});
app.post('/api/orders', requireAuth, (req, res) => {
  const parsed = z.object({ packageId: z.string().min(1).max(40) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Pacote inválido.' });
  const product = packageById.get(parsed.data.packageId);
  if (!product || product.free) return res.status(400).json({ error: 'Pacote pago inválido.' });
  const orderId = id();
  const callbackToken = orderId.replaceAll('-', '');
  const timestamp = now();
  const checkout = new URL(product.checkoutUrl);
  checkout.searchParams.set('callback', callbackToken);
  db.prepare(`INSERT INTO orders (id,user_id,package_id,coins,amount_cents,status,checkout_url,callback_token,created_at,updated_at)
    VALUES (?,?,?,?,?,'pending',?,?,?,?)`).run(orderId, req.user.id, product.id, product.coins, product.amountCents, checkout.toString(), callbackToken, timestamp, timestamp);
  audit('order_created', req.user.id, { orderId, packageId: product.id, amountCents: product.amountCents });
  // The callback token correlates the authenticated webhook to this order; it does not prove payment by itself.
  res.status(201).json({ orderId, status: 'pending', checkoutUrl: checkout.toString(), message: 'Pedido registrado como pendente. O saldo só muda após webhook Cakto autenticado.' });
});

app.post('/api/free-claim', requireAuth, (req, res) => {
  // Initial free reward is routed through the referral page, but not credited automatically:
  // a single-account check is not enough to safely enforce anti-abuse across multiple accounts.
  // The claim is recorded once and held for review until abuse controls are configured.
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (user.free_claimed_at) return res.status(409).json({ error: 'O resgate inicial já foi solicitado nesta conta.' });
  const ts = now();
  const transaction = db.transaction(() => {
    db.prepare('UPDATE users SET free_claimed_at=? WHERE id=? AND free_claimed_at IS NULL').run(ts, user.id);
    audit('free_claim_requested_review', user.id, { status: 'pending_review' });
  });
  transaction();
  res.status(202).json({ message: 'Solicitação registrada para análise. As moedas grátis não foram creditadas automaticamente; controles contra múltiplas contas precisam ser configurados.' });
});

app.get('/api/referrals', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id,referral_code FROM users WHERE id=?').get(req.user.id);
  const signups = db.prepare('SELECT COUNT(*) AS count FROM users WHERE referred_by=?').get(user.id).count;
  const qualified = db.prepare(`SELECT COUNT(*) AS count FROM referral_rewards WHERE referrer_id=?`).get(user.id).count;
  const groups = Math.floor(qualified / 3);
  const pending = db.prepare(`
    SELECT COUNT(DISTINCT u.id) AS count
    FROM users u
    WHERE u.referred_by=?
      AND NOT EXISTS (SELECT 1 FROM referral_rewards rr WHERE rr.referred_user_id=u.id)
      AND EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id AND o.status='pending')
  `).get(user.id).count;
  res.json({
    code: user.referral_code,
    link: `${BASE_URL}/?ref=${encodeURIComponent(user.referral_code)}`,
    signups,
    qualifiedBuyers: qualified,
    rewardGroups: groups,
    nextRewardProgress: qualified % 3,
    pendingBuyers: pending,
    rewardPolicy: '700 moedas a cada 3 compradores indicados diferentes, após confirmação real de pagamento via webhook autenticado. A confirmação ainda não está configurada.'
  });
});

// Payment confirmation is intentionally fail-closed. Do not add a guessed webhook endpoint.
// Follow current Cakto documentation and configure the provider's official authenticity check,
// event schema, idempotency, and refund/cancel events before crediting balances.
app.get('/api/integrations/payment-status', (req, res) => {
  res.json({
    provider: 'Cakto',
    status: 'pending_configuration',
    checkoutLinksConfigured: true,
    webhookConfigured: Boolean(process.env.CAKTO_WEBHOOK_SECRET),
    message: process.env.CAKTO_WEBHOOK_SECRET
      ? 'Webhook Cakto configurado para validar assinatura HMAC e segredo. Configure a URL /webhooks/cakto no painel e teste os eventos antes de abrir vendas.'
      : 'Checkout links estão configurados, mas o webhook não está ativo: configure CAKTO_WEBHOOK_SECRET no servidor e cadastre /webhooks/cakto no painel da Cakto. Nenhuma moeda paga será creditada até isso.'
  });
});

app.get('/api/profile', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), disclaimer: 'Serviço independente e não oficial; não afiliado, endossado ou operado pelo TikTok.' });
});

// All routes below are safe client-side route fallback.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Rota não encontrada.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente mais tarde.' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`Independent Coin Store running on ${BASE_URL}`));
}
export { app, db, packages };
