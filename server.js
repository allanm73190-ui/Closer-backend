// ─── CLOSER DEBRIEF — Backend v9 (objectives, comments, action_plans, deals) ─
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const cookieParser = require('cookie-parser');
const { computeDebriefQuality } = require('./lib/debriefQuality');
const { validateSections } = require('./lib/validateDebriefSections');

// ─── FEATURE FLAGS ────────────────────────────────────────────────────────────
const FEATURE_DEBRIEF_QUALITY = String(process.env.FEATURE_DEBRIEF_QUALITY || 'true').toLowerCase() !== 'false';
const FEATURE_MANAGER_COCKPIT = String(process.env.FEATURE_MANAGER_COCKPIT || 'true').toLowerCase() !== 'false';

// ─── INSTRUMENTATION (logs simples) ───────────────────────────────────────────
function logEvent(event, payload = {}) {
  try {
    console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...payload }));
  } catch (_) {}
}

const app = express();

const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_KEY      = process.env.SUPABASE_KEY      || '';
const JWT_SECRET        = process.env.JWT_SECRET        || 'change-in-prod';
const RESEND_API_KEY        = process.env.RESEND_API_KEY        || '';
const CALENDLY_SIGNING_KEY  = process.env.CALENDLY_SIGNING_KEY  || '';
const GOOGLE_CLIENT_ID      = process.env.GOOGLE_CLIENT_ID      || '';
const emailService          = require('./lib/email.service');
const loginAttempts_mod     = require('./lib/login-attempts');
const crypto                = require('crypto');
// ─── SENTRY ───────────────────────────────────────────────────────────────────
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}


const APP_URL           = process.env.APP_URL           || 'https://closerdebrief.vercel.app';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-sonnet-4-20250514';
const ANTHROPIC_FALLBACK_MODELS = (process.env.ANTHROPIC_FALLBACK_MODELS || 'claude-3-7-sonnet-latest,claude-3-5-sonnet-latest')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const PORT              = process.env.PORT              || 3001;
const IS_PROD           = process.env.NODE_ENV === 'production';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://closer-frontend-mu.vercel.app',
  'https://closerdebrief.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const CORS_ORIGINS = (process.env.CORS_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const AUTH_RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_AUTH_MAX || 20);
const AI_RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_AI_MAX || 20);
const API_RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_API_MAX || 600);
const BODY_LIMIT = process.env.BODY_LIMIT || '1mb';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const PASSWORD_MIN_LENGTH = Number(process.env.PASSWORD_MIN_LENGTH || 10);
const LOGIN_LOCK_MAX_ATTEMPTS = Number(process.env.LOGIN_LOCK_MAX_ATTEMPTS || 6);
const LOGIN_LOCK_WINDOW_MS = Number(process.env.LOGIN_LOCK_WINDOW_MS || (15 * 60 * 1000));
const LOGIN_LOCK_DURATION_MS = Number(process.env.LOGIN_LOCK_DURATION_MS || (20 * 60 * 1000));
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean)
);

if (IS_PROD && (!JWT_SECRET || JWT_SECRET === 'change-in-prod')) {
  throw new Error('JWT_SECRET manquant ou non sécurisé. Configurez une valeur unique.');
}
if (IS_PROD && (!SUPABASE_URL || !SUPABASE_KEY)) {
  throw new Error('SUPABASE_URL / SUPABASE_KEY manquants en production.');
}
if (IS_PROD && JWT_SECRET.length < 32) {
  console.warn('JWT_SECRET recommandé: 32+ caractères (longueur actuelle: %s).', JWT_SECRET.length);
}
if (IS_PROD && !process.env.TOKEN_ENCRYPTION_KEY) {
  console.warn('TOKEN_ENCRYPTION_KEY manquant en production — les tokens Google ne seront pas chiffrés.');
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Réessayez dans quelques minutes.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: AI_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes IA. Réessayez dans 1 minute.' },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: API_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes API. Réessayez dans quelques minutes.' },
});

// loginAttempts: now handled by lib/login-attempts.js (Supabase-backed + in-memory fallback)

app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", process.env.SUPABASE_URL || ''].filter(Boolean),
    },
  },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));
app.use((req, res, next) => {
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});
app.use(apiLimiter);
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true); // curl / health checks / apps natives
    if (CORS_ORIGINS.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));
app.use(cookieParser());

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── GAMIFICATION ─────────────────────────────────────────────────────────────
function computePoints(d) {
  let pts = Math.round((d.percentage || 0) / 10);
  if (d.is_closed) pts += 5;
  if ((d.percentage || 0) >= 80) pts += 3;
  if ((d.percentage || 0) >= 90) pts += 2;
  return pts;
}
function computeLevel(p) {
  if (p >= 500) return { name:'Légende',      icon:'👑', min:500, next:null };
  if (p >= 200) return { name:'Expert',        icon:'💎', min:200, next:500  };
  if (p >= 100) return { name:'Confirmé',      icon:'🥇', min:100, next:200  };
  if (p >= 50)  return { name:'Intermédiaire', icon:'🥈', min:50,  next:100  };
  if (p >= 20)  return { name:'Débutant+',     icon:'🥉', min:20,  next:50   };
  return              { name:'Débutant',       icon:'🌱', min:0,   next:20   };
}
function computeBadges(list) {
  const total  = list.length;
  const closed = list.filter(d => d.is_closed).length;
  const avg    = total > 0 ? list.reduce((s,d) => s+(d.percentage||0), 0) / total : 0;
  const badges = [];
  if (total >= 1)  badges.push({ id:'first',     icon:'🎯', label:'Premier debrief'  });
  if (total >= 10) badges.push({ id:'ten',        icon:'🔥', label:'10 debriefs'      });
  if (total >= 50) badges.push({ id:'fifty',      icon:'💪', label:'50 debriefs'      });
  if (closed >= 1) badges.push({ id:'closer1',    icon:'✅', label:'Premier closing'  });
  if (closed >= 10)badges.push({ id:'closer10',   icon:'🏆', label:'10 closings'      });
  if (list.some(d => (d.percentage||0) >= 90)) badges.push({ id:'perfect', icon:'⭐', label:'Score parfait' });
  if (avg >= 80)   badges.push({ id:'consistent', icon:'📈', label:'Régularité 80%+' });
  return badges;
}
function computeSectionScores(sections) {
  const s = sections || {};
  const pct = (pts, max) => max > 0 ? Math.round((pts / max) * 5) : 0;
  const d = s.decouverte || {};
  let dP = 0;
  if (d.douleur_surface === 'oui') dP++;
  if (['oui','partiel'].includes(d.douleur_profonde)) dP++;
  if (Array.isArray(d.couches_douleur)) dP += Math.min(d.couches_douleur.length, 3);
  if (d.temporalite === 'oui') dP++;
  if (['oui','artificielle'].includes(d.urgence)) dP++;
  const r = s.reformulation || {};
  let rP = 0;
  if (['oui','partiel'].includes(r.reformulation)) rP++;
  if (['oui','moyen'].includes(r.prospect_reconnu)) rP++;
  if (Array.isArray(r.couches_reformulation)) rP += Math.min(r.couches_reformulation.length, 3);
  const p = s.projection || {};
  let pP = 0;
  if (p.projection_posee === 'oui') pP++;
  if (['forte','moyenne'].includes(p.qualite_reponse)) pP++;
  if (p.deadline_levier === 'oui') pP++;
  const o = s.offre || {};
  let oP = 0;
  if (['oui','partiel'].includes(o.colle_douleurs)) oP++;
  if (['oui','moyen'].includes(o.exemples_transformation)) oP++;
  if (['oui','partiel'].includes(o.duree_justifiee)) oP++;
  const c = s.closing || {};
  const objections = Array.isArray(c.objections) ? c.objections : [];
  const hasNoObjection = objections.includes('aucune');
  const closingMax = hasNoObjection ? 3 : 5;
  let cP = 0;
  if (c.annonce_prix === 'directe') cP++;
  if (c.silence_prix === 'oui') cP++;
  if (!hasNoObjection && c.douleur_reancree === 'oui') cP++;
  if (!hasNoObjection && c.objection_isolee === 'oui') cP++;
  if (['close','retrograde','relance'].includes(c.resultat_closing)) cP++;
  return { decouverte:pct(dP,7), reformulation:pct(rP,5), projection:pct(pP,3), presentation_offre:pct(oP,3), closing:pct(cP,closingMax) };
}

function computeDebriefTotals(sections) {
  let pts = 0;
  let maxRaw = 0;
  const add = (val, pos, total) => {
    maxRaw += total;
    if (Array.isArray(pos)) {
      if (Array.isArray(val)) pts += val.filter(v => pos.includes(v)).length;
      else if (pos.includes(val)) pts++;
    } else if (val === pos) pts++;
  };

  const d = sections?.decouverte || {};
  add(d.douleur_surface, 'oui', 1);
  add(d.douleur_profonde, ['oui', 'partiel'], 1);
  add(d.couches_douleur, ['couche1', 'couche2', 'couche3'], 3);
  add(d.temporalite, 'oui', 1);
  add(d.urgence, ['oui', 'artificielle'], 1);

  const r = sections?.reformulation || {};
  add(r.reformulation, ['oui', 'partiel'], 1);
  add(r.prospect_reconnu, ['oui', 'moyen'], 1);
  add(r.couches_reformulation, ['physique', 'quotidien', 'identitaire'], 3);

  const p = sections?.projection || {};
  add(p.projection_posee, 'oui', 1);
  add(p.qualite_reponse, ['forte', 'moyenne'], 1);
  add(p.deadline_levier, 'oui', 1);

  const o = sections?.offre || sections?.presentation_offre || {};
  add(o.colle_douleurs, ['oui', 'partiel'], 1);
  add(o.exemples_transformation, ['oui', 'moyen'], 1);
  add(o.duree_justifiee, ['oui', 'partiel'], 1);

  const c = sections?.closing || {};
  const objections = Array.isArray(c.objections) ? c.objections : [];
  const hasNoObjection = objections.includes('aucune');
  add(c.annonce_prix, 'directe', 1);
  add(c.silence_prix, 'oui', 1);
  if (!hasNoObjection) {
    add(c.douleur_reancree, 'oui', 1);
    add(c.objection_isolee, 'oui', 1);
  }
  add(c.resultat_closing, ['close', 'retrograde', 'relance'], 1);

  const percentage = maxRaw > 0 ? Math.round((pts / maxRaw) * 100) : 0;
  const score20 = maxRaw > 0 ? Math.round(((pts / maxRaw) * 20) * 10) / 10 : 0;
  return { total: score20, max: 20, percentage, raw_total: pts, raw_max: maxRaw };
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function normalizeRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'admin') return 'admin';
  if (normalized === 'head_of_sales') return 'head_of_sales';
  return 'closer';
}

function isAdminRole(role) {
  return normalizeRole(role) === 'admin';
}

function isManagerRole(role) {
  const normalized = normalizeRole(role);
  return normalized === 'head_of_sales' || normalized === 'admin';
}

function isAdminEmail(email) {
  const normalized = normalizeEmailForSecurity(email);
  return normalized ? ADMIN_EMAILS.has(normalized) : false;
}

function getEffectiveRole(userLike) {
  if (!userLike) return 'closer';
  if (isAdminEmail(userLike.email)) return 'admin';
  return normalizeRole(userLike.role);
}

function attachEffectiveRole(userLike) {
  if (!userLike) return userLike;
  return { ...userLike, role: getEffectiveRole(userLike) };
}

