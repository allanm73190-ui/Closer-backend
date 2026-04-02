// ─── CLOSER DEBRIEF — Backend v9 (objectives, comments, action_plans, deals) ─
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_KEY      = process.env.SUPABASE_KEY      || '';
const JWT_SECRET        = process.env.JWT_SECRET        || 'change-in-prod';
const RESEND_API_KEY    = process.env.RESEND_API_KEY    || '';
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

const loginAttempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of loginAttempts.entries()) {
    if (!state) {
      loginAttempts.delete(key);
      continue;
    }
    const latestAttempt = Array.isArray(state.attempts) && state.attempts.length > 0
      ? Math.max(...state.attempts)
      : 0;
    if ((!state.lockUntil || state.lockUntil < now) && now - latestAttempt > LOGIN_LOCK_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}, 60 * 1000).unref();

app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false,
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
}));
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

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
  let cP = 0;
  if (c.annonce_prix === 'directe') cP++;
  if (c.silence_prix === 'oui') cP++;
  if (c.douleur_reancree === 'oui') cP++;
  if (c.objection_isolee === 'oui') cP++;
  if (['close','retrograde','relance'].includes(c.resultat_closing)) cP++;
  return { decouverte:pct(dP,7), reformulation:pct(rP,5), projection:pct(pP,3), presentation_offre:pct(oP,3), closing:pct(cP,5) };
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
  add(c.annonce_prix, 'directe', 1);
  add(c.silence_prix, 'oui', 1);
  add(c.douleur_reancree, 'oui', 1);
  add(c.objection_isolee, 'oui', 1);
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

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error:'Token manquant', code:'AUTH_REQUIRED' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
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
async function buildGamification(userId) {
  const { data } = await supabase.from('debriefs').select('percentage,is_closed').eq('user_id', userId).order('created_at', { ascending:true });
  const list = data || [];
  const points     = list.reduce((s,d) => s+computePoints(d), 0);
  const prevPoints = list.slice(0,-1).reduce((s,d) => s+computePoints(d), 0);
  const pointsEarned = list.length > 0 ? computePoints(list[list.length-1]) : 0;
  const level = computeLevel(points), prevLevel = computeLevel(prevPoints);
  return { points, pointsEarned, level, prevLevel, levelUp:level.name!==prevLevel.name&&list.length>0, badges:computeBadges(list), totalDebriefs:list.length };
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
async function getHOSTeamMemberIds(hosId) {
  const { data: teams } = await supabase.from('teams').select('id').eq('owner_id', hosId);
  if (!teams?.length) return [];
  const { data: members } = await supabase.from('users').select('id').in('team_id', teams.map(t=>t.id));
  return (members||[]).map(m => m.id);
}

async function canUserAccessOwnerData(user, ownerUserId) {
  if (!user?.id || !ownerUserId) return false;
  if (isAdminRole(user.role)) return true;
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

function getLoginState(email) {
  const key = normalizeEmailForSecurity(email);
  if (!key) return { key, locked: false, remainingMs: 0 };
  const now = Date.now();
  const state = loginAttempts.get(key);
  if (!state) return { key, locked: false, remainingMs: 0 };

  const attempts = (state.attempts || []).filter(ts => now - ts <= LOGIN_LOCK_WINDOW_MS);
  const lockUntil = state.lockUntil || 0;
  if (attempts.length === 0 && lockUntil < now) {
    loginAttempts.delete(key);
    return { key, locked: false, remainingMs: 0 };
  }
  state.attempts = attempts;
  loginAttempts.set(key, state);
  if (lockUntil > now) {
    return { key, locked: true, remainingMs: lockUntil - now };
  }
  return { key, locked: false, remainingMs: 0 };
}

function registerLoginFailure(email) {
  const key = normalizeEmailForSecurity(email);
  if (!key) return { key, locked: false, remainingMs: 0, attempts: 0 };
  const now = Date.now();
  const current = loginAttempts.get(key) || { attempts: [], lockUntil: 0 };
  const attempts = (current.attempts || []).filter(ts => now - ts <= LOGIN_LOCK_WINDOW_MS);
  attempts.push(now);
  let lockUntil = current.lockUntil || 0;
  if (attempts.length >= LOGIN_LOCK_MAX_ATTEMPTS) {
    lockUntil = now + LOGIN_LOCK_DURATION_MS;
  }
  loginAttempts.set(key, { attempts, lockUntil });
  return {
    key,
    attempts: attempts.length,
    locked: lockUntil > now,
    remainingMs: lockUntil > now ? lockUntil - now : 0,
  };
}

function clearLoginFailures(email) {
  const key = normalizeEmailForSecurity(email);
  if (!key) return;
  loginAttempts.delete(key);
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
  return {
    ...deal,
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

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, name, role, invite_code } = req.body;
    if (!email||!password||!name) return res.status(400).json({ error:'Tous les champs sont requis' });
    const pwdPolicy = validatePasswordPolicy(password, { email, name });
    if (!pwdPolicy.ok) return res.status(400).json({ error:pwdPolicy.message, code:pwdPolicy.code });
    const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
    if (existing) return res.status(409).json({ error:'Cet email est déjà utilisé' });
    const requestedRole = normalizeRole(role);
    const adminByEmail = isAdminEmail(email);
    let finalRole = adminByEmail ? 'admin' : requestedRole;
    let teamId = null;

    if (finalRole === 'admin') {
      if (!adminByEmail) {
        return res.status(403).json({ error:'Création Admin non autorisée pour cet email' });
      }
    } else if (finalRole === 'head_of_sales') {
      teamId = null;
    } else {
      if (!invite_code) return res.status(400).json({ error:"Code d'invitation requis" });
      const { data: invite } = await supabase.from('invite_codes').select('*').eq('code', invite_code.toUpperCase()).eq('used', false).single();
      if (!invite) return res.status(400).json({ error:"Code invalide ou déjà utilisé" });
      teamId = invite.team_id;
      await supabase.from('invite_codes').update({ used:true, used_at:new Date().toISOString() }).eq('id', invite.id);
    }
    const hashed = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase.from('users').insert({ email, password:hashed, name, role:finalRole, team_id:teamId }).select().single();
    if (error) return res.status(500).json({ error:'Erreur création compte' });
    const effectiveUser = attachEffectiveRole(user);
    const token = jwt.sign({ id:effectiveUser.id, email:effectiveUser.email, role:effectiveUser.role, name:effectiveUser.name }, JWT_SECRET, { expiresIn:JWT_EXPIRES_IN });
    await recordSecurityAudit({
      actorId: effectiveUser.id,
      actorRole: effectiveUser.role,
      action: 'auth_register',
      req,
      details: { role: effectiveUser.role, invite_code_used: !!invite_code },
    });
    res.status(201).json({ token, user:{ id:effectiveUser.id, email:effectiveUser.email, name:effectiveUser.name, role:effectiveUser.role }, gamification:await buildGamification(effectiveUser.id) });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email||!password) return res.status(400).json({ error:'Email et mot de passe requis' });
    const lockState = getLoginState(email);
    if (lockState.locked) {
      const remainingMinutes = Math.max(1, Math.ceil(lockState.remainingMs / 60000));
      return res.status(429).json({
        error: `Compte temporairement verrouillé. Réessayez dans ${remainingMinutes} min.`,
        code: 'AUTH_LOCKED',
      });
    }
    const { data: rawUser } = await supabase.from('users').select('*').eq('email', email).single();
    const user = attachEffectiveRole(rawUser);
    if (!user||!(await bcrypt.compare(password, user.password))) {
      const failureState = registerLoginFailure(email);
      if (user?.id && failureState.locked) {
        await recordSecurityAudit({
          actorId: user.id,
          actorRole: user.role,
          action: 'auth_login_locked',
          outcome: 'failure',
          req,
          details: {
            attempts_in_window: failureState.attempts,
            lock_minutes: Math.max(1, Math.ceil(failureState.remainingMs / 60000)),
          },
        });
      }
      if (failureState.locked) {
        const remainingMinutes = Math.max(1, Math.ceil(failureState.remainingMs / 60000));
        return res.status(429).json({
          error: `Compte temporairement verrouillé. Réessayez dans ${remainingMinutes} min.`,
          code: 'AUTH_LOCKED',
        });
      }
      return res.status(401).json({ error:'Email ou mot de passe incorrect' });
    }
    clearLoginFailures(email);
    const token = jwt.sign({ id:user.id, email:user.email, role:user.role, name:user.name }, JWT_SECRET, { expiresIn:JWT_EXPIRES_IN });
    res.json({ token, user:{ id:user.id, email:user.email, name:user.name, role:user.role }, gamification:await buildGamification(user.id) });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  const { data: rawUser } = await supabase.from('users').select('id,email,name,role').eq('id', req.user.id).single();
  if (!rawUser) return res.status(404).json({ error:'Utilisateur introuvable' });
  const user = attachEffectiveRole(rawUser);
  res.json(user);
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error:'Email requis' });
  const { data: user } = await supabase.from('users').select('id,name').eq('email', email).single();
  if (!user) return res.json({ success:true });
  const resetToken = jwt.sign({ id:user.id, type:'reset' }, JWT_SECRET, { expiresIn:'1h' });
  if (RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:`Bearer ${RESEND_API_KEY}`, 'Content-Type':'application/json' }, body:JSON.stringify({ from:'CloserDebrief <onboarding@resend.dev>', to:email, subject:'Réinitialisation mot de passe', html:`<div style="font-family:Arial;max-width:480px;margin:0 auto"><h2 style="color:#6366f1">CloserDebrief</h2><p>Bonjour ${user.name},</p><a href="${APP_URL}?reset_token=${resetToken}" style="display:inline-block;background:#6366f1;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Réinitialiser</a><p style="color:#94a3b8;font-size:12px;margin-top:24px">Expire dans 1h.</p></div>` }) }).catch(console.error);
  }
  res.json({ success:true });
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token||!password) return res.status(400).json({ error:'Token et mot de passe requis' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'reset') return res.status(400).json({ error:'Token invalide' });
    const { data: user } = await supabase.from('users').select('id,email,name,role').eq('id', decoded.id).single();
    const pwdPolicy = validatePasswordPolicy(password, { email:user?.email, name:user?.name });
    if (!pwdPolicy.ok) return res.status(400).json({ error:pwdPolicy.message, code:pwdPolicy.code });
    await supabase.from('users').update({ password:await bcrypt.hash(password, 10) }).eq('id', decoded.id);
    if (user?.id) {
      const effectiveRole = getEffectiveRole(user);
      await recordSecurityAudit({
        actorId: user.id,
        actorRole: effectiveRole,
        action: 'auth_reset_password',
        req,
      });
    }
    res.json({ success:true });
  } catch { return res.status(400).json({ error:'Token invalide ou expiré' }); }
});