function parsePagination(query) {
  const page   = Math.max(1, parseInt(query.page)  || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function authenticate(req, res, next) {
  // Support httpOnly cookie (preferred) or Authorization Bearer header (legacy/mobile)
  let token = req.cookies?.cd_token;
  if (!token) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) token = auth.split(' ')[1];
  }
  if (!token) return res.status(401).json({ error:'Token manquant', code:'AUTH_REQUIRED' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = attachEffectiveRole(decoded);
    next();
  }
  catch { return res.status(401).json({ error:'Session expirée', code:'TOKEN_EXPIRED' }); }
}
function requireHOS(req, res, next) {
  if (!isManagerRole(req.user.role)) return res.status(403).json({ error:'Accès réservé aux Head of Sales / Admin' });
  next();
}
function requireAdmin(req, res, next) {
  if (!isAdminRole(req.user.role)) return res.status(403).json({ error:'Accès réservé aux Admins' });
  next();
}
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length:8 }, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const _gamCache = new Map();
const _GAM_TTL  = 30 * 1000; // 30s cache
function invalidateGamCache(userId) { _gamCache.delete(userId); }
async function buildGamification(userId) {
  const cached = _gamCache.get(userId);
  if (cached && Date.now() < cached.expiry) return cached.data;
  const { data } = await supabase.from('debriefs').select('percentage,is_closed').eq('user_id', userId).order('created_at', { ascending:true });
  const list = data || [];
  const points     = list.reduce((s,d) => s+computePoints(d), 0);
  const prevPoints = list.slice(0,-1).reduce((s,d) => s+computePoints(d), 0);
  const pointsEarned = list.length > 0 ? computePoints(list[list.length-1]) : 0;
  const level = computeLevel(points), prevLevel = computeLevel(prevPoints);
  const result = { points, pointsEarned, level, prevLevel, levelUp:level.name!==prevLevel.name&&list.length>0, badges:computeBadges(list), totalDebriefs:list.length };
  _gamCache.set(userId, { data: result, expiry: Date.now() + _GAM_TTL });
  return result;
}
function buildMemberStats(member, debriefs) {
  const ud = debriefs.filter(d => d.user_id === member.id);
  const points   = ud.reduce((s,d) => s+computePoints(d), 0);
  const avgScore = ud.length > 0 ? Math.round(ud.reduce((s,d)=>s+(d.percentage||0),0)/ud.length) : 0;
  const chartData = [...ud].sort((a,b)=>new Date(a.call_date)-new Date(b.call_date)).map(d=>({ date:d.call_date, score:Math.round(d.percentage||0), prospect:d.prospect_name }));
  return { ...member, points, level:computeLevel(points), badges:computeBadges(ud), avgScore, totalDebriefs:ud.length, closed:ud.filter(d=>d.is_closed).length, chartData };
}
async function assertTeamOwner(teamId, userId, actorRole = 'head_of_sales') {
  const { data } = await supabase.from('teams').select('id,owner_id').eq('id', teamId).single();
  if (!data) return null;
  if (isAdminRole(actorRole)) return data;
  if (data.owner_id !== userId) return null;
  return data;
}
const _hosTeamCache = new Map();
const _HOS_CACHE_TTL = 5 * 60 * 1000;
async function getHOSTeamMemberIds(hosId) {
  const cached = _hosTeamCache.get(hosId);
  if (cached && Date.now() < cached.expiry) return cached.ids;
  const { data: teams } = await supabase.from('teams').select('id').eq('owner_id', hosId);
  if (!teams?.length) { _hosTeamCache.set(hosId, { ids: [], expiry: Date.now() + _HOS_CACHE_TTL }); return []; }
  const { data: members } = await supabase.from('users').select('id').in('team_id', teams.map(t=>t.id));
  const ids = (members||[]).map(m => m.id);
  _hosTeamCache.set(hosId, { ids, expiry: Date.now() + _HOS_CACHE_TTL });
  return ids;
}

async function canUserAccessOwnerData(user, ownerUserId) {
  if (!user?.id) return false;
  if (isAdminRole(user.role)) return true;
  if (!ownerUserId) return false;
  if (ownerUserId === user.id) return true;
  if (!isManagerRole(user.role)) return false;
  const memberIds = await getHOSTeamMemberIds(user.id);
  return memberIds.includes(ownerUserId);
}

async function assertCloserManagedByHOS(hosId, closerId, actorRole = 'head_of_sales') {
  if (!hosId || !closerId) return false;
  if (isAdminRole(actorRole)) return true;
  const { data: closer } = await supabase
    .from('users')
    .select('id,role,team_id')
    .eq('id', closerId)
    .single();
  if (!closer || closer.role !== 'closer' || !closer.team_id) return false;
  const { data: team } = await supabase
    .from('teams')
    .select('owner_id')
    .eq('id', closer.team_id)
    .single();
  return !!team && team.owner_id === hosId;
}

async function getDebriefConfigScopeOwnerId(user) {
  if (!user?.id) return null;
  if (isManagerRole(user.role)) return user.id;

  const { data: me } = await supabase
    .from('users')
    .select('team_id')
    .eq('id', user.id)
    .single();
  if (!me?.team_id) return user.id;

  const { data: team } = await supabase
    .from('teams')
    .select('owner_id')
    .eq('id', me.team_id)
    .single();
  return team?.owner_id || user.id;
}

async function getUserWithEffectiveRole(userId) {
  if (!userId) return null;
  const { data: rawUser } = await supabase
    .from('users')
    .select('id,email,name,role')
    .eq('id', userId)
    .single();
  if (!rawUser) return null;
  return attachEffectiveRole(rawUser);
}

function extractPipelineStatusContext(config) {
  const statuses = Array.isArray(config?.statuses) && config.statuses.length > 0
    ? config.statuses
    : DEFAULT_PIPELINE_CONFIG.statuses;
  const wonKey = statuses.find(status => status.won)?.key
    || statuses.find(status => status.closed)?.key
    || 'signe';
  const openKey = statuses.find(status => !status.closed)?.key || 'prospect';
  const closedKeys = new Set(statuses.filter(status => status.closed).map(status => status.key));
  return { statuses, wonKey, openKey, closedKeys };
}

async function getPipelineStatusContextForUser(userLike) {
  const scopeOwnerId = await getDebriefConfigScopeOwnerId(userLike);
  const config = await getActivePipelineConfig(scopeOwnerId);
  return extractPipelineStatusContext(config);
}

async function getPipelineStatusContextForOwnerId(ownerUserId) {
  const ownerUser = await getUserWithEffectiveRole(ownerUserId);
  if (!ownerUser) return extractPipelineStatusContext(DEFAULT_PIPELINE_CONFIG);
  return getPipelineStatusContextForUser(ownerUser);
}

const DEFAULT_DEBRIEF_SECTION_CONFIG = [
  { key: 'decouverte',        title: 'Phase de découverte',       questions: [] },
  { key: 'reformulation',     title: 'Reformulation',             questions: [] },
  { key: 'projection',        title: 'Projection',                questions: [] },
  { key: 'presentation_offre',title: "Présentation de l'offre",   questions: [] },
  { key: 'closing',           title: 'Closing & Objections',      questions: [] },
];
const PIPELINE_CONFIG_MARKER = '__pipeline_config__';
const DEBRIEF_TEMPLATE_CONFIG_MARKER = '__debrief_templates__';
const APP_SETTINGS_CONFIG_MARKER = '__app_settings__';
const SECURITY_AUDIT_MARKER = '__security_audit__';
const DEBRIEF_SECTION_KEYS = new Set(['decouverte', 'reformulation', 'projection', 'presentation_offre', 'closing']);
const DEFAULT_APP_SETTINGS = {
  theme: 'light',
  autoAiAfterDebrief: true,
};
const DEFAULT_DEBRIEF_TEMPLATE_CATALOG = {
  defaultTemplateKey: 'standard',
  templates: [
    {
      key: 'standard',
      label: 'Standard Closer',
      description: 'Template généraliste pour la majorité des offres.',
      aiFocus: 'Analyse équilibrée du cycle de vente standard.',
    },
    {
      key: 'high_ticket',
      label: 'High Ticket',
      description: 'Offres premium avec enjeu valeur/prix et engagement élevé.',
      aiFocus: "Accent sur la transition valeur/prix, le cadrage de l'investissement et la posture de closing.",
    },
    {
      key: 'b2b_service',
      label: 'Service B2B',
      description: 'Vente de services aux entreprises avec parties prenantes.',
      aiFocus: 'Accent sur qualification du décideur, ROI, risques et process de décision.',
    },
    {
      key: 'formation_coaching',
      label: 'Formation / Coaching',
      description: "Programmes d'accompagnement, compétences et transformation.",
      aiFocus: 'Accent sur motivation réelle, capacité de mise en action et preuves de transformation.',
    },
  ],
};
const DEFAULT_PIPELINE_CONFIG = {
  statuses: [
    { key:'prospect', label:'Prospects', icon:'👤', color:'#6b7280', bg:'#f1f5f9', closed:false, won:false },
    { key:'premier_appel', label:'1er appel', icon:'📞', color:'#e87d6a', bg:'rgba(253,232,228,.6)', closed:false, won:false },
    { key:'relance', label:'Relance', icon:'🔄', color:'#d97706', bg:'#fef3c7', closed:false, won:false },
    { key:'negociation', label:'Négociation', icon:'🤝', color:'#3b82f6', bg:'#dbeafe', closed:false, won:false },
    { key:'signe', label:'Signés', icon:'✅', color:'#059669', bg:'#d1fae5', closed:true, won:true },
    { key:'perdu', label:'Perdus', icon:'❌', color:'#dc2626', bg:'#fee2e2', closed:true, won:false },
  ],
  importantFields: ['first_name', 'last_name', 'email', 'phone', 'source', 'deal_closed', 'value', 'contact_date', 'note'],
};
const PIPELINE_ALLOWED_FIELDS = new Set(['first_name', 'last_name', 'email', 'phone', 'source', 'deal_closed', 'value', 'contact_date', 'note']);

function sanitizePipelineKey(value, fallback) {
  const base = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || fallback;
}

function isPipelineConfigEnvelope(sections) {
  return Array.isArray(sections)
    && sections.length === 1
    && sections[0]
    && sections[0].key === PIPELINE_CONFIG_MARKER
    && typeof sections[0].data === 'object'
    && sections[0].data !== null;
}

function isDebriefConfigSections(sections) {
  return Array.isArray(sections)
    && sections.length > 0
    && !isPipelineConfigEnvelope(sections)
    && !isDebriefTemplateEnvelope(sections)
    && !isAppSettingsEnvelope(sections)
    && sections.some(section => section && DEBRIEF_SECTION_KEYS.has(String(section.key || '')));
}

function normalizePipelineStatuses(statuses) {
  const list = Array.isArray(statuses) ? statuses : DEFAULT_PIPELINE_CONFIG.statuses;
  const seen = new Set();
  const normalized = [];
  for (let i = 0; i < list.length; i++) {
    const status = list[i] || {};
    const keyBase = sanitizePipelineKey(status.key || status.label || `status_${i + 1}`, `status_${i + 1}`);
    let key = keyBase;
    let suffix = 2;
    while (seen.has(key)) {
      key = `${keyBase}_${suffix}`;
      suffix += 1;
    }
    seen.add(key);
    normalized.push({
      key,
      label: String(status.label || key).trim() || key,
      icon: String(status.icon || '•').trim() || '•',
      color: String(status.color || '#6b7280'),
      bg: String(status.bg || '#f1f5f9'),
      closed: !!status.closed,
      won: !!status.won,
    });
  }
  return normalized.length > 0 ? normalized : DEFAULT_PIPELINE_CONFIG.statuses;
}

function normalizePipelineImportantFields(fields) {
  const list = Array.isArray(fields) ? fields.filter(field => PIPELINE_ALLOWED_FIELDS.has(field)) : [];
  return list.length > 0 ? list : DEFAULT_PIPELINE_CONFIG.importantFields;
}

function normalizePipelineConfig(config) {
  return {
    statuses: normalizePipelineStatuses(config?.statuses),
    importantFields: normalizePipelineImportantFields(config?.importantFields),
  };
}

function isDebriefTemplateEnvelope(sections) {
  return Array.isArray(sections)
    && sections.length === 1
    && sections[0]
    && sections[0].key === DEBRIEF_TEMPLATE_CONFIG_MARKER
    && typeof sections[0].data === 'object'
    && sections[0].data !== null;
}

function isAppSettingsEnvelope(sections) {
  return Array.isArray(sections)
    && sections.length === 1
    && sections[0]
    && sections[0].key === APP_SETTINGS_CONFIG_MARKER
    && typeof sections[0].data === 'object'
    && sections[0].data !== null;
}

function isSecurityAuditEnvelope(sections) {
  return Array.isArray(sections)
    && sections.length === 1
    && sections[0]
    && sections[0].key === SECURITY_AUDIT_MARKER
    && typeof sections[0].data === 'object'
    && sections[0].data !== null;
}

function normalizeEmailForSecurity(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeNameForSecurity(value) {
  return String(value || '').trim().toLowerCase();
}

function validatePasswordPolicy(password, context = {}) {
  const pwd = String(password || '');
  if (pwd.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      message: `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères.`,
      code: 'PASSWORD_TOO_SHORT',
    };
  }

  const tests = {
    lower: /[a-z]/.test(pwd),
    upper: /[A-Z]/.test(pwd),
    digit: /[0-9]/.test(pwd),
    symbol: /[^A-Za-z0-9]/.test(pwd),
  };
  const score = Object.values(tests).filter(Boolean).length;
  if (score < 3) {
    return {
      ok: false,
      message: 'Le mot de passe doit combiner au moins 3 éléments: majuscule, minuscule, chiffre, symbole.',
      code: 'PASSWORD_WEAK_PATTERN',
    };
  }

  const blockedPatterns = ['password', 'motdepasse', '123456', 'qwerty', 'azerty', 'closerdebrief'];
  const lowerPwd = pwd.toLowerCase();
  for (const pattern of blockedPatterns) {
    if (lowerPwd.includes(pattern)) {
      return {
        ok: false,
        message: 'Le mot de passe contient un motif trop prévisible.',
        code: 'PASSWORD_PREDICTABLE',
      };
    }
  }

  const email = normalizeEmailForSecurity(context.email);
  if (email) {
    const emailParts = email.split('@')[0]?.split(/[._-]/).filter(Boolean) || [];
    if (emailParts.some(part => part.length >= 3 && lowerPwd.includes(part))) {
      return {
        ok: false,
        message: "Le mot de passe ne doit pas contenir une partie de l'email.",
        code: 'PASSWORD_CONTAINS_EMAIL',
      };
    }
  }

  const name = normalizeNameForSecurity(context.name);
  if (name) {
    const nameParts = name.split(/\s+/).filter(Boolean);
    if (nameParts.some(part => part.length >= 3 && lowerPwd.includes(part))) {
      return {
        ok: false,
        message: "Le mot de passe ne doit pas contenir votre prénom ou nom.",
        code: 'PASSWORD_CONTAINS_NAME',
      };
    }
  }

  return { ok: true, code: 'PASSWORD_OK' };
}

async function getLoginState(email) {
  return loginAttempts_mod.getLoginState(email);
}

async function registerLoginFailure(email) {
  return loginAttempts_mod.registerLoginFailure(email);
}

async function clearLoginFailures(email) {
  return loginAttempts_mod.clearLoginFailures(email);
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function sanitizeAuditDetails(details) {
  const forbidden = new Set(['password', 'newPassword', 'currentPassword', 'token', 'authorization', 'jwt']);
  if (!details || typeof details !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (forbidden.has(key)) continue;
    if (value === undefined) continue;
    if (value === null) {
      result[key] = null;
      continue;
    }
    if (typeof value === 'string') {
      result[key] = value.slice(0, 320);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = value.slice(0, 20).map(item => typeof item === 'string' ? item.slice(0, 120) : item);
      continue;
    }
    if (typeof value === 'object') {
      result[key] = JSON.parse(JSON.stringify(value));
    }
  }
  return result;
}

async function recordSecurityAudit({
  actorId,
  actorRole,
  action,
  outcome = 'success',
  req = null,
  details = {},
}) {
  if (!actorId || !action) return;
  const payload = {
    action,
    outcome,
    actor_id: actorId,
    actor_role: actorRole || 'unknown',
    request_id: req?.requestId || null,
    ip: req ? getClientIp(req) : null,
    user_agent: req ? String(req.headers['user-agent'] || '').slice(0, 260) : null,
    details: sanitizeAuditDetails(details),
    created_at: new Date().toISOString(),
  };
  try {
    await supabase.from('debrief_config').insert({
      sections: [{ key: SECURITY_AUDIT_MARKER, data: payload }],
      updated_by: actorId,
    });
  } catch (error) {
    console.error('Security audit insert error:', error?.message || error);
  }
}

function normalizeDebriefTemplateCatalog(catalog) {
  const sourceTemplates = Array.isArray(catalog?.templates)
    ? catalog.templates
    : DEFAULT_DEBRIEF_TEMPLATE_CATALOG.templates;
  const seen = new Set();
  const templates = [];
  for (let i = 0; i < sourceTemplates.length; i++) {
    const template = sourceTemplates[i] || {};
    const keyBase = sanitizePipelineKey(template.key || template.label || `template_${i + 1}`, `template_${i + 1}`);
    let key = keyBase;
    let suffix = 2;
    while (seen.has(key)) {
      key = `${keyBase}_${suffix}`;
      suffix += 1;
    }
    seen.add(key);
    templates.push({
      key,
      label: String(template.label || key).trim() || key,
      description: String(template.description || '').trim(),
      aiFocus: String(template.aiFocus || '').trim(),
    });
  }
  const normalizedTemplates = templates.length > 0
    ? templates
    : DEFAULT_DEBRIEF_TEMPLATE_CATALOG.templates;
  const wantedDefaultKey = sanitizePipelineKey(catalog?.defaultTemplateKey || '', '');
  const defaultTemplateKey = normalizedTemplates.some(template => template.key === wantedDefaultKey)
    ? wantedDefaultKey
    : normalizedTemplates[0].key;
  return {
    defaultTemplateKey,
    templates: normalizedTemplates,
  };
}

function normalizeAppSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const theme = source.theme === 'dark' ? 'dark' : 'light';
  let autoAiAfterDebrief = DEFAULT_APP_SETTINGS.autoAiAfterDebrief;
  if (typeof source.autoAiAfterDebrief === 'boolean') {
    autoAiAfterDebrief = source.autoAiAfterDebrief;
  } else if (typeof source.auto_ai_after_debrief === 'boolean') {
    autoAiAfterDebrief = source.auto_ai_after_debrief;
  }
  return {
    theme,
    autoAiAfterDebrief,
  };
}

const CONTACT_META_PREFIX = '[CD_CONTACT_META]';

function sanitizeContactText(value, max = 180) {
  return String(value || '').trim().slice(0, max);
}

function sanitizeContactDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function parseDealNotes(rawNotes) {
  const raw = typeof rawNotes === 'string' ? rawNotes : '';
  if (!raw.startsWith(CONTACT_META_PREFIX)) {
    return { meta: null, note: raw };
  }
  const payload = raw.slice(CONTACT_META_PREFIX.length);
  const firstLineBreak = payload.indexOf('\n');
  const jsonPart = firstLineBreak === -1 ? payload : payload.slice(0, firstLineBreak);
  const notePart = firstLineBreak === -1 ? '' : payload.slice(firstLineBreak + 1).replace(/^\n/, '');
  try {
    const meta = JSON.parse(jsonPart);
    return { meta: meta && typeof meta === 'object' ? meta : null, note: notePart };
  } catch {
    return { meta: null, note: raw };
  }
}

function normalizeContactMeta(input, fallbackStatus) {
  const source = input || {};
  const first_name = sanitizeContactText(source.first_name, 120);
  const last_name = sanitizeContactText(source.last_name, 120);
  const email = sanitizeContactText(source.email, 180).toLowerCase();
  const phone = sanitizeContactText(source.phone, 60);
  const contact_date = sanitizeContactDate(source.contact_date);
  let deal_closed = null;
  if (typeof source.deal_closed === 'boolean') {
    deal_closed = source.deal_closed;
  } else if (typeof source.deal_closed === 'string') {
    const boolMap = { 'true': true, 'false': false, '1': true, '0': false, 'oui': true, 'non': false };
    if (Object.prototype.hasOwnProperty.call(boolMap, source.deal_closed.toLowerCase())) {
      deal_closed = boolMap[source.deal_closed.toLowerCase()];
    }
  } else if (typeof fallbackStatus === 'string') {
    deal_closed = /signe|won|close/i.test(fallbackStatus);
  }
  return { first_name, last_name, email, phone, contact_date, deal_closed };
}

function buildDealNotes(meta, note) {
  const cleanNote = typeof note === 'string' ? note.trim() : '';
  const hasMeta = meta && Object.values(meta).some(value => value !== null && value !== '');
  if (!hasMeta) return cleanNote;
  return `${CONTACT_META_PREFIX}${JSON.stringify(meta)}\n${cleanNote}`;
}

function inferProspectName(payload, fallback) {
  const direct = sanitizeContactText(payload?.prospect_name || '', 220);
  if (direct) return direct;
  const full = `${sanitizeContactText(payload?.first_name || '', 120)} ${sanitizeContactText(payload?.last_name || '', 120)}`.trim();
  if (full) return full;
  return sanitizeContactText(fallback || '', 220);
}

function mapDealForClient(deal) {
  const parsed = parseDealNotes(deal?.notes);
  const meta = normalizeContactMeta(parsed.meta || {}, deal?.status);
  const note = typeof parsed.note === 'string' ? parsed.note : '';
  const resolvedStatus = typeof deal?.status === 'string' && deal.status.trim()
    ? deal.status.trim()
    : (meta.deal_closed ? 'signe' : 'prospect');
  return {
    ...deal,
    status: resolvedStatus,
    notes: note,
    note,
    first_name: meta.first_name || '',
    last_name: meta.last_name || '',
    email: meta.email || '',
    phone: meta.phone || '',
    contact_date: meta.contact_date || deal?.follow_up_date || null,
    deal_closed: typeof meta.deal_closed === 'boolean' ? meta.deal_closed : /signe|won|close/i.test(String(deal?.status || '')),
  };
}

function normalizeSectionKey(rawKey) {
  if (!rawKey) return rawKey;
  return rawKey === 'presentation_offre' ? 'offre' : rawKey;
}

function scoreKeyFromSectionKey(rawKey) {
  if (!rawKey) return rawKey;
  return rawKey === 'offre' ? 'presentation_offre' : rawKey;
}

function getSectionDataByKey(allSections, rawKey) {
  const sections = allSections || {};
  const normalized = normalizeSectionKey(rawKey);
  if (sections[normalized]) return sections[normalized];
  if (normalized === 'offre' && sections.presentation_offre) return sections.presentation_offre;
  if (normalized === 'presentation_offre' && sections.offre) return sections.offre;
  return {};
}

function getSectionNotesByKey(allNotes, rawKey) {
  const notes = allNotes || {};
  const normalized = normalizeSectionKey(rawKey);
  if (notes[normalized]) return notes[normalized];
  if (normalized === 'offre' && notes.presentation_offre) return notes.presentation_offre;
  if (normalized === 'presentation_offre' && notes.offre) return notes.offre;
  return {};
}