app.post('/api/auth/change-password', authenticate, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword||!newPassword) return res.status(400).json({ error:'Champs requis' });
  const { data: user } = await supabase.from('users').select('password,email,name,role').eq('id', req.user.id).single();
  if (!user||!(await bcrypt.compare(currentPassword, user.password))) return res.status(401).json({ error:'Mot de passe actuel incorrect' });
  const pwdPolicy = validatePasswordPolicy(newPassword, { email:user.email, name:user.name });
  if (!pwdPolicy.ok) return res.status(400).json({ error:pwdPolicy.message, code:pwdPolicy.code });
  await supabase.from('users').update({ password:await bcrypt.hash(newPassword, 10) }).eq('id', req.user.id);
  const effectiveRole = getEffectiveRole(user);
  await recordSecurityAudit({
    actorId: req.user.id,
    actorRole: effectiveRole,
    action: 'auth_change_password',
    req,
  });
  res.json({ success:true });
});

// ─── DEBRIEFS ─────────────────────────────────────────────────────────────────
app.get('/api/debriefs', authenticate, async (req, res) => {
  try {
    if (isAdminRole(req.user.role)) {
      const { data, error } = await supabase.from('debriefs').select('*').order('call_date', { ascending:false });
      if (error) return res.status(500).json({ error:'Erreur récupération' });
      return res.json(data || []);
    }
    let ids = [req.user.id];
    if (normalizeRole(req.user.role) === 'head_of_sales') {
      const memberIds = await getHOSTeamMemberIds(req.user.id);
      ids = [...new Set([req.user.id, ...memberIds])];
    }
    const { data, error } = await supabase.from('debriefs').select('*').in('user_id', ids).order('call_date', { ascending:false });
    if (error) return res.status(500).json({ error:'Erreur récupération' });
    res.json(data);
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.get('/api/debriefs/:id', authenticate, async (req, res) => {
  const { data: debrief } = await supabase.from('debriefs').select('*').eq('id', req.params.id).single();
  if (!debrief) return res.status(404).json({ error:'Debrief introuvable' });
  const canAccess = await canUserAccessOwnerData(req.user, debrief.user_id);
  if (!canAccess) return res.status(403).json({ error:'Accès refusé' });
  res.json(debrief);
});

app.post('/api/debriefs', authenticate, async (req, res) => {
  try {
    const totals = computeDebriefTotals(req.body.sections || {});
    const scores = computeSectionScores(req.body.sections || {});
    const payload = {
      ...req.body,
      user_id: req.user.id,
      user_name: req.user.name,
      total_score: totals.total,
      max_score: totals.max,
      percentage: totals.percentage,
      scores,
    };
    const { data: debrief, error } = await supabase.from('debriefs').insert(payload).select().single();
    if (error) return res.status(500).json({ error:'Erreur création' });
    // Auto-créer un deal dans le pipeline si prospect_name fourni
    await supabase.from('deals').insert({ user_id:req.user.id, user_name:req.user.name, prospect_name:req.body.prospect_name, source:'debrief', status:req.body.is_closed?'signe':'premier_appel', debrief_id:debrief.id, value:0 });
    res.status(201).json({ debrief, gamification:await buildGamification(req.user.id) });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.patch('/api/debriefs/:id', authenticate, async (req, res) => {
  try {
    const { data: existing, error: existingError } = await supabase
      .from('debriefs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (existingError || !existing) return res.status(404).json({ error:'Debrief introuvable' });
    const canAccess = await canUserAccessOwnerData(req.user, existing.user_id);
    if (!canAccess) {
      return res.status(403).json({ error:'Accès refusé' });
    }

    const payload = req.body || {};
    const nextSections = payload.sections || existing.sections || {};
    const nextSectionNotes = payload.section_notes || existing.section_notes || {};
    const totals = computeDebriefTotals(nextSections);
    const sectionScores = computeSectionScores(nextSections);

    const updateData = {
      prospect_name: payload.prospect_name ?? existing.prospect_name,
      call_date: payload.call_date ?? existing.call_date,
      closer_name: payload.closer_name ?? existing.closer_name,
      call_link: payload.call_link ?? existing.call_link,
      is_closed: typeof payload.is_closed === 'boolean' ? payload.is_closed : existing.is_closed,
      notes: payload.notes ?? existing.notes,
      sections: nextSections,
      section_notes: nextSectionNotes,
      total_score: totals.total,
      max_score: totals.max,
      percentage: totals.percentage,
      scores: sectionScores,
      updated_at: new Date().toISOString(),
    };

    const { data: updated, error: updateError } = await supabase
      .from('debriefs')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateError || !updated) return res.status(500).json({ error:'Erreur mise à jour' });

    await supabase
      .from('deals')
      .update({
        prospect_name: updateData.prospect_name,
        status: updateData.is_closed ? 'signe' : 'premier_appel',
        updated_at: new Date().toISOString(),
      })
      .eq('debrief_id', existing.id);

    const gamification = await buildGamification(existing.user_id);
    res.json({ debrief: updated, gamification });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error:'Erreur serveur' });
  }
});

app.delete('/api/debriefs/:id', authenticate, async (req, res) => {
  try {
    const { data: debrief } = await supabase.from('debriefs').select('user_id').eq('id', req.params.id).single();
    if (!debrief) return res.status(404).json({ error:'Introuvable' });
    const canAccess = await canUserAccessOwnerData(req.user, debrief.user_id);
    if (!canAccess) return res.status(403).json({ error:'Accès refusé' });
    await supabase.from('debriefs').delete().eq('id', req.params.id);
    res.json({ success:true, gamification:await buildGamification(debrief.user_id) });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

// ─── COMMENTS ─────────────────────────────────────────────────────────────────
app.get('/api/debriefs/:id/comments', authenticate, async (req, res) => {
  const { data: debrief } = await supabase
    .from('debriefs')
    .select('id,user_id')
    .eq('id', req.params.id)
    .single();
  if (!debrief) return res.status(404).json({ error:'Debrief introuvable' });
  const canAccess = await canUserAccessOwnerData(req.user, debrief.user_id);
  if (!canAccess) return res.status(403).json({ error:'Accès refusé' });
  const { data } = await supabase.from('comments').select('*').eq('debrief_id', req.params.id).order('created_at', { ascending:true });
  res.json(data || []);
});

app.post('/api/debriefs/:id/comments', authenticate, async (req, res) => {
  const { data: debrief } = await supabase
    .from('debriefs')
    .select('id,user_id')
    .eq('id', req.params.id)
    .single();
  if (!debrief) return res.status(404).json({ error:'Debrief introuvable' });
  const canAccess = await canUserAccessOwnerData(req.user, debrief.user_id);
  if (!canAccess) return res.status(403).json({ error:'Accès refusé' });
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error:'Contenu requis' });
  const { data, error } = await supabase.from('comments').insert({ debrief_id:req.params.id, author_id:req.user.id, author_name:req.user.name, content:content.trim() }).select().single();
  if (error) return res.status(500).json({ error:'Erreur création' });
  res.status(201).json(data);
});

app.delete('/api/comments/:id', authenticate, async (req, res) => {
  const { data: c } = await supabase
    .from('comments')
    .select('author_id,debrief_id')
    .eq('id', req.params.id)
    .single();
  if (!c) return res.status(404).json({ error:'Introuvable' });
  const isAuthor = c.author_id === req.user.id;
  if (!isAuthor) {
    if (!isManagerRole(req.user.role)) return res.status(403).json({ error:'Accès refusé' });
    const { data: debrief } = await supabase
      .from('debriefs')
      .select('user_id')
      .eq('id', c.debrief_id)
      .single();
    if (!debrief) return res.status(404).json({ error:'Debrief introuvable' });
    const canAccess = await canUserAccessOwnerData(req.user, debrief.user_id);
    if (!canAccess) return res.status(403).json({ error:'Accès refusé' });
  }
  await supabase.from('comments').delete().eq('id', req.params.id);
  res.json({ success:true });
});

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
    if (isAdminRole(req.user.role)) {
      const { data, error } = await supabase.from('deals').select('*').order('updated_at', { ascending:false });
      if (error) return res.status(500).json({ error:'Erreur récupération' });
      return res.json((data || []).map(mapDealForClient));
    }
    let ids = [req.user.id];
    if (normalizeRole(req.user.role) === 'head_of_sales') {
      const memberIds = await getHOSTeamMemberIds(req.user.id);
      ids = [...new Set([req.user.id, ...memberIds])];
    }
    const { data, error } = await supabase.from('deals').select('*').in('user_id', ids).order('updated_at', { ascending:false });
    if (error) return res.status(500).json({ error:'Erreur récupération' });
    res.json((data || []).map(mapDealForClient));
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.post('/api/deals', authenticate, async (req, res) => {
  const payload = req.body || {};
  const prospect_name = inferProspectName(payload);
  if (!prospect_name) return res.status(400).json({ error:'Nom du prospect requis' });

  const contactMeta = normalizeContactMeta(payload, payload.status);
  const status = typeof payload.status === 'string' && payload.status.trim()
    ? payload.status.trim()
    : (contactMeta.deal_closed ? 'signe' : 'prospect');
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
    const status = explicitStatus || (typeof nextMeta.deal_closed === 'boolean'
      ? (nextMeta.deal_closed ? 'signe' : (deal.status === 'signe' ? 'prospect' : deal.status || 'prospect'))
      : deal.status || 'prospect');
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
    const { data: deal } = await supabase.from('deals').select('user_id').eq('id', req.params.id).single();
    if (!deal) return res.status(404).json({ error:'Deal introuvable' });
    const canAccess = await canUserAccessOwnerData(req.user, deal.user_id);
    if (!canAccess) return res.status(403).json({ error:'Accès refusé' });
    await supabase.from('deals').delete().eq('id', req.params.id);
    res.json({ success:true });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

// ─── TEAMS ────────────────────────────────────────────────────────────────────
app.get('/api/teams/me', authenticate, async (req, res) => {
  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('team_id')
      .eq('id', req.user.id)
      .single();

    if (userError) return res.status(500).json({ error: 'Erreur récupération équipe' });
    if (!user?.team_id) return res.json({ team: null });

    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('id,name,owner_id,created_at')
      .eq('id', user.team_id)
      .single();

    if (teamError || !team) return res.json({ team: null });
    return res.json({ team });
  } catch (err) {
    console.error('Team me error:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/teams/join-with-code', authenticate, async (req, res) => {
  try {
    if (normalizeRole(req.user.role) !== 'closer') {
      return res.status(403).json({ error: 'Action réservée aux closers' });
    }

    const rawCode = String(req.body?.invite_code || '').trim().toUpperCase();
    if (!rawCode) return res.status(400).json({ error: "Code d'invitation requis" });

    const { data: invite, error: inviteError } = await supabase
      .from('invite_codes')
      .select('id,code,team_id,used')
      .eq('code', rawCode)
      .eq('used', false)
      .single();

    if (inviteError || !invite) {
      return res.status(400).json({ error: 'Code invalide ou déjà utilisé' });
    }

    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('id,name')
      .eq('id', invite.team_id)
      .single();
    if (teamError || !team) return res.status(404).json({ error: 'Équipe introuvable' });

    const { error: userUpdateError } = await supabase
      .from('users')
      .update({ team_id: team.id })
      .eq('id', req.user.id);
    if (userUpdateError) return res.status(500).json({ error: 'Impossible de rejoindre cette équipe' });

    await supabase
      .from('invite_codes')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('id', invite.id);

    await recordSecurityAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'team_join_with_code',
      req,
      details: {
        team_id: team.id,
        invite_code: rawCode,
      },
    });

    return res.json({ joined: true, team });
  } catch (err) {
    console.error('Join team with code error:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/teams', authenticate, requireHOS, async (req, res) => {
  try {
    const teamsQuery = supabase.from('teams').select('*').order('created_at', { ascending:true });
    const { data: teams } = isAdminRole(req.user.role)
      ? await teamsQuery
      : await teamsQuery.eq('owner_id', req.user.id);
    if (!teams?.length) return res.json([]);
    const teamIds = teams.map(t=>t.id);
    const [{ data: allMembers }, { data: allCodes }] = await Promise.all([
      supabase.from('users').select('id,name,email,role,created_at,team_id').in('team_id', teamIds),
      supabase.from('invite_codes').select('*').in('team_id', teamIds).eq('used', false).order('created_at', { ascending:false }),
    ]);
    let allDebriefs = [];
    const memberIds = (allMembers||[]).map(m=>m.id);
    if (memberIds.length) { const { data } = await supabase.from('debriefs').select('*').in('user_id', memberIds); allDebriefs = data||[]; }
    res.json(teams.map(team => ({ ...team, members:(allMembers||[]).filter(m=>m.team_id===team.id).map(m=>buildMemberStats(m,allDebriefs)), inviteCodes:(allCodes||[]).filter(c=>c.team_id===team.id) })));
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.post('/api/teams', authenticate, requireHOS, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error:'Nom requis' });
  const { data: team, error } = await supabase.from('teams').insert({ name:name.trim(), owner_id:req.user.id }).select().single();
  if (error) return res.status(500).json({ error:'Erreur création' });
  await recordSecurityAudit({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'team_create',
    req,
    details: { team_id: team.id, team_name: team.name },
  });
  res.status(201).json({ ...team, members:[], inviteCodes:[] });
});

app.patch('/api/teams/:id', authenticate, requireHOS, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error:'Nom requis' });
  const team = await assertTeamOwner(req.params.id, req.user.id, req.user.role);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  const { data } = await supabase.from('teams').update({ name:name.trim() }).eq('id', req.params.id).select().single();
  await recordSecurityAudit({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'team_rename',
    req,
    details: { team_id: req.params.id, team_name: data?.name || name.trim() },
  });
  res.json(data);
});

app.delete('/api/teams/:id', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwner(req.params.id, req.user.id, req.user.role);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  await supabase.from('users').update({ team_id:null }).eq('team_id', req.params.id);
  await supabase.from('invite_codes').delete().eq('team_id', req.params.id);
  await supabase.from('teams').delete().eq('id', req.params.id);
  await recordSecurityAudit({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'team_delete',
    req,
    details: { team_id: req.params.id },
  });
  res.json({ success:true });
});

app.post('/api/teams/:id/invite', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwner(req.params.id, req.user.id, req.user.role);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  const code = generateCode();
  const { data: invite, error } = await supabase.from('invite_codes').insert({ code, team_id:req.params.id, created_by:req.user.id, used:false }).select().single();
  if (error) return res.status(500).json({ error:'Erreur génération' });
  await recordSecurityAudit({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'team_invite_create',
    req,
    details: { team_id: req.params.id, invite_code: invite?.code || code },
  });
  res.json(invite);
});

app.delete('/api/teams/:id/invite/:codeId', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwner(req.params.id, req.user.id, req.user.role);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  await supabase.from('invite_codes').delete().eq('id', req.params.codeId).eq('team_id', req.params.id);
  await recordSecurityAudit({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'team_invite_delete',
    req,
    details: { team_id: req.params.id, code_id: req.params.codeId },
  });
  res.json({ success:true });
});

app.patch('/api/teams/:id/members/:memberId', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwner(req.params.id, req.user.id, req.user.role);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  const { data: member } = await supabase.from('users').select('id,team_id').eq('id', req.params.memberId).single();
  if (!member) return res.status(403).json({ error:'Accès refusé' });
  if (!isAdminRole(req.user.role)) {
    const { data: allTeams } = await supabase.from('teams').select('id').eq('owner_id', req.user.id);
    if (!(allTeams||[]).map(t=>t.id).includes(member.team_id)) return res.status(403).json({ error:'Accès refusé' });
  }
  await supabase.from('users').update({ team_id:req.params.id }).eq('id', req.params.memberId);
  await recordSecurityAudit({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'team_member_move',
    req,
    details: { team_id: req.params.id, member_id: req.params.memberId },
  });
  res.json({ success:true });
});

app.delete('/api/teams/:id/members/:memberId', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwner(req.params.id, req.user.id, req.user.role);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  await supabase.from('users').update({ team_id:null }).eq('id', req.params.memberId).eq('team_id', req.params.id);
  await recordSecurityAudit({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'team_member_remove',
    req,
    details: { team_id: req.params.id, member_id: req.params.memberId },
  });
  res.json({ success:true });
});

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
// ─── AI ANALYSIS ─────────────────────────────────────────────────────────────
const AI_SYSTEM_PROMPT = `Tu es un expert senior en analyse d'appels de vente et en coaching commercial, avec 15 ans d'expérience en closing B2B et B2C.

Tu analyses les debriefs post-appel remplis par des closers. Chaque debrief évalue 5 sections : Découverte, Reformulation, Projection, Présentation de l'offre, Closing & Objections. Chaque section a un score sur 5.

Tu es "CloserDebrief AI" et tu combines trois expertises :
1. ANALYSTE — patterns, forces et faiblesses
2. COACH — recommandations actionnables et personnalisées
3. STRATÈGE — tendances pour optimiser le processus de vente

Produis une analyse structurée :
## ANALYSE DU DEBRIEF — [prospect] — [date]
### 1. SCORE DE PERFORMANCE GLOBAL : [X/100]
### 2. POINTS FORTS
### 3. AXES D'AMÉLIORATION PRIORITAIRES (avec scripts alternatifs)
### 4. ANALYSE DES OBJECTIONS
### 5. PATTERN DÉTECTÉ
### 6. COACHING PERSONNALISÉ
### 7. SCRIPT SUGGÉRÉ
**ACTION PRIORITAIRE : [action claire et mesurable]**

Contraintes : direct, factuel, pas de flatterie. Ne jamais inventer de données. Entre 400 et 800 mots. Français.`;

function getAnthropicModelCandidates() {
  const seen = new Set();
  const ordered = [ANTHROPIC_MODEL, ...ANTHROPIC_FALLBACK_MODELS];
  return ordered.filter(model => {
    if (!model || seen.has(model)) return false;
    seen.add(model);
    return true;
  });
}

function readNoteValue(noteObj, keys) {
  if (!noteObj) return '';
  for (const key of keys) {
    if (noteObj[key]) return noteObj[key];
  }
  return '';
}

function shouldTryNextModel(status, message) {
  if (status === 404 || status === 429 || status >= 500) return true;
  if (status === 400 && /model|unsupported|not found|unknown/i.test(message)) return true;
  return false;
}

async function callAnthropicWithFallback(systemPrompt, userPrompt) {
  const modelCandidates = getAnthropicModelCandidates();
  let lastError = null;

  for (let i = 0; i < modelCandidates.length; i++) {
    const model = modelCandidates[i];
    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1200,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      if (anthropicRes.ok) {
        const anthropicData = await anthropicRes.json();
        const analysis = anthropicData.content?.[0]?.text || '';
        if (!analysis) {
          return { ok: false, status: 502, message: 'Réponse IA vide', modelTried: model };
        }
        return { ok: true, analysis, modelUsed: model };
      }

      const errBody = await anthropicRes.text();
      let errMessage = errBody;
      try {
        const parsed = JSON.parse(errBody);
        errMessage = parsed?.error?.message || parsed?.error || errBody;
      } catch {}

      lastError = {
        ok: false,
        status: anthropicRes.status,
        message: String(errMessage || 'Erreur API IA'),
        modelTried: model,
      };

      const hasNext = i < modelCandidates.length - 1;
      if (hasNext && shouldTryNextModel(anthropicRes.status, lastError.message)) {
        console.warn('Anthropic model failed, trying fallback:', {
          status: anthropicRes.status,
          model,
          message: lastError.message,
        });
        continue;
      }

      return lastError;
    } catch (err) {
      lastError = {
        ok: false,
        status: 502,
        message: err?.message || 'Erreur réseau Anthropic',
        modelTried: model,
      };
      const hasNext = i < modelCandidates.length - 1;
      if (hasNext) continue;
      return lastError;
    }
  }

  return lastError || { ok: false, status: 502, message: 'Aucun modèle IA disponible' };
}

const AI_OBJECTION_VARIANT_SYSTEM_PROMPT = `Tu es un coach de closing expert en gestion d'objections.
Ta mission : produire une réponse alternative prête à l'emploi, brève et naturelle.

Contraintes strictes :
- 2 à 3 phrases maximum
- style oral, concret, utilisable mot pour mot
- inclure une question ouverte
- réancrer la douleur du prospect
- aucune explication méta
- français`;

const AI_MANAGER_SUMMARY_SYSTEM_PROMPT = `Tu es le Copilot Manager d'un Head of Sales.
Ta mission : produire un résumé hebdomadaire ultra actionnable pour piloter une équipe de closers.

Contraintes:
- Français
- 180 à 260 mots
- Ton direct, concret, orienté décision
- Structure stricte:
1) Résumé exécutif (3 lignes max)
2) Ce qui progresse
3) Risques prioritaires
4) 3 recommandations opérationnelles (format "Action -> Impact attendu")
- Pas de fluff, pas de théorie générale.
- Ne pas inventer de chiffres: utiliser uniquement les métriques fournies.`;

function isDateInRange(value, fromDate, toDate) {
  const date = toStartOfDay(value);
  if (!date) return false;
  return date >= fromDate && date <= toDate;
}

function safeRound(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

function safePct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function buildDeltaLabel(current, previous, unit = '') {
  const delta = Number(current || 0) - Number(previous || 0);
  if (delta === 0) return `stable${unit ? ` (${current}${unit})` : ''}`;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta}${unit}`;
}

function isClosedDealStatus(status) {
  return /signe|won|close|perdu|lost|closed/i.test(String(status || ''));
}

function buildManagerRecommendations({ currentWeek, previousWeek, patterns, pipelineAlerts }) {
  const recommendations = [];
  if (patterns[0]) {
    recommendations.push(`${patterns[0].title} -> ${patterns[0].recommendation}`);
  }
  if (pipelineAlerts.atRisk > 0) {
    recommendations.push(`Lancer une cellule de relance des ${pipelineAlerts.atRisk} deals à risque sous 24h -> récupérer des opportunités chaudes.`);
  }
  if (pipelineAlerts.noDate > 0) {
    recommendations.push(`Imposer une date de prochain pas sur les ${pipelineAlerts.noDate} deals sans date -> réduire la stagnation du pipeline.`);
  }
  if (currentWeek.closeRate < 40) {
    recommendations.push('Coacher la transition valeur/prix en jeu de rôle quotidien -> améliorer le taux de closing global.');
  }
  if (currentWeek.avgScore < previousWeek.avgScore) {
    recommendations.push("Revue ciblée des debriefs en baisse de score cette semaine -> corriger rapidement les dérives d'exécution.");
  }
  if (recommendations.length < 3) {
    recommendations.push('Faire un point hebdo individuel de 15 min par closer -> sécuriser un plan d’action concret par personne.');
  }
  return recommendations.slice(0, 4);
}

app.post('/api/ai/objection-variant', authenticate, aiLimiter, async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée' });
    }

    const objectionLabel = String(req.body?.objection_label || '').trim();
    const objectionType = String(req.body?.objection_type || '').trim();
    const closingRate = Number(req.body?.closing_rate || 0);
    const count = Number(req.body?.count || 0);
    const bestResponse = String(req.body?.best_response || '').trim();

    if (!objectionLabel) return res.status(400).json({ error: 'objection_label requis' });

    const userPrompt = `
Objection: "${objectionLabel}"
Catégorie: ${objectionType || 'non renseignée'}
Fréquence: ${count || 0}
Taux de closing actuel: ${closingRate || 0}%
${bestResponse ? `Réponse actuelle la plus efficace: "${bestResponse}"` : 'Aucune réponse historique documentée'}

Génère UNE variante différente de la réponse actuelle.
Format attendu: uniquement le script final (sans titre, sans puces).
`;

    const aiResult = await callAnthropicWithFallback(AI_OBJECTION_VARIANT_SYSTEM_PROMPT, userPrompt);
    if (!aiResult.ok) {
      console.error('Anthropic objection variant error:', aiResult);
      return res.status(aiResult.status || 502).json({
        error: 'Erreur API IA',
        detail: aiResult.message,
        model: aiResult.modelTried,
      });
    }

    return res.json({
      variant: String(aiResult.analysis || '').trim(),
      model: aiResult.modelUsed,
    });
  } catch (err) {
    console.error('AI objection variant error:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/ai/manager-summary', authenticate, requireHOS, aiLimiter, async (req, res) => {
  try {
    let memberIds = [];
    if (isAdminRole(req.user.role)) {
      const { data: users } = await supabase.from('users').select('id,role');
      memberIds = (users || [])
        .filter(user => normalizeRole(user.role) === 'closer')
        .map(user => user.id);
    } else {
      memberIds = await getHOSTeamMemberIds(req.user.id);
    }
    if (!memberIds.length) {
      return res.json({
        period: null,
        metrics: null,
        highlights: ['Aucun closer associé à votre équipe pour le moment.'],
        recommendations: ['Inviter des closers avec un code équipe pour démarrer le pilotage hebdomadaire.'],
        patterns: [],
        topClosers: [],
        aiSummary: '',
        model: null,
      });
    }

    const [debriefRes, dealsRes, usersRes] = await Promise.all([
      supabase
        .from('debriefs')
        .select('id,user_id,user_name,prospect_name,call_date,is_closed,percentage,sections')
        .in('user_id', memberIds)
        .order('call_date', { ascending: false })
        .limit(1600),
      supabase
        .from('deals')
        .select('id,user_id,status,follow_up_date,updated_at,created_at')
        .in('user_id', memberIds)
        .order('updated_at', { ascending: false })
        .limit(1600),
      supabase
        .from('users')
        .select('id,name')
        .in('id', memberIds),
    ]);

    if (debriefRes.error || dealsRes.error) {
      return res.status(500).json({ error: 'Erreur récupération données manager' });
    }

    const debriefs = debriefRes.data || [];
    const deals = dealsRes.data || [];
    const users = usersRes.data || [];

    const today = toStartOfDay(new Date());
    const currentFrom = new Date(today);
    currentFrom.setDate(today.getDate() - 6);
    const previousFrom = new Date(currentFrom);
    previousFrom.setDate(currentFrom.getDate() - 7);
    const previousTo = new Date(currentFrom);
    previousTo.setDate(currentFrom.getDate() - 1);

    const currentWeekDebriefs = debriefs.filter(d => isDateInRange(d.call_date, currentFrom, today));
    const previousWeekDebriefs = debriefs.filter(d => isDateInRange(d.call_date, previousFrom, previousTo));

    const summarizeWeek = (list) => {
      const total = list.length;
      const closed = list.filter(item => item.is_closed).length;
      const avgScore = total > 0
        ? safeRound(list.reduce((sum, item) => sum + Number(item.percentage || 0), 0) / total)
        : 0;
      return {
        total,
        closed,
        closeRate: safePct(closed, total),
        avgScore,
      };
    };

    const currentWeek = summarizeWeek(currentWeekDebriefs);
    const previousWeek = summarizeWeek(previousWeekDebriefs);
    const patterns = computePatternInsights(currentWeekDebriefs).slice(0, 4);

    const openDeals = deals.filter(deal => !isClosedDealStatus(deal.status));
    const atRisk = openDeals.filter(deal => {
      const follow = toStartOfDay(deal.follow_up_date);
      return follow && follow < today;
    }).length;
    const noDate = openDeals.filter(deal => !deal.follow_up_date).length;
    const blocked = openDeals.filter(deal => {
      const days = getDaysSince(deal.updated_at || deal.created_at);
      return days !== null && days >= 8;
    }).length;
    const pipelineAlerts = { atRisk, noDate, blocked };

    const userNameById = new Map((users || []).map(user => [user.id, user.name]));
    const byCloser = {};
    for (const debrief of currentWeekDebriefs) {
      if (!byCloser[debrief.user_id]) byCloser[debrief.user_id] = [];
      byCloser[debrief.user_id].push(debrief);
    }
    const topClosers = Object.entries(byCloser)
      .map(([closerId, list]) => {
        const summary = summarizeWeek(list);
        return {
          closer_id: closerId,
          closer_name: userNameById.get(closerId) || list[0]?.user_name || 'Closer',
          debriefs: summary.total,
          avgScore: summary.avgScore,
          closeRate: summary.closeRate,
        };
      })
      .sort((a, b) => {
        if (b.debriefs !== a.debriefs) return b.debriefs - a.debriefs;
        if (b.closeRate !== a.closeRate) return b.closeRate - a.closeRate;
        return b.avgScore - a.avgScore;
      })
      .slice(0, 5);

    const highlights = [
      `${currentWeek.total} debriefs cette semaine (${buildDeltaLabel(currentWeek.total, previousWeek.total)} vs semaine précédente).`,
      `Score moyen: ${currentWeek.avgScore}% (${buildDeltaLabel(currentWeek.avgScore, previousWeek.avgScore, ' pts')}).`,
      `Taux de closing: ${currentWeek.closeRate}% (${buildDeltaLabel(currentWeek.closeRate, previousWeek.closeRate, ' pts')}).`,
      `Pipeline prioritaire: ${atRisk} à risque, ${noDate} sans date, ${blocked} bloqués.`,
    ];
    const recommendations = buildManagerRecommendations({ currentWeek, previousWeek, patterns, pipelineAlerts });

    let aiSummary = '';
    let model = null;
    if (ANTHROPIC_API_KEY) {
      const aiPrompt = `Période analysée: du ${currentFrom.toISOString().slice(0, 10)} au ${today.toISOString().slice(0, 10)}
Closers actifs: ${memberIds.length}
Debriefs semaine: ${currentWeek.total}
Debriefs semaine précédente: ${previousWeek.total}
Score moyen semaine: ${currentWeek.avgScore}%
Score moyen semaine précédente: ${previousWeek.avgScore}%
Taux de closing semaine: ${currentWeek.closeRate}%
Taux de closing semaine précédente: ${previousWeek.closeRate}%
Pipeline: à risque=${atRisk}, sans date=${noDate}, bloqués=${blocked}

Top closers semaine:
${topClosers.map((closer, idx) => `${idx + 1}. ${closer.closer_name} — ${closer.debriefs} debriefs — ${closer.closeRate}% closing — score ${closer.avgScore}%`).join('\n') || 'Aucun'}

Patterns majeurs:
${patterns.map(pattern => `- ${pattern.title}: ${pattern.count} cas (${pattern.rate}%)`).join('\n') || '- Aucun pattern critique identifié'}

Recommandations opérationnelles de base:
${recommendations.map(rec => `- ${rec}`).join('\n')}`;

      const aiResult = await callAnthropicWithFallback(AI_MANAGER_SUMMARY_SYSTEM_PROMPT, aiPrompt);
      if (aiResult.ok) {
        aiSummary = String(aiResult.analysis || '').trim();
        model = aiResult.modelUsed || null;
      }
    }

    return res.json({
      period: {
        current_from: currentFrom.toISOString().slice(0, 10),
        current_to: today.toISOString().slice(0, 10),
        previous_from: previousFrom.toISOString().slice(0, 10),
        previous_to: previousTo.toISOString().slice(0, 10),
      },
      metrics: {
        team_members: memberIds.length,
        current_week: currentWeek,
        previous_week: previousWeek,
        pipeline_alerts: pipelineAlerts,
      },
      highlights,
      recommendations,
      patterns,
      topClosers,
      aiSummary,
      model,
    });
  } catch (err) {
    console.error('AI manager summary error:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/ai/health', authenticate, async (req, res) => {
  res.json({
    configured: !!ANTHROPIC_API_KEY,
    modelCandidates: getAnthropicModelCandidates(),
    runtimeHasFetch: typeof fetch === 'function',
  });
});

app.post('/api/ai/analyze', authenticate, aiLimiter, async (req, res) => {
  try {
    const { debrief_id } = req.body;
    if (!debrief_id) return res.status(400).json({ error: 'debrief_id requis' });

    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée' });

    // Récupérer le debrief complet
    const { data: debrief, error: debriefError } = await supabase
      .from('debriefs')
      .select('id, user_id, user_name, prospect_name, call_date, is_closed, percentage, sections, section_notes, notes')
      .eq('id', debrief_id)
      .single();
    if (debriefError || !debrief) return res.status(404).json({ error: 'Debrief introuvable' });

    const canAccess = await canUserAccessOwnerData(req.user, debrief.user_id);
    if (!canAccess) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // Récupérer les 5 derniers debriefs du même user (historique)
    const { data: history } = await supabase
      .from('debriefs')
      .select('prospect_name, call_date, percentage, is_closed, sections')
      .eq('user_id', debrief.user_id)
      .neq('id', debrief_id)
      .order('call_date', { ascending: false })
      .limit(5);

    // Calculer les scores par section
    const sectionScores = computeSectionScores(debrief.sections);
    const configScopeOwnerId = await getDebriefConfigScopeOwnerId({
      id: debrief.user_id,
      role: debrief.user_id === req.user.id ? req.user.role : 'closer',
    });
    const debriefConfigSections = await getActiveDebriefConfigSections(configScopeOwnerId);
    const templateCatalog = await getActiveDebriefTemplateCatalog(configScopeOwnerId);
    const debriefMeta = debrief.sections?.__meta || {};
    const selectedTemplateKeyRaw = sanitizePipelineKey(
      debriefMeta.offer_template_key || debriefMeta.offer_type || '',
      ''
    );
    const selectedTemplate = templateCatalog.templates.find(template => template.key === selectedTemplateKeyRaw)
      || templateCatalog.templates.find(template => template.key === templateCatalog.defaultTemplateKey)
      || templateCatalog.templates[0]
      || null;

    const SECTION_LABELS = {
      decouverte: 'Découverte',
      reformulation: 'Reformulation',
      projection: 'Projection',
      presentation_offre: "Présentation de l'offre",
      closing: 'Closing & Objections',
    };

    const formatDate = (d) => {
      if (!d) return 'date inconnue';
      return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    };

    // Détail des sections avec questions configurées + notes
    const sectionDetails = (debriefConfigSections || DEFAULT_DEBRIEF_SECTION_CONFIG).map(section => {
      const sectionKey = section?.key || '';
      const scoreKey = scoreKeyFromSectionKey(sectionKey);
      const score = sectionScores[scoreKey] || 0;
      const sectionData = getSectionDataByKey(debrief.sections, sectionKey);
      const sectionNotes = getSectionNotesByKey(debrief.section_notes, sectionKey);
      const sectionTitle = section?.title || SECTION_LABELS[scoreKey] || sectionKey;

      const lines = [`**${sectionTitle}** : ${score}/5`];

      const questions = Array.isArray(section?.questions) ? section.questions : [];
      const answerLines = questions
        .map(question => {
          const qId = question?.id;
          if (!qId) return '';
          const rawAnswer = sectionData?.[qId];
          const prettyAnswer = formatAnswerFromQuestion(question, rawAnswer);
          if (!prettyAnswer) return '';
          return `  - ${question.label || qId} : ${prettyAnswer}`;
        })
        .filter(Boolean);
      if (answerLines.length > 0) lines.push(...answerLines);

      const strengthNote = readNoteValue(sectionNotes, ['strength', 'strengths']);
      const weaknessNote = readNoteValue(sectionNotes, ['weakness', 'weaknesses']);
      const improveNote = readNoteValue(sectionNotes, ['improvement', 'improvements']);
      if (strengthNote) lines.push(`  Points forts : ${strengthNote}`);
      if (weaknessNote) lines.push(`  Points faibles : ${weaknessNote}`);
      if (improveNote) lines.push(`  Pistes : ${improveNote}`);

      return lines.join('\n');
    }).join('\n\n');

    // Historique des appels précédents
    const historyLines = (history || []).map((h, i) => {
      const hs = computeSectionScores(h.sections);
      const avg = Object.values(hs).reduce((s, v) => s + v, 0) / Object.values(hs).length;
      return `${i + 1}. ${h.prospect_name || 'Inconnu'} — ${formatDate(h.call_date)} — Score: ${Math.round(h.percentage || 0)}% — Sections moy: ${(avg * 20).toFixed(0)}/100 ${h.is_closed ? '✓ Closé' : '✗ Non closé'}`;
    });
    const historyContext = historyLines.length > 0
      ? '\n\n### HISTORIQUE DES ' + historyLines.length + ' DERNIERS APPELS\n' + historyLines.join('\n')
      : '';

    // Détail du closing et objections
    const closingData = debrief.sections?.closing || {};
    const objections  = (closingData.objections || []).filter(o => o !== 'aucune');

    const userPrompt = `### DEBRIEF À ANALYSER
**Closer :** ${debrief.user_name || 'Inconnu'}
**Prospect :** ${debrief.prospect_name || 'Inconnu'}
**Date de l'appel :** ${formatDate(debrief.call_date)}
**Résultat :** ${debrief.is_closed ? 'CLOSÉ ✓' : 'NON CLOSÉ ✗'}
**Score global :** ${Math.round(debrief.percentage || 0)}%
**Template d'offre :** ${selectedTemplate?.label || 'Non renseigné'}
**Contexte template :** ${selectedTemplate?.aiFocus || "Aucun focus spécifique"}
**Notes générales :** ${debrief.notes || 'Aucune note'}

### SCORES PAR SECTION
${sectionDetails}

### OBJECTIONS RENCONTRÉES
${objections.length > 0 ? objections.join(', ') : 'Aucune objection signalée'}

### DÉTAIL DU CLOSING
- Annonce prix : ${closingData.annonce_prix || 'non renseigné'}
- Silence après prix : ${closingData.silence_prix || 'non renseigné'}
- Douleur réancrée : ${closingData.douleur_reancree || 'non renseigné'}
- Objection isolée : ${closingData.objection_isolee || 'non renseigné'}
- Résultat closing : ${closingData.resultat_closing || 'non renseigné'}${historyContext}

Fais une synthèse ciblée en suivant STRICTEMENT le format demandé.`;

    const aiResult = await callAnthropicWithFallback(AI_SYSTEM_PROMPT, userPrompt);
    if (!aiResult.ok) {
      console.error('Anthropic API error:', aiResult);
      return res.status(aiResult.status || 502).json({
        error: 'Erreur API IA',
        detail: aiResult.message,
        model: aiResult.modelTried,
      });
    }

    res.json({ analysis: aiResult.analysis, model: aiResult.modelUsed });
  } catch (err) {
    console.error('AI analyze error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status:'ok', version:'21' }));
app.listen(PORT, () => console.log("CloserDebrief API v21 - port " + PORT));