function formatAnswerFromQuestion(question, rawValue) {
  if (rawValue === null || rawValue === undefined) return '';
  if (typeof rawValue === 'string' && !rawValue.trim()) return '';
  if (Array.isArray(rawValue) && rawValue.length === 0) return '';

  const opts = Array.isArray(question?.options) ? question.options : [];
  const labelByValue = new Map(opts.map(opt => [String(opt.value), opt.label || opt.value]));

  if (Array.isArray(rawValue)) {
    return rawValue.map(v => labelByValue.get(String(v)) || String(v)).join(', ');
  }
  return labelByValue.get(String(rawValue)) || String(rawValue);
}

function cleanScriptText(value, max = 420) {
  const cleaned = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, max);
}

function normalizeSnippetKey(value) {
  return cleanScriptText(value, 500)
    .toLowerCase()
    .replace(/[^a-z0-9àâäçéèêëîïôöùûüÿñæœ'’\s-]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractObjectionScript(source) {
  const candidates = [
    source?.section_notes?.closing?.improvement,
    source?.section_notes?.closing?.strength,
    source?.section_notes_closing?.improvement,
    source?.section_notes_closing?.strength,
    source?.notes,
  ];
  for (const candidate of candidates) {
    const script = cleanScriptText(candidate, 420);
    if (script.length >= 24) return script;
  }
  return '';
}

function buildObjectionResponse(debriefs) {
  const list = Array.isArray(debriefs) ? debriefs : [];
  const OBJECTION_LABELS = {
    budget: 'Budget',
    reflechir: 'Besoin de réfléchir',
    conjoint: 'Conjoint / Tiers',
    methode: 'Méthode / Doute produit',
  };
  const objMap = {};
  for (const d of list) {
    const closing = d.sections?.closing || {};
    const objections = closing.objections || [];
    const objectionScript = extractObjectionScript(d);
    for (const type of objections) {
      if (type === 'aucune') continue;
      if (!objMap[type]) objMap[type] = { type, label: OBJECTION_LABELS[type] || type, count: 0, closed: 0, debriefs: [] };
      objMap[type].count++;
      if (d.is_closed) objMap[type].closed++;
      objMap[type].debriefs.push({
        id: d.id,
        prospect_name: d.prospect_name,
        call_date: d.call_date,
        user_name: d.user_name,
        is_closed: d.is_closed,
        percentage: d.percentage,
        douleur_reancree: closing.douleur_reancree,
        objection_isolee: closing.objection_isolee,
        resultat_closing: closing.resultat_closing,
        notes: d.notes,
        section_notes_closing: d.section_notes?.closing || {},
        objection_script: objectionScript,
      });
    }
  }

  const objections = Object.values(objMap)
    .map(item => {
      const snippetMap = {};
      for (const d of item.debriefs) {
        const script = cleanScriptText(d.objection_script, 420);
        if (!script) continue;
        const key = normalizeSnippetKey(script);
        if (!key) continue;
        if (!snippetMap[key]) {
          snippetMap[key] = {
            text: script,
            uses: 0,
            closed: 0,
            scores: [],
            examples: [],
          };
        }
        snippetMap[key].uses += 1;
        if (d.is_closed) snippetMap[key].closed += 1;
        snippetMap[key].scores.push(Number(d.percentage || 0));
        if (snippetMap[key].examples.length < 2) {
          snippetMap[key].examples.push({
            prospect_name: d.prospect_name || 'Inconnu',
            call_date: d.call_date,
            is_closed: !!d.is_closed,
          });
        }
      }
      const validatedResponses = Object.values(snippetMap)
        .map(snippet => {
          const closeRate = snippet.uses > 0 ? Math.round((snippet.closed / snippet.uses) * 100) : 0;
          const avgScore = snippet.scores.length > 0
            ? Math.round(snippet.scores.reduce((sum, value) => sum + value, 0) / snippet.scores.length)
            : 0;
          return {
            text: snippet.text,
            uses: snippet.uses,
            closeRate,
            avgScore,
            validated: snippet.uses >= 2 ? closeRate >= 50 : closeRate >= 80,
            examples: snippet.examples,
          };
        })
        .sort((a, b) => {
          if (b.validated !== a.validated) return (b.validated ? 1 : 0) - (a.validated ? 1 : 0);
          if (b.closeRate !== a.closeRate) return b.closeRate - a.closeRate;
          if (b.uses !== a.uses) return b.uses - a.uses;
          return b.avgScore - a.avgScore;
        })
        .slice(0, 6);

      return {
        ...item,
        closingRate: item.count > 0 ? Math.round((item.closed / item.count) * 100) : 0,
        bestResponses: item.debriefs
          .filter(d => d.is_closed)
          .sort((a, b) => (b.percentage || 0) - (a.percentage || 0))
          .slice(0, 5),
        worstCases: item.debriefs
          .filter(d => !d.is_closed)
          .sort((a, b) => (a.percentage || 0) - (b.percentage || 0))
          .slice(0, 3),
        validatedResponses,
      };
    })
    .sort((a, b) => b.count - a.count);

  return {
    total: list.length,
    totalWithObjections: list.filter(d => {
      const objectionsList = d.sections?.closing?.objections || [];
      return objectionsList.length > 0 && !objectionsList.includes('aucune');
    }).length,
    objections,
  };
}

function toStartOfDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function getDaysSince(value) {
  const date = toStartOfDay(value);
  if (!date) return null;
  const now = toStartOfDay(new Date());
  const diff = now.getTime() - date.getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

function computePatternInsights(debriefs) {
  const list = Array.isArray(debriefs) ? debriefs : [];
  const lost = list.filter(d => !d.is_closed);
  const totalLost = lost.length;
  if (totalLost === 0) return [];

  const seed = {
    transition_value_price: {
      id: 'transition_value_price',
      title: 'Transition valeur/prix fragile',
      recommendation: "Avant d'annoncer le prix, reformule la valeur et pose une question de calibration.",
      count: 0,
      sampleProspects: [],
    },
    objection_isolation: {
      id: 'objection_isolation',
      title: "Objection non isolée",
      recommendation: "Valide l'objection principale puis demande explicitement s'il y en a une autre.",
      count: 0,
      sampleProspects: [],
    },
    urgency_missing: {
      id: 'urgency_missing',
      title: 'Urgence insuffisante en découverte',
      recommendation: 'Creuse la temporalité réelle et le coût concret de la non-décision.',
      count: 0,
      sampleProspects: [],
    },
    projection_missing: {
      id: 'projection_missing',
      title: 'Projection trop faible',
      recommendation: "Ajoute une question de projection concrète vers l'après accompagnement.",
      count: 0,
      sampleProspects: [],
    },
    offer_alignment: {
      id: 'offer_alignment',
      title: 'Offre insuffisamment reliée aux douleurs',
      recommendation: 'Rattache chaque élément de ton offre à une douleur exprimée par le prospect.',
      count: 0,
      sampleProspects: [],
    },
  };

  for (const d of lost) {
    const sections = d.sections || {};
    const closing = sections.closing || {};
    const decouverte = sections.decouverte || {};
    const projection = sections.projection || {};
    const offre = sections.offre || sections.presentation_offre || {};

    if (closing.annonce_prix !== 'directe' || closing.silence_prix !== 'oui') {
      seed.transition_value_price.count += 1;
      if (seed.transition_value_price.sampleProspects.length < 3 && d.prospect_name) {
        seed.transition_value_price.sampleProspects.push(d.prospect_name);
      }
    }

    if (closing.objection_isolee !== 'oui') {
      seed.objection_isolation.count += 1;
      if (seed.objection_isolation.sampleProspects.length < 3 && d.prospect_name) {
        seed.objection_isolation.sampleProspects.push(d.prospect_name);
      }
    }

    if (!['oui', 'artificielle'].includes(decouverte.urgence)) {
      seed.urgency_missing.count += 1;
      if (seed.urgency_missing.sampleProspects.length < 3 && d.prospect_name) {
        seed.urgency_missing.sampleProspects.push(d.prospect_name);
      }
    }

    if (projection.projection_posee !== 'oui') {
      seed.projection_missing.count += 1;
      if (seed.projection_missing.sampleProspects.length < 3 && d.prospect_name) {
        seed.projection_missing.sampleProspects.push(d.prospect_name);
      }
    }

    if (!['oui', 'partiel'].includes(offre.colle_douleurs)) {
      seed.offer_alignment.count += 1;
      if (seed.offer_alignment.sampleProspects.length < 3 && d.prospect_name) {
        seed.offer_alignment.sampleProspects.push(d.prospect_name);
      }
    }
  }

  return Object.values(seed)
    .filter(pattern => pattern.count > 0)
    .map(pattern => {
      const rate = Math.round((pattern.count / totalLost) * 100);
      return {
        ...pattern,
        rate,
        message: `Pattern détecté sur ${pattern.count}/${totalLost} appels non closés (${rate}%).`,
      };
    })
    .sort((a, b) => b.count - a.count);
}

async function getDebriefConfigRecord(scopeOwnerId) {
  if (!scopeOwnerId) return null;
  try {
    const { data } = await supabase
      .from('debrief_config')
      .select('id,sections,updated_by,updated_at')
      .eq('updated_by', scopeOwnerId)
      .order('updated_at', { ascending: false })
      .limit(250);
    const records = data || [];
    return records.find(record => isDebriefConfigSections(record?.sections)) || null;
  } catch {
    return null;
  }
}

async function getActiveDebriefConfigSections(scopeOwnerId) {
  const data = await getDebriefConfigRecord(scopeOwnerId);
  if (Array.isArray(data?.sections) && data.sections.length > 0) {
    return data.sections;
  }
  return DEFAULT_DEBRIEF_SECTION_CONFIG;
}

async function getPipelineConfigRecord(scopeOwnerId) {
  if (!scopeOwnerId) return null;
  try {
    const { data } = await supabase
      .from('debrief_config')
      .select('id,sections,updated_by,updated_at')
      .eq('updated_by', scopeOwnerId)
      .order('updated_at', { ascending: false })
      .limit(250);
    const records = data || [];
    return records.find(record => isPipelineConfigEnvelope(record?.sections)) || null;
  } catch {
    return null;
  }
}

async function getActivePipelineConfig(scopeOwnerId) {
  const record = await getPipelineConfigRecord(scopeOwnerId);
  const raw = record?.sections?.[0]?.data;
  if (raw && typeof raw === 'object') {
    return normalizePipelineConfig(raw);
  }
  return DEFAULT_PIPELINE_CONFIG;
}

async function getDebriefTemplateRecord(scopeOwnerId) {
  if (!scopeOwnerId) return null;
  try {
    const { data } = await supabase
      .from('debrief_config')
      .select('id,sections,updated_by,updated_at')
      .eq('updated_by', scopeOwnerId)
      .order('updated_at', { ascending: false })
      .limit(250);
    const records = data || [];
    return records.find(record => isDebriefTemplateEnvelope(record?.sections)) || null;
  } catch {
    return null;
  }
}

async function getActiveDebriefTemplateCatalog(scopeOwnerId) {
  const record = await getDebriefTemplateRecord(scopeOwnerId);
  const raw = record?.sections?.[0]?.data;
  if (raw && typeof raw === 'object') {
    return normalizeDebriefTemplateCatalog(raw);
  }
  return DEFAULT_DEBRIEF_TEMPLATE_CATALOG;
}

async function getAppSettingsRecord(userId) {
  if (!userId) return null;
  try {
    const { data } = await supabase
      .from('debrief_config')
      .select('id,sections,updated_by,updated_at')
      .eq('updated_by', userId)
      .order('updated_at', { ascending: false })
      .limit(250);
    const records = data || [];
    return records.find(record => isAppSettingsEnvelope(record?.sections)) || null;
  } catch {
    return null;
  }
}

async function getActiveAppSettings(userId) {
  const record = await getAppSettingsRecord(userId);
  const raw = record?.sections?.[0]?.data;
  if (raw && typeof raw === 'object') {
    return normalizeAppSettings(raw);
  }
  return DEFAULT_APP_SETTINGS;
}

// ─── AUTH (extracted to routes/auth.js) ─────────────────────────────────────
require('./routes/auth')(app, {
  authLimiter, authenticate, setAuthCookie,
  JWT_SECRET, JWT_EXPIRES_IN,
  emailService, buildGamification,
  attachEffectiveRole, recordSecurityAudit,
  validatePasswordPolicy,
  getLoginState, registerLoginFailure, clearLoginFailures,
});
require('./routes/debriefs')(app, { authenticate, requireHOS, requireAdmin, validateSections, canUserAccessOwnerData, buildGamification, invalidateGamCache, recordSecurityAudit, attachEffectiveRole, isAdminRole, isManagerRole, debriefQuality: require('./lib/debriefQuality'), FEATURE_DEBRIEF_QUALITY, FEATURE_MANAGER_COCKPIT });
// ─── GAMIFICATION ─────────────────────────────────────────────────────────────
app.get('/api/gamification/me', authenticate, async (req, res) => { res.json(await buildGamification(req.user.id)); });
app.get('/api/gamification/leaderboard', authenticate, async (req, res) => {
  const { data: users } = await supabase.from('users').select('id,name,role');
  const { data: allDebriefs } = await supabase.from('debriefs').select('percentage,is_closed,user_id');
  if (!users||!allDebriefs) return res.json([]);
  const board = users.filter(u => !isManagerRole(u.role)).map(u => {
    const ud = allDebriefs.filter(d=>d.user_id===u.id);
    const points = ud.reduce((s,d)=>s+computePoints(d),0);
    const avgScore = ud.length>0?Math.round(ud.reduce((s,d)=>s+(d.percentage||0),0)/ud.length):0;
    return { id:u.id, name:u.name, points, level:computeLevel(points), avgScore, totalDebriefs:ud.length, closed:ud.filter(d=>d.is_closed).length };
  }).sort((a,b)=>b.points-a.points);
  res.json(board);
});

// ─── OBJECTIVES ───────────────────────────────────────────────────────────────
function mapObjectiveAliases(obj) {
  if (!obj) return obj;
  return {
    ...obj,
    target_reecoutes: Number(obj.target_debriefs || 0),
    target_performance: Number(obj.target_score || 0),
  };
}

// GET mes objectifs (closer)
app.get('/api/objectives/me', authenticate, async (req, res) => {
  try {
    const now = new Date();
    // Objectif mensuel courant
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    // Objectif hebdo courant (lundi)
    const day = now.getDay() || 7;
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - day + 1);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const { data: objectives } = await supabase.from('objectives').select('*').eq('closer_id', req.user.id).in('period_start', [monthStart, weekStartStr]);

    // Debriefs de la période
    const { data: allDebriefs } = await supabase.from('debriefs').select('percentage,is_closed,call_date').eq('user_id', req.user.id);
    const { data: allDeals } = await supabase.from('deals').select('value,status').eq('user_id', req.user.id);

    const getProgress = (periodStart, periodType) => {
      const start = new Date(periodStart);
      const end   = periodType === 'monthly'
        ? new Date(start.getFullYear(), start.getMonth()+1, 0)
        : new Date(start.getTime() + 6*24*60*60*1000);
      const periodDebriefs = (allDebriefs||[]).filter(d => { const dt=new Date(d.call_date); return dt>=start&&dt<=end; });
      const periodDeals    = (allDeals||[]).filter(d => d.status==='signe');
      return {
        debriefs: periodDebriefs.length,
        reecoutes: periodDebriefs.length,
        closings: periodDebriefs.filter(d=>d.is_closed).length,
        score:    periodDebriefs.length>0 ? Math.round(periodDebriefs.reduce((s,d)=>s+(d.percentage||0),0)/periodDebriefs.length) : 0,
        performance: periodDebriefs.length>0 ? Math.round(periodDebriefs.reduce((s,d)=>s+(d.percentage||0),0)/periodDebriefs.length) : 0,
        revenue:  periodDeals.reduce((s,d)=>s+(d.value||0),0),
      };
    };

    const result = (objectives||[]).map(obj => mapObjectiveAliases({
      ...obj,
      progress: getProgress(obj.period_start, obj.period_type),
    }));
    res.json(result);
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

// GET objectifs d'un closer (HOS)
app.get('/api/objectives/closer/:closerId', authenticate, requireHOS, async (req, res) => {
  try {
    const allowed = await assertCloserManagedByHOS(req.user.id, req.params.closerId, req.user.role);
    if (!allowed) return res.status(403).json({ error:'Accès refusé' });
    const { data } = await supabase.from('objectives').select('*').eq('closer_id', req.params.closerId).order('period_start', { ascending:false });
    res.json((data || []).map(mapObjectiveAliases));
  } catch(err) { res.status(500).json({ error:'Erreur serveur' }); }
});

// POST créer/mettre à jour un objectif (HOS)
app.post('/api/objectives', authenticate, requireHOS, async (req, res) => {
  try {
    const {
      closer_id,
      period_type,
      period_start,
      target_debriefs,
      target_reecoutes,
      target_score,
      target_performance,
      target_closings,
      target_revenue,
    } = req.body;
    if (!closer_id||!period_type||!period_start) return res.status(400).json({ error:'Champs requis' });
    const allowed = await assertCloserManagedByHOS(req.user.id, closer_id, req.user.role);
    if (!allowed) return res.status(403).json({ error:'Accès refusé' });

    const normalizedTargets = {
      target_debriefs: Number(target_reecoutes ?? target_debriefs ?? 0) || 0,
      target_score: Number(target_performance ?? target_score ?? 0) || 0,
      target_closings: Number(target_closings || 0) || 0,
      target_revenue: Number(target_revenue || 0) || 0,
    };

    // Upsert sur (closer_id, period_type, period_start)
    const { data: existing } = await supabase.from('objectives').select('id').eq('closer_id', closer_id).eq('period_type', period_type).eq('period_start', period_start).single();
    let result;
    if (existing) {
      const { data } = await supabase
        .from('objectives')
        .update(normalizedTargets)
        .eq('id', existing.id)
        .select()
        .single();
      result = data;
    } else {
      const { data } = await supabase
        .from('objectives')
        .insert({
          closer_id,
          hos_id:req.user.id,
          period_type,
          period_start,
          ...normalizedTargets,
        })
        .select()
        .single();
      result = data;
    }
    res.json(mapObjectiveAliases(result));
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

// ─── ACTION PLANS ─────────────────────────────────────────────────────────────
app.get('/api/action-plans/me', authenticate, async (req, res) => {
  const { data } = await supabase.from('action_plans').select('*').eq('closer_id', req.user.id).order('created_at', { ascending:false });
  res.json(data || []);
});

app.get('/api/action-plans/closer/:closerId', authenticate, requireHOS, async (req, res) => {
  const allowed = await assertCloserManagedByHOS(req.user.id, req.params.closerId, req.user.role);
  if (!allowed) return res.status(403).json({ error:'Accès refusé' });
  const { data } = await supabase.from('action_plans').select('*').eq('closer_id', req.params.closerId).order('created_at', { ascending:false });
  res.json(data || []);
});

app.post('/api/action-plans', authenticate, requireHOS, async (req, res) => {
  const { closer_id, axis, description } = req.body;
  if (!closer_id||!axis) return res.status(400).json({ error:'Champs requis' });
  const allowed = await assertCloserManagedByHOS(req.user.id, closer_id, req.user.role);
  if (!allowed) return res.status(403).json({ error:'Accès refusé' });
  // Max 3 plans actifs par closer
  const { data: active } = await supabase.from('action_plans').select('id').eq('closer_id', closer_id).eq('status', 'active');
  if ((active||[]).length >= 3) return res.status(400).json({ error:'Maximum 3 axes actifs par closer' });
  const { data, error } = await supabase.from('action_plans').insert({ closer_id, hos_id:req.user.id, axis, description, status:'active' }).select().single();
  if (error) return res.status(500).json({ error:'Erreur création' });
  res.status(201).json(data);
});

app.patch('/api/action-plans/:id', authenticate, async (req, res) => {
  const { data: existing } = await supabase
    .from('action_plans')
    .select('id,closer_id,hos_id')
    .eq('id', req.params.id)
    .single();
  if (!existing) return res.status(404).json({ error:'Plan introuvable' });

  if (req.user.role === 'closer') {
    if (existing.closer_id !== req.user.id) return res.status(403).json({ error:'Accès refusé' });
  } else if (isManagerRole(req.user.role)) {
    if (isAdminRole(req.user.role)) {
      // accès total admin
    } else {
      const isOwner = existing.hos_id === req.user.id;
      const managesCloser = await assertCloserManagedByHOS(req.user.id, existing.closer_id, req.user.role);
      if (!isOwner && !managesCloser) return res.status(403).json({ error:'Accès refusé' });
    }
  } else {
    return res.status(403).json({ error:'Accès refusé' });
  }

  const { status, description } = req.body;
  const update = {};
  if (status) { update.status = status; if (status==='resolved') update.resolved_at = new Date().toISOString(); }
  if (description !== undefined) update.description = description;
  const { data, error } = await supabase.from('action_plans').update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error:'Erreur mise à jour' });
  res.json(data);
});

app.delete('/api/action-plans/:id', authenticate, requireHOS, async (req, res) => {
  const { data: existing } = await supabase
    .from('action_plans')
    .select('id,closer_id,hos_id')
    .eq('id', req.params.id)
    .single();
  if (!existing) return res.status(404).json({ error:'Plan introuvable' });
  if (!isAdminRole(req.user.role)) {
    const isOwner = existing.hos_id === req.user.id;
    const managesCloser = await assertCloserManagedByHOS(req.user.id, existing.closer_id, req.user.role);
    if (!isOwner && !managesCloser) return res.status(403).json({ error:'Accès refusé' });
  }
  await supabase.from('action_plans').delete().eq('id', req.params.id);
  res.json({ success:true });
});

// ─── DEALS / PIPELINE ─────────────────────────────────────────────────────────
app.get('/api/deals', authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    if (isAdminRole(req.user.role)) {
      const { data, error, count } = await supabase.from('deals').select('*', { count: 'exact' }).order('updated_at', { ascending:false }).range(offset, offset + limit - 1);
      if (error) return res.status(500).json({ error:'Erreur récupération' });
      return res.json({ data: (data || []).map(mapDealForClient), meta: { total: count || 0, page, pages: Math.ceil((count || 0) / limit), limit } });
    }
    let ids = [req.user.id];
    if (normalizeRole(req.user.role) === 'head_of_sales') {
      const memberIds = await getHOSTeamMemberIds(req.user.id);
      ids = [...new Set([req.user.id, ...memberIds])];
    }
    const { data, error, count } = await supabase.from('deals').select('*', { count: 'exact' }).in('user_id', ids).order('updated_at', { ascending:false }).range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error:'Erreur récupération' });
    res.json({ data: (data || []).map(mapDealForClient), meta: { total: count || 0, page, pages: Math.ceil((count || 0) / limit), limit } });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.post('/api/deals', authenticate, async (req, res) => {
  const payload = req.body || {};
  const prospect_name = inferProspectName(payload);
  if (!prospect_name) return res.status(400).json({ error:'Nom du prospect requis' });

  const contactMeta = normalizeContactMeta(payload, payload.status);
  const pipelineContext = await getPipelineStatusContextForUser(req.user);
  const status = typeof payload.status === 'string' && payload.status.trim()
    ? payload.status.trim()
    : (contactMeta.deal_closed ? pipelineContext.wonKey : pipelineContext.openKey);
  const note = payload.note ?? payload.notes ?? '';
  const source = sanitizeContactText(payload.source, 120);
  const value = Number(payload.value || 0) || 0;
  const follow_up_date = sanitizeContactDate(payload.contact_date || payload.follow_up_date) || null;
  const notes = buildDealNotes(contactMeta, note);

  const { data, error } = await supabase
    .from('deals')
    .insert({
      user_id: req.user.id,
      user_name: req.user.name,
      prospect_name,
      source,
      value,
      status: status || 'prospect',
      follow_up_date,
      notes,
      debrief_id: payload.debrief_id || null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error:'Erreur création' });
  res.status(201).json(mapDealForClient(data));
});

app.patch('/api/deals/:id', authenticate, async (req, res) => {
  try {
    const { data: deal } = await supabase.from('deals').select('*').eq('id', req.params.id).single();
    if (!deal) return res.status(404).json({ error:'Deal introuvable' });
    const canAccess = await canUserAccessOwnerData(req.user, deal.user_id);
    if (!canAccess) return res.status(403).json({ error:'Accès refusé' });
    const pipelineContext = await getPipelineStatusContextForOwnerId(deal.user_id);

    const payload = req.body || {};
    const previous = parseDealNotes(deal.notes);
    const previousMeta = previous.meta || {};
    const nextMeta = normalizeContactMeta({
      first_name: payload.first_name ?? previousMeta.first_name,
      last_name: payload.last_name ?? previousMeta.last_name,
      email: payload.email ?? previousMeta.email,
      phone: payload.phone ?? previousMeta.phone,
      contact_date: payload.contact_date ?? payload.follow_up_date ?? previousMeta.contact_date ?? deal.follow_up_date,
      deal_closed: payload.deal_closed ?? previousMeta.deal_closed,
    }, payload.status || deal.status);

    const prospect_name = inferProspectName(payload, `${nextMeta.first_name || ''} ${nextMeta.last_name || ''}`.trim() || deal.prospect_name);
    const explicitStatus = typeof payload.status === 'string' && payload.status.trim() ? payload.status.trim() : '';
    const currentStatus = typeof deal.status === 'string' ? deal.status : '';
    const currentIsClosed = pipelineContext.closedKeys.has(currentStatus);
    const status = explicitStatus || (typeof nextMeta.deal_closed === 'boolean'
      ? (nextMeta.deal_closed
        ? pipelineContext.wonKey
        : (currentIsClosed ? pipelineContext.openKey : (currentStatus || pipelineContext.openKey)))
      : (currentStatus || pipelineContext.openKey));
    const note = payload.note ?? payload.notes ?? previous.note ?? '';
    const follow_up_date = sanitizeContactDate(payload.contact_date || payload.follow_up_date || nextMeta.contact_date || deal.follow_up_date) || null;

    const updateData = {
      prospect_name,
      source: payload.source !== undefined ? sanitizeContactText(payload.source, 120) : deal.source,
      value: payload.value !== undefined ? Number(payload.value || 0) || 0 : (Number(deal.value || 0) || 0),
      status,
      follow_up_date,
      notes: buildDealNotes(nextMeta, note),
      updated_at: new Date().toISOString(),
    };
    if (payload.debrief_id !== undefined) {
      updateData.debrief_id = payload.debrief_id || null;
    }

    const { data, error } = await supabase
      .from('deals')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error:'Erreur mise à jour' });
    res.json(mapDealForClient(data));
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.delete('/api/deals/:id', authenticate, async (req, res) => {
  try {
    const { data: deal } = await supabase.from('deals').select('id,user_id,user_name').eq('id', req.params.id).single();
    if (!deal) return res.status(404).json({ error:'Deal introuvable' });
    const canAccess = await canUserAccessOwnerData(req.user, deal.user_id);
    if (!canAccess) return res.status(403).json({ error:'Accès refusé' });
    const { error: deleteError } = await supabase
      .from('deals')
      .delete()
      .eq('id', req.params.id);
    if (deleteError) {
      const detail = deleteError?.message || 'Suppression impossible';
      return res.status(500).json({ error:'Erreur suppression', detail });
    }
    res.json({ success:true, deleted: 1 });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.post('/api/deals/purge-profile', authenticate, requireAdmin, async (req, res) => {
  try {
    const rawUserId = String(req.body?.user_id || '').trim();
    const rawUserName = String(req.body?.user_name || '').trim();
    const rawCleanupScope = String(req.body?.cleanup_scope || '').trim().toLowerCase();
    const rawProfileKey = String(req.body?.profile_key || '').trim().toLowerCase();
    const hasLegacyRequest = rawCleanupScope === 'legacy';

    const rowsByOwner = [];
    if (rawUserId) {
      const { data, error } = await supabase
        .from('deals')
        .select('id,user_id,user_name,source')
        .eq('user_id', rawUserId);
      if (error) return res.status(500).json({ error:'Erreur récupération', detail:error.message || '' });
      rowsByOwner.push(...(data || []));
    }

    const rowsByName = [];
    if (!rawUserId && rawUserName) {
      const { data, error } = await supabase
        .from('deals')
        .select('id,user_id,user_name,source')
        .eq('user_name', rawUserName);
      if (error) return res.status(500).json({ error:'Erreur récupération', detail:error.message || '' });
      rowsByName.push(...(data || []));
    }

    const rowsByLegacy = [];
    if (hasLegacyRequest || rawProfileKey.includes('zapier') || rawProfileKey.includes('test')) {
      const [
        sourceLegacy,
        sourceZapier,
        userZapier,
        userTest,
      ] = await Promise.all([
        supabase.from('deals').select('id,user_id,user_name,source').ilike('source', '%iclosed%'),
        supabase.from('deals').select('id,user_id,user_name,source').ilike('source', '%zapier%'),
        supabase.from('deals').select('id,user_id,user_name,source').ilike('user_name', '%zapier%'),
        supabase.from('deals').select('id,user_id,user_name,source').ilike('user_name', '%test%'),
      ]);
      const errors = [
        sourceLegacy.error,
        sourceZapier.error,
        userZapier.error,
        userTest.error,
      ].filter(Boolean);
      if (errors.length > 0) {
        return res.status(500).json({ error:'Erreur récupération', detail:errors[0].message || '' });
      }
      rowsByLegacy.push(
        ...(sourceLegacy.data || []),
        ...(sourceZapier.data || []),
        ...(userZapier.data || []),
        ...(userTest.data || []),
      );
    }

    const candidates = [...rowsByOwner, ...rowsByName, ...rowsByLegacy];
    const uniqueIds = [...new Set(candidates.map(row => row.id).filter(Boolean))];
    if (uniqueIds.length === 0) return res.json({ success:true, deleted:0, matched:0 });

    const { error: deleteError } = await supabase
        .from('deals')
        .delete()
        .in('id', uniqueIds);
    if (deleteError) {
      return res.status(500).json({ error:'Erreur suppression', detail:deleteError.message || '' });
    }

    const deleted = uniqueIds.length;
    await recordSecurityAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'pipeline_profile_purge',
      req,
      details: {
        profile_key: rawProfileKey || null,
        user_id: rawUserId || null,
        user_name: rawUserName || null,
        cleanup_scope: hasLegacyRequest ? 'legacy' : null,
        matched: uniqueIds.length,
        deleted,
      },
    });

    return res.json({ success:true, matched: uniqueIds.length, deleted });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error:'Erreur serveur' });
  }
});

// ─── TEAMS (extracted to routes/teams.js) ───────────────────────────────────
require('./routes/teams')(app, { authenticate, requireHOS, requireAdmin, assertTeamOwner, recordSecurityAudit });
// ─── DEBRIEF CONFIG ───────────────────────────────────────────────────────────
// GET  /api/debrief-config         — retourne la config active (ou défaut)
// PUT  /api/debrief-config         — sauvegarde (HOS seulement)
// DELETE /api/debrief-config       — reset au défaut (HOS seulement)

app.get('/api/debrief-config', authenticate, async (req, res) => {
  try {
    const scopeOwnerId = await getDebriefConfigScopeOwnerId(req.user);
    const data = await getDebriefConfigRecord(scopeOwnerId);
    if (Array.isArray(data?.sections) && data.sections.length > 0) return res.json({ sections: data.sections });
    res.json({ sections: null }); // null = utiliser le défaut côté frontend
  } catch { res.json({ sections: null }); }
});

app.put('/api/debrief-config', authenticate, requireHOS, async (req, res) => {
  const { sections } = req.body;
  if (!sections || !Array.isArray(sections)) return res.status(400).json({ error: 'sections requises' });
  try {
    const existing = await getDebriefConfigRecord(req.user.id);
    if (existing) {
      await supabase
        .from('debrief_config')
        .update({ sections, updated_at: new Date().toISOString(), updated_by: req.user.id })
        .eq('id', existing.id);
    } else {
      await supabase.from('debrief_config').insert({ sections, updated_by: req.user.id });
    }
    await recordSecurityAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'debrief_config_update',
      req,
      details: { sections_count: sections.length },
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/debrief-config', authenticate, requireHOS, async (req, res) => {
  try {
    const { data } = await supabase
      .from('debrief_config')
      .select('id,sections')
      .eq('updated_by', req.user.id);
    const ids = (data || [])
      .filter(record => isDebriefConfigSections(record.sections))
      .map(record => record.id);
    if (ids.length > 0) {
      await supabase.from('debrief_config').delete().in('id', ids);
    }
    await recordSecurityAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'debrief_config_reset',
      req,
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PIPELINE CONFIG ─────────────────────────────────────────────────────────
// GET  /api/pipeline-config  — retourne la config pipeline active (scope équipe)
// PUT  /api/pipeline-config  — sauvegarde la config (HOS uniquement)
app.get('/api/pipeline-config', authenticate, async (req, res) => {
  try {
    const scopeOwnerId = await getDebriefConfigScopeOwnerId(req.user);
    const config = await getActivePipelineConfig(scopeOwnerId);
    res.json(config);
  } catch (e) {
    res.json(DEFAULT_PIPELINE_CONFIG);
  }
});

app.put('/api/pipeline-config', authenticate, requireHOS, async (req, res) => {
  try {
    const config = normalizePipelineConfig(req.body || {});
    const envelope = [{ key: PIPELINE_CONFIG_MARKER, data: config }];
    const existing = await getPipelineConfigRecord(req.user.id);
    if (existing) {
      await supabase
        .from('debrief_config')
        .update({ sections: envelope, updated_at: new Date().toISOString(), updated_by: req.user.id })
        .eq('id', existing.id);
    } else {
      await supabase.from('debrief_config').insert({ sections: envelope, updated_by: req.user.id });
    }
    await recordSecurityAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'pipeline_config_update',
      req,
      details: { statuses_count: config.statuses?.length || 0 },
    });
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DEBRIEF TEMPLATES ──────────────────────────────────────────────────────
// GET    /api/debrief-templates  — catalogue actif (scope équipe)
// PUT    /api/debrief-templates  — sauvegarde catalogue (HOS uniquement)
// DELETE /api/debrief-templates  — reset catalogue (HOS uniquement)
app.get('/api/debrief-templates', authenticate, async (req, res) => {
  try {
    const scopeOwnerId = await getDebriefConfigScopeOwnerId(req.user);
    const catalog = await getActiveDebriefTemplateCatalog(scopeOwnerId);
    res.json(catalog);
  } catch (e) {
    res.json(DEFAULT_DEBRIEF_TEMPLATE_CATALOG);
  }
});

app.put('/api/debrief-templates', authenticate, requireHOS, async (req, res) => {
  try {
    const catalog = normalizeDebriefTemplateCatalog(req.body || {});
    const envelope = [{ key: DEBRIEF_TEMPLATE_CONFIG_MARKER, data: catalog }];
    const existing = await getDebriefTemplateRecord(req.user.id);
    if (existing) {
      await supabase
        .from('debrief_config')
        .update({ sections: envelope, updated_at: new Date().toISOString(), updated_by: req.user.id })
        .eq('id', existing.id);
    } else {
      await supabase.from('debrief_config').insert({ sections: envelope, updated_by: req.user.id });
    }
    await recordSecurityAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'debrief_templates_update',
      req,
      details: { templates_count: catalog.templates?.length || 0, default_template: catalog.defaultTemplateKey || null },
    });
    res.json(catalog);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/debrief-templates', authenticate, requireHOS, async (req, res) => {
  try {
    const { data } = await supabase
      .from('debrief_config')
      .select('id,sections')
      .eq('updated_by', req.user.id);
    const ids = (data || [])
      .filter(record => isDebriefTemplateEnvelope(record.sections))
      .map(record => record.id);
    if (ids.length > 0) {
      await supabase.from('debrief_config').delete().in('id', ids);
    }
    await recordSecurityAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'debrief_templates_reset',
      req,
    });
    res.json(DEFAULT_DEBRIEF_TEMPLATE_CATALOG);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── APP SETTINGS (UTILISATEUR) ────────────────────────────────────────────
// GET    /api/app-settings  — préférences utilisateur
// PUT    /api/app-settings  — sauvegarde préférences utilisateur
// DELETE /api/app-settings  — reset préférences utilisateur
app.get('/api/app-settings', authenticate, async (req, res) => {
  try {
    const settings = await getActiveAppSettings(req.user.id);
    res.json(settings);
  } catch (e) {
    res.json(DEFAULT_APP_SETTINGS);
  }
});

app.put('/api/app-settings', authenticate, async (req, res) => {
  try {
    const payload = req.body?.settings && typeof req.body.settings === 'object'
      ? req.body.settings
      : req.body;
    const settings = normalizeAppSettings(payload || {});
    const envelope = [{ key: APP_SETTINGS_CONFIG_MARKER, data: settings }];
    const existing = await getAppSettingsRecord(req.user.id);
    if (existing) {
      await supabase
        .from('debrief_config')
        .update({ sections: envelope, updated_at: new Date().toISOString(), updated_by: req.user.id })
        .eq('id', existing.id);
    } else {
      await supabase.from('debrief_config').insert({ sections: envelope, updated_by: req.user.id });
    }
    await recordSecurityAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'app_settings_update',
      req,
      details: { theme: settings.theme, auto_ai_after_debrief: settings.autoAiAfterDebrief },
    });
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/app-settings', authenticate, async (req, res) => {
  try {
    const { data } = await supabase
      .from('debrief_config')
      .select('id,sections')
      .eq('updated_by', req.user.id);
    const ids = (data || [])
      .filter(record => isAppSettingsEnvelope(record.sections))
      .map(record => record.id);
    if (ids.length > 0) {
      await supabase.from('debrief_config').delete().in('id', ids);
    }
    await recordSecurityAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'app_settings_reset',
      req,
    });
    res.json(DEFAULT_APP_SETTINGS);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SECURITY CENTER ────────────────────────────────────────────────────────
app.get('/api/security/posture', authenticate, requireAdmin, async (req, res) => {
  res.json({
    trust_level: 'reinforced',
    protections: {
      helmet: true,
      cors_restricted: true,
      auth_rate_limit_max: AUTH_RATE_LIMIT_MAX,
      ai_rate_limit_max: AI_RATE_LIMIT_MAX,
      api_rate_limit_max: API_RATE_LIMIT_MAX,
      body_limit: BODY_LIMIT,
      brute_force_lock: {
        threshold: LOGIN_LOCK_MAX_ATTEMPTS,
        window_minutes: Math.round(LOGIN_LOCK_WINDOW_MS / 60000),
        lock_minutes: Math.round(LOGIN_LOCK_DURATION_MS / 60000),
      },
    },
    password_policy: {
      min_length: PASSWORD_MIN_LENGTH,
      required_families: 3,
      families: ['minuscule', 'majuscule', 'chiffre', 'symbole'],
      blocked_patterns: ['password', 'motdepasse', '123456', 'qwerty', 'azerty'],
    },
    auth: {
      jwt_expiration: JWT_EXPIRES_IN,
      session_storage: 'jwt_bearer',
    },
    audit: {
      enabled: true,
      endpoint: '/api/security/audit',
    },
  });
});

app.get('/api/security/audit', authenticate, requireAdmin, async (req, res) => {
  try {
    const rawLimit = Number(req.query?.limit || 50);
    const limit = Number.isFinite(rawLimit) ? Math.max(10, Math.min(rawLimit, 200)) : 50;
    const requestedScope = String(req.query?.scope || 'all').toLowerCase();
    const scope = requestedScope === 'own' ? 'own' : 'all';
    const actorIds = scope === 'own' ? [req.user.id] : [];

    let query = supabase
      .from('debrief_config')
      .select('id,sections,updated_by,updated_at')
      .order('updated_at', { ascending: false })
      .limit(limit * 10);

    if (scope === 'own') {
      const validIds = actorIds.filter(id => UUID_V4_REGEX.test(String(id || '')));
      if (validIds.length === 0) {
        return res.json({ scope, total: 0, events: [] });
      }
      query = query.in('updated_by', validIds);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Security audit query error:', error?.message || error);
      return res.json({ scope, total: 0, events: [], warning: 'AUDIT_QUERY_FAILED' });
    }

    const events = (data || [])
      .filter(record => isSecurityAuditEnvelope(record.sections))
      .filter(record => scope === 'all' || actorIds.includes(record.updated_by))
      .map(record => {
        const payload = record.sections?.[0]?.data || {};
        return {
          id: record.id,
          action: payload.action || 'unknown',
          outcome: payload.outcome || 'success',
          actor_id: payload.actor_id || record.updated_by,
          actor_role: payload.actor_role || 'unknown',
          request_id: payload.request_id || null,
          ip: payload.ip || null,
          user_agent: payload.user_agent || null,
          details: payload.details || {},
          created_at: payload.created_at || record.updated_at,
        };
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);

    return res.json({
      scope,
      total: events.length,
      events,
    });
  } catch (err) {
    console.error('Security audit error:', err);
    return res.json({ scope: 'all', total: 0, events: [], warning: 'AUDIT_RUNTIME_ERROR' });
  }
});
// ─── OBJECTION LIBRARY ───────────────────────────────────────────────────────
app.get('/api/objections', authenticate, async (req, res) => {
  try {
    if (isAdminRole(req.user.role)) {
      const { data: debriefs, error } = await supabase
        .from('debriefs')
        .select('id, user_id, user_name, prospect_name, call_date, is_closed, percentage, sections, section_notes, notes')
        .order('call_date', { ascending: false });
      if (error) return res.status(500).json({ error: 'Erreur récupération' });
      return res.json(buildObjectionResponse(debriefs || []));
    }
    let ids = [req.user.id];
    if (normalizeRole(req.user.role) === 'head_of_sales') {
      const memberIds = await getHOSTeamMemberIds(req.user.id);
      ids = [...new Set([req.user.id, ...memberIds])];
    }
    const { data: debriefs, error } = await supabase
      .from('debriefs')
      .select('id, user_id, user_name, prospect_name, call_date, is_closed, percentage, sections, section_notes, notes')
      .in('user_id', ids)
      .order('call_date', { ascending: false });
    if (error) return res.status(500).json({ error: 'Erreur récupération' });
    res.json(buildObjectionResponse(debriefs || []));
  } catch (err) { console.error('Objections error:', err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ─── PATTERNS ────────────────────────────────────────────────────────────────
app.get('/api/patterns', authenticate, async (req, res) => {
  try {
    let ids = [req.user.id];
    let scope = 'personal';
    const targetCloserId = String(req.query?.closer_id || '').trim();

    if (isAdminRole(req.user.role)) {
      if (targetCloserId) {
        ids = [targetCloserId];
        scope = 'closer';
      } else {
        const { data: users } = await supabase.from('users').select('id,role');
        ids = (users || [])
          .filter(user => normalizeRole(user.role) === 'closer')
          .map(user => user.id);
        scope = 'team';
      }
    } else if (normalizeRole(req.user.role) === 'head_of_sales') {
      if (targetCloserId) {
        const allowed = await assertCloserManagedByHOS(req.user.id, targetCloserId, req.user.role);
        if (!allowed) return res.status(403).json({ error: 'Accès refusé' });
        ids = [targetCloserId];
        scope = 'closer';
      } else {
        const memberIds = await getHOSTeamMemberIds(req.user.id);
        ids = [...new Set(memberIds)];
        scope = 'team';
      }
    }

    if (ids.length === 0) {
      return res.json({ scope, totalDebriefs: 0, totalLost: 0, patterns: [], byCloser: [] });
    }

    const { data: debriefs, error } = await supabase
      .from('debriefs')
      .select('id,user_id,user_name,prospect_name,call_date,is_closed,percentage,sections')
      .in('user_id', ids)
      .order('call_date', { ascending: false })
      .limit(1200);
    if (error) return res.status(500).json({ error: 'Erreur récupération patterns' });

    const list = debriefs || [];
    const patterns = computePatternInsights(list);
    const totalLost = list.filter(d => !d.is_closed).length;

    let byCloser = [];
    if (scope === 'team') {
      const grouped = {};
      for (const d of list) {
        if (!grouped[d.user_id]) grouped[d.user_id] = [];
        grouped[d.user_id].push(d);
      }
      byCloser = Object.entries(grouped)
        .map(([closerId, closerDebriefs]) => {
          const closerPatterns = computePatternInsights(closerDebriefs).slice(0, 2);
          return {
            closer_id: closerId,
            closer_name: closerDebriefs[0]?.user_name || 'Closer',
            totalDebriefs: closerDebriefs.length,
            totalLost: closerDebriefs.filter(d => !d.is_closed).length,
            topPatterns: closerPatterns,
          };
        })
        .sort((a, b) => b.totalDebriefs - a.totalDebriefs);
    }

    return res.json({
      scope,
      totalDebriefs: list.length,
      totalLost,
      patterns,
      byCloser,
    });
  } catch (err) {
    console.error('Patterns error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
// ─── AI ANALYSIS (extracted to routes/ai.js) ────────────────────────────────
require('./routes/ai')(app, { authenticate, requireHOS, aiLimiter, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_FALLBACK_MODELS });

// ─── HEALTH ───────────────────────────────────────────────────────────────────
// ─── DEBRIEF QUALITY: REVIEW ENDPOINTS ───────────────────────────────────────
app.post('/api/debriefs/:id/review', authenticate, requireHOS, async (req, res) => {
  try {
    if (!FEATURE_DEBRIEF_QUALITY) return res.status(404).json({ error:'Feature désactivée' });
    const { status, review_note } = req.body || {};
    if (!['validated', 'corrected', 'rejected'].includes(status)) {
      return res.status(400).json({ error:'status invalide' });
    }
    const { data: debrief } = await supabase.from('debriefs').select('id,user_id,quality_flags').eq('id', req.params.id).single();
    if (!debrief) return res.status(404).json({ error:'Debrief introuvable' });
    const canAccess = await canUserAccessOwnerData(req.user, debrief.user_id);
    if (!canAccess) return res.status(403).json({ error:'Accès refusé' });

    const note = typeof review_note === 'string' ? review_note.slice(0, 2000) : null;
    const { data: review, error: revErr } = await supabase
      .from('debrief_reviews')
      .insert({ debrief_id: debrief.id, reviewer_id: req.user.id, status, review_note: note })
      .select()
      .single();
    if (revErr) return res.status(500).json({ error:'Erreur création review', detail: revErr.message || '' });

    const flags = Array.isArray(debrief.quality_flags) ? [...debrief.quality_flags] : [];
    if (status === 'corrected' && !flags.includes('manager_corrected')) flags.push('manager_corrected');

    await supabase.from('debriefs').update({
      validation_status: status,
      validated_at: new Date().toISOString(),
      validated_by: req.user.id,
      quality_flags: flags,
    }).eq('id', debrief.id);

    logEvent('debrief_reviewed', { debrief_id: debrief.id, reviewer_id: req.user.id, status });
    res.status(201).json({ review });
  } catch (err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.get('/api/manager/review-queue', authenticate, requireHOS, async (req, res) => {
  try {
    if (!FEATURE_DEBRIEF_QUALITY) return res.json([]);
    let scopeIds = null;
    if (!isAdminRole(req.user.role)) {
      const memberIds = await getHOSTeamMemberIds(req.user.id);
      scopeIds = [...new Set([req.user.id, ...memberIds])];
    }
    let query = supabase
      .from('debriefs')
      .select('id,user_id,user_name,prospect_name,call_date,submitted_at,overall_quality_score,quality_flags,validation_status')
      .eq('validation_status', 'pending')
      .order('overall_quality_score', { ascending: true })
      .limit(50);
    if (scopeIds) query = query.in('user_id', scopeIds);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error:'Erreur récupération' });
    const items = (data || []).filter(d =>
      (typeof d.overall_quality_score === 'number' && d.overall_quality_score < 70) ||
      (Array.isArray(d.quality_flags) && d.quality_flags.length > 0)
    );
    res.json(items);
  } catch (err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

// ─── MANAGER COCKPIT: DECISION FEED v1 (déterministe) ────────────────────────
app.get('/api/manager/decision-feed', authenticate, requireHOS, async (req, res) => {
  try {
    if (!FEATURE_MANAGER_COCKPIT) return res.status(404).json({ error:'Feature désactivée' });
    let scopeIds;
    if (isAdminRole(req.user.role)) {
      const { data: users } = await supabase.from('users').select('id,name');
      scopeIds = (users || []).map(u => u.id);
    } else {
      const memberIds = await getHOSTeamMemberIds(req.user.id);
      scopeIds = [...new Set([req.user.id, ...memberIds])];
    }
    if (!scopeIds.length) return res.json({ coach_queue: [], drop_alerts: [], skill_gaps: [], one_on_one_briefs: [] });

    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { data: debriefs } = await supabase
      .from('debriefs')
      .select('id,user_id,user_name,call_date,percentage,scores,overall_quality_score,quality_flags')
      .in('user_id', scopeIds)
      .gte('call_date', since)
      .order('call_date', { ascending: false });

    const byCloser = new Map();
    for (const d of debriefs || []) {
      if (!byCloser.has(d.user_id)) byCloser.set(d.user_id, { user_id: d.user_id, user_name: d.user_name, items: [] });
      byCloser.get(d.user_id).items.push(d);
    }

    const SKILL_KEYS = ['decouverte', 'reformulation', 'projection', 'presentation_offre', 'closing'];
    const teamAvgPct = (() => {
      const all = (debriefs || []).map(d => d.percentage || 0).filter(Boolean);
      return all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
    })();

    const coach_queue = [];
    const drop_alerts = [];
    const skill_gaps = [];
    const one_on_one_briefs = [];

    for (const closer of byCloser.values()) {
      const items = closer.items;
      if (items.length === 0) continue;
      const avg = items.reduce((s, d) => s + (d.percentage || 0), 0) / items.length;
      const recent = items.slice(0, 3);
      const older = items.slice(3, 8);
      const recentAvg = recent.reduce((s, d) => s + (d.percentage || 0), 0) / recent.length;
      const olderAvg = older.length ? older.reduce((s, d) => s + (d.percentage || 0), 0) / older.length : recentAvg;
      const dataConfidence = items.length >= 5 ? 'high' : items.length >= 2 ? 'medium' : 'low';

      const reasons = [];
      let priority = 0;
      if (avg < teamAvgPct - 10) { priority += 30; reasons.push(`moyenne ${Math.round(avg)}% < équipe ${Math.round(teamAvgPct)}%`); }
      if (recentAvg < olderAvg - 10) { priority += 25; reasons.push(`baisse récente: ${Math.round(olderAvg)}% → ${Math.round(recentAvg)}%`); }
      const lowQuality = items.filter(d => (d.overall_quality_score || 100) < 60).length;
      if (lowQuality >= 2) { priority += 15; reasons.push(`${lowQuality} debriefs à faible qualité`); }
      if (items.length < 3) { priority += 10; reasons.push('peu de debriefs (fraîcheur faible)'); }

      const skillAverages = {};
      for (const k of SKILL_KEYS) {
        const vals = items.map(d => d.scores?.[k]).filter(v => typeof v === 'number');
        if (vals.length) skillAverages[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
      const weakest = Object.entries(skillAverages).sort((a, b) => a[1] - b[1])[0];
      if (weakest && weakest[1] < 3) {
        priority += 10;
        reasons.push(`${weakest[0]} faible (${weakest[1].toFixed(1)}/5)`);
        skill_gaps.push({ user_id: closer.user_id, user_name: closer.user_name, skill: weakest[0], score: Number(weakest[1].toFixed(1)) });
      }

      if (priority > 0) {
        coach_queue.push({
          user_id: closer.user_id,
          user_name: closer.user_name,
          priority_score: priority,
          avg_percentage: Math.round(avg),
          recent_avg: Math.round(recentAvg),
          debriefs_count: items.length,
          data_confidence: dataConfidence,
          reasons,
        });
      }
      if (recentAvg < olderAvg - 15 && older.length >= 2) {
        drop_alerts.push({
          user_id: closer.user_id,
          user_name: closer.user_name,
          delta: Math.round(recentAvg - olderAvg),
          data_confidence: dataConfidence,
        });
      }
      one_on_one_briefs.push({
        user_id: closer.user_id,
        user_name: closer.user_name,
        avg_percentage: Math.round(avg),
        weakest_skill: weakest ? weakest[0] : null,
        debriefs_count: items.length,
        last_call: items[0]?.call_date || null,
      });
    }

    coach_queue.sort((a, b) => b.priority_score - a.priority_score);
    drop_alerts.sort((a, b) => a.delta - b.delta);
    skill_gaps.sort((a, b) => a.score - b.score);

    logEvent('manager_cockpit_opened', { user_id: req.user.id, scope_size: scopeIds.length });
    res.json({ coach_queue, drop_alerts, skill_gaps, one_on_one_briefs });
  } catch (err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});


function setAuthCookie(res, token) {
  const IS_PROD = process.env.NODE_ENV === 'production';
  res.cookie('cd_token', token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  });
}
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('cd_token', { path: '/' });
  res.json({ ok: true });
});


// ─── CALENDLY WEBHOOK ────────────────────────────────────────────────────────
// Verify Calendly HMAC-SHA256 signature then create a lead in the pipeline.
// Ref: https://developer.calendly.com/api-docs/87c367837296c-webhook-signatures
app.post('/api/webhooks/calendly', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    // 1 — Signature verification (read from env at request time for testability)
    const signingKey = process.env.CALENDLY_SIGNING_KEY || '';
    if (signingKey) {
      const signatureHeader = req.headers['calendly-webhook-signature'] || '';
      const parts = Object.fromEntries(signatureHeader.split(',').map(p => p.split('=')));
      const t = parts.t || '';
      const v1 = parts.v1 || '';
      if (!t || !v1) return res.status(400).json({ error: 'Missing signature headers' });
      const rawBodyStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || '{}');
      const expected = crypto.createHmac('sha256', signingKey).update(t + '.' + rawBodyStr).digest('hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      const receivedBuf = Buffer.from(v1.length === 64 ? v1 : '0'.repeat(64), 'hex');
      if (!crypto.timingSafeEqual(receivedBuf, expectedBuf) || v1.length !== 64) {
        return res.status(403).json({ error: 'Invalid signature' });
      }
    }

    // 2 — Parse payload (handle both raw Buffer and pre-parsed JSON from express.json())
    let payload;
    if (Buffer.isBuffer(req.body)) {
      payload = JSON.parse(req.body.toString('utf8'));
    } else if (req.body && typeof req.body === 'object') {
      payload = req.body; // already parsed by express.json()
    } else {
      payload = JSON.parse(String(req.body || '{}'));
    }
    if (payload.event !== 'invitee.created') return res.status(200).json({ ok: true }); // ignore other events

    const invitee  = payload.payload?.invitee || {};
    const event    = payload.payload?.scheduled_event || payload.payload?.event || {};
    const memberships = event.event_memberships || [];

    const inviteeName  = invitee.name  || 'Inconnu';
    const inviteeEmail = invitee.email || '';
    const startTime    = event.start_time || null;

    // 3 — Find organizer user in DB (match by email)
    const organizerEmail = memberships[0]?.user_email || '';
    let ownerUser = null;
    if (organizerEmail) {
      const { data } = await supabase.from('users').select('id,role').eq('email', organizerEmail).single();
      ownerUser = data;
    }
    if (!ownerUser) return res.status(200).json({ ok: true, note: 'organizer not found in DB' });

    // 4 — Create lead in pipeline
    const note = [
      inviteeEmail ? `Email : ${inviteeEmail}` : '',
      startTime    ? `RDV : ${new Date(startTime).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}` : '',
      payload.payload?.event_type?.name ? `Type : ${payload.payload.event_type.name}` : '',
    ].filter(Boolean).join('\n');

    await supabase.from('deals').insert({
      user_id:      ownerUser.id,
      prospect_name: inviteeName,
      source:       'calendly',
      value:        0,
      status:       'prospect',
      notes:        note,
      follow_up_date: startTime ? startTime.split('T')[0] : null,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Calendly webhook]', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ─── GOOGLE CALENDAR INTEGRATION ─────────────────────────────────────────────
const { syncCalendarForUser } = require('./routes/integrations');
require('./routes/integrations')(app, { authenticate, supabase });

// Background sync every 30 minutes (only when Google is configured)
if (GOOGLE_CLIENT_ID) {
  const SYNC_INTERVAL = 30 * 60 * 1000;
  const runGlobalSync = async () => {
    try {
      const { data: integrations } = await supabase
        .from('user_integrations')
        .select('user_id')
        .eq('gcal_sync_enabled', true)
        .not('google_refresh_token', 'is', null);
      for (const row of (integrations || [])) {
        await syncCalendarForUser(row.user_id, supabase).catch(e =>
          console.error('[GCal bg sync]', row.user_id, e.message)
        );
      }
    } catch (e) { console.error('[GCal bg sync global]', e.message); }
  };
  setInterval(runGlobalSync, SYNC_INTERVAL);
  // First run after 2 minutes on boot
  setTimeout(runGlobalSync, 2 * 60 * 1000);

  // Watch channel renewal — check every hour, renew if expiring within 24h
  const { startRenewalCron } = require('./lib/calendarWatchRenewal');
  startRenewalCron(supabase);
}

app.get('/api/health', (req, res) => res.json({ status:'ok', version:'23', features: { debrief_quality: FEATURE_DEBRIEF_QUALITY, manager_cockpit: FEATURE_MANAGER_COCKPIT, google_calendar: !!GOOGLE_CLIENT_ID } }));
// Sentry error handler (must be last middleware)
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

if (require.main === module) {
  app.listen(PORT, () => console.log("CloserDebrief API v22 - port " + PORT));
}
module.exports = app;
