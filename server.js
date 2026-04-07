// ─── CLOSER DEBRIEF — Backend v9 (objectives, comments, action_plans, deals) ─
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const { computeDebriefQuality } = require('./lib/debriefQuality');

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error:'Token manquant', code:'AUTH_REQUIRED' });
  try { req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET); next(); }
  catch { return res.status(401).json({ error:'Session expirée', code:'TOKEN_EXPIRED' }); }
}
function requireHOS(req, res, next) {
  if (req.user.role !== 'head_of_sales') return res.status(403).json({ error:'Accès réservé aux Head of Sales' });
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
async function assertTeamOwner(teamId, userId) {
  const { data } = await supabase.from('teams').select('id,owner_id').eq('id', teamId).single();
  if (!data || data.owner_id !== userId) return null;
  return data;
}
async function getHOSTeamMemberIds(hosId) {
  const { data: teams } = await supabase.from('teams').select('id').eq('owner_id', hosId);
  if (!teams?.length) return [];
  const { data: members } = await supabase.from('users').select('id').in('team_id', teams.map(t=>t.id));
  return (members||[]).map(m => m.id);
}

const DEFAULT_DEBRIEF_SECTION_CONFIG = [
  { key: 'decouverte',        title: 'Phase de découverte',       questions: [] },
  { key: 'reformulation',     title: 'Reformulation',             questions: [] },
  { key: 'projection',        title: 'Projection',                questions: [] },
  { key: 'presentation_offre',title: "Présentation de l'offre",   questions: [] },
  { key: 'closing',           title: 'Closing & Objections',      questions: [] },
];

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

async function getActiveDebriefConfigSections() {
  try {
    const { data } = await supabase
      .from('debrief_config')
      .select('sections')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (Array.isArray(data?.sections) && data.sections.length > 0) {
      return data.sections;
    }
  } catch {}
  return DEFAULT_DEBRIEF_SECTION_CONFIG;
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, role, invite_code } = req.body;
    if (!email||!password||!name) return res.status(400).json({ error:'Tous les champs sont requis' });
    if (password.length < 8) return res.status(400).json({ error:'Mot de passe trop court' });
    const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
    if (existing) return res.status(409).json({ error:'Cet email est déjà utilisé' });
    let finalRole = 'closer', teamId = null;
    if (role === 'head_of_sales') { finalRole = 'head_of_sales'; }
    else {
      if (!invite_code) return res.status(400).json({ error:"Code d'invitation requis" });
      const { data: invite } = await supabase.from('invite_codes').select('*').eq('code', invite_code.toUpperCase()).eq('used', false).single();
      if (!invite) return res.status(400).json({ error:"Code invalide ou déjà utilisé" });
      teamId = invite.team_id;
      await supabase.from('invite_codes').update({ used:true, used_at:new Date().toISOString() }).eq('id', invite.id);
    }
    const hashed = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase.from('users').insert({ email, password:hashed, name, role:finalRole, team_id:teamId }).select().single();
    if (error) return res.status(500).json({ error:'Erreur création compte' });
    const token = jwt.sign({ id:user.id, email:user.email, role:user.role, name:user.name }, JWT_SECRET, { expiresIn:'7d' });
    res.status(201).json({ token, user:{ id:user.id, email:user.email, name:user.name, role:user.role }, gamification:await buildGamification(user.id) });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email||!password) return res.status(400).json({ error:'Email et mot de passe requis' });
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user||!(await bcrypt.compare(password, user.password))) return res.status(401).json({ error:'Email ou mot de passe incorrect' });
    const token = jwt.sign({ id:user.id, email:user.email, role:user.role, name:user.name }, JWT_SECRET, { expiresIn:'7d' });
    res.json({ token, user:{ id:user.id, email:user.email, name:user.name, role:user.role }, gamification:await buildGamification(user.id) });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  const { data: user } = await supabase.from('users').select('id,email,name,role').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ error:'Utilisateur introuvable' });
  res.json(user);
});

app.post('/api/auth/forgot-password', async (req, res) => {
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

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token||!password) return res.status(400).json({ error:'Token et mot de passe requis' });
  if (password.length < 8) return res.status(400).json({ error:'Trop court' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'reset') return res.status(400).json({ error:'Token invalide' });
    await supabase.from('users').update({ password:await bcrypt.hash(password, 10) }).eq('id', decoded.id);
    res.json({ success:true });
  } catch { return res.status(400).json({ error:'Token invalide ou expiré' }); }
});

app.post('/api/auth/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword||!newPassword) return res.status(400).json({ error:'Champs requis' });
  if (newPassword.length < 8) return res.status(400).json({ error:'Trop court' });
  const { data: user } = await supabase.from('users').select('password').eq('id', req.user.id).single();
  if (!user||!(await bcrypt.compare(currentPassword, user.password))) return res.status(401).json({ error:'Mot de passe actuel incorrect' });
  await supabase.from('users').update({ password:await bcrypt.hash(newPassword, 10) }).eq('id', req.user.id);
  res.json({ success:true });
});

// ─── DEBRIEFS ─────────────────────────────────────────────────────────────────
app.get('/api/debriefs', authenticate, async (req, res) => {
  try {
    let ids = [req.user.id];
    if (req.user.role === 'head_of_sales') {
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
  if (req.user.role === 'closer' && debrief.user_id !== req.user.id) return res.status(403).json({ error:'Accès refusé' });
  res.json(debrief);
});

app.post('/api/debriefs', authenticate, async (req, res) => {
  try {
    const raw = req.body || {};
    const sections = raw.sections;
    const sectionNotes = raw.section_notes;
    const callDate = raw.call_date;
    const scores = computeSectionScores(sections);
    const submittedAt = new Date().toISOString();

    const payload = { ...raw, user_id:req.user.id, user_name:req.user.name, scores };

    if (FEATURE_DEBRIEF_QUALITY) {
      const quality = computeDebriefQuality({
        sections,
        section_notes: sectionNotes,
        call_date: callDate,
        submitted_at: submittedAt,
      });
      payload.submitted_at = submittedAt;
      payload.overall_quality_score = quality.overall_quality_score;
      payload.quality_flags = quality.quality_flags;
      payload.quality_breakdown = quality.quality_breakdown;
      payload.validation_status = 'pending';
      payload.debrief_mode = typeof raw.debrief_mode === 'string' ? raw.debrief_mode : 'full';
    }

    const { data: debrief, error } = await supabase.from('debriefs').insert(payload).select().single();
    if (error) return res.status(500).json({ error:'Erreur création' });

    if (debrief) {
      logEvent('debrief_submitted', { debrief_id: debrief.id, user_id: req.user.id, mode: payload.debrief_mode });
      if (FEATURE_DEBRIEF_QUALITY) {
        logEvent('debrief_quality_scored', { debrief_id: debrief.id, score: payload.overall_quality_score, flags: payload.quality_flags });
      }
    }

    // Auto-créer un deal dans le pipeline si prospect_name fourni
    await supabase.from('deals').insert({ user_id:req.user.id, user_name:req.user.name, prospect_name:raw.prospect_name, source:'debrief', status:raw.is_closed?'signe':'premier_appel', debrief_id:debrief.id, value:0 });
    res.status(201).json({ debrief, gamification:await buildGamification(req.user.id) });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.delete('/api/debriefs/:id', authenticate, async (req, res) => {
  try {
    const { data: debrief } = await supabase.from('debriefs').select('user_id').eq('id', req.params.id).single();
    if (!debrief) return res.status(404).json({ error:'Introuvable' });
    if (req.user.role === 'closer' && debrief.user_id !== req.user.id) return res.status(403).json({ error:'Accès refusé' });
    await supabase.from('debriefs').delete().eq('id', req.params.id);
    res.json({ success:true, gamification:await buildGamification(req.user.id) });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

// ─── COMMENTS ─────────────────────────────────────────────────────────────────
app.get('/api/debriefs/:id/comments', authenticate, async (req, res) => {
  const { data } = await supabase.from('comments').select('*').eq('debrief_id', req.params.id).order('created_at', { ascending:true });
  res.json(data || []);
});

app.post('/api/debriefs/:id/comments', authenticate, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error:'Contenu requis' });
  const { data, error } = await supabase.from('comments').insert({ debrief_id:req.params.id, author_id:req.user.id, author_name:req.user.name, content:content.trim() }).select().single();
  if (error) return res.status(500).json({ error:'Erreur création' });
  res.status(201).json(data);
});

app.delete('/api/comments/:id', authenticate, async (req, res) => {
  const { data: c } = await supabase.from('comments').select('author_id').eq('id', req.params.id).single();
  if (!c) return res.status(404).json({ error:'Introuvable' });
  if (c.author_id !== req.user.id && req.user.role !== 'head_of_sales') return res.status(403).json({ error:'Accès refusé' });
  await supabase.from('comments').delete().eq('id', req.params.id);
  res.json({ success:true });
});

// ─── GAMIFICATION ─────────────────────────────────────────────────────────────
app.get('/api/gamification/me', authenticate, async (req, res) => { res.json(await buildGamification(req.user.id)); });
app.get('/api/gamification/leaderboard', authenticate, async (req, res) => {
  const { data: users } = await supabase.from('users').select('id,name,role');
  const { data: allDebriefs } = await supabase.from('debriefs').select('percentage,is_closed,user_id');
  if (!users||!allDebriefs) return res.json([]);
  const board = users.filter(u=>u.role!=='head_of_sales').map(u => {
    const ud = allDebriefs.filter(d=>d.user_id===u.id);
    const points = ud.reduce((s,d)=>s+computePoints(d),0);
    const avgScore = ud.length>0?Math.round(ud.reduce((s,d)=>s+(d.percentage||0),0)/ud.length):0;
    return { id:u.id, name:u.name, points, level:computeLevel(points), avgScore, totalDebriefs:ud.length, closed:ud.filter(d=>d.is_closed).length };
  }).sort((a,b)=>b.points-a.points);
  res.json(board);
});

// ─── OBJECTIVES ───────────────────────────────────────────────────────────────
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
        closings: periodDebriefs.filter(d=>d.is_closed).length,
        score:    periodDebriefs.length>0 ? Math.round(periodDebriefs.reduce((s,d)=>s+(d.percentage||0),0)/periodDebriefs.length) : 0,
        revenue:  periodDeals.reduce((s,d)=>s+(d.value||0),0),
      };
    };

    const result = (objectives||[]).map(obj => ({ ...obj, progress: getProgress(obj.period_start, obj.period_type) }));
    res.json(result);
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

// GET objectifs d'un closer (HOS)
app.get('/api/objectives/closer/:closerId', authenticate, requireHOS, async (req, res) => {
  try {
    const { data } = await supabase.from('objectives').select('*').eq('closer_id', req.params.closerId).order('period_start', { ascending:false });
    res.json(data || []);
  } catch(err) { res.status(500).json({ error:'Erreur serveur' }); }
});

// POST créer/mettre à jour un objectif (HOS)
app.post('/api/objectives', authenticate, requireHOS, async (req, res) => {
  try {
    const { closer_id, period_type, period_start, target_debriefs, target_score, target_closings, target_revenue } = req.body;
    if (!closer_id||!period_type||!period_start) return res.status(400).json({ error:'Champs requis' });
    // Upsert sur (closer_id, period_type, period_start)
    const { data: existing } = await supabase.from('objectives').select('id').eq('closer_id', closer_id).eq('period_type', period_type).eq('period_start', period_start).single();
    let result;
    if (existing) {
      const { data } = await supabase.from('objectives').update({ target_debriefs, target_score, target_closings, target_revenue }).eq('id', existing.id).select().single();
      result = data;
    } else {
      const { data } = await supabase.from('objectives').insert({ closer_id, hos_id:req.user.id, period_type, period_start, target_debriefs:target_debriefs||0, target_score:target_score||0, target_closings:target_closings||0, target_revenue:target_revenue||0 }).select().single();
      result = data;
    }
    res.json(result);
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

// ─── ACTION PLANS ─────────────────────────────────────────────────────────────
app.get('/api/action-plans/me', authenticate, async (req, res) => {
  const { data } = await supabase.from('action_plans').select('*').eq('closer_id', req.user.id).order('created_at', { ascending:false });
  res.json(data || []);
});

app.get('/api/action-plans/closer/:closerId', authenticate, requireHOS, async (req, res) => {
  const { data } = await supabase.from('action_plans').select('*').eq('closer_id', req.params.closerId).order('created_at', { ascending:false });
  res.json(data || []);
});

app.post('/api/action-plans', authenticate, requireHOS, async (req, res) => {
  const { closer_id, axis, description } = req.body;
  if (!closer_id||!axis) return res.status(400).json({ error:'Champs requis' });
  // Max 3 plans actifs par closer
  const { data: active } = await supabase.from('action_plans').select('id').eq('closer_id', closer_id).eq('status', 'active');
  if ((active||[]).length >= 3) return res.status(400).json({ error:'Maximum 3 axes actifs par closer' });
  const { data, error } = await supabase.from('action_plans').insert({ closer_id, hos_id:req.user.id, axis, description, status:'active' }).select().single();
  if (error) return res.status(500).json({ error:'Erreur création' });
  res.status(201).json(data);
});

app.patch('/api/action-plans/:id', authenticate, async (req, res) => {
  const { status, description } = req.body;
  const update = {};
  if (status) { update.status = status; if (status==='resolved') update.resolved_at = new Date().toISOString(); }
  if (description !== undefined) update.description = description;
  const { data, error } = await supabase.from('action_plans').update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error:'Erreur mise à jour' });
  res.json(data);
});

app.delete('/api/action-plans/:id', authenticate, requireHOS, async (req, res) => {
  await supabase.from('action_plans').delete().eq('id', req.params.id);
  res.json({ success:true });
});

// ─── DEALS / PIPELINE ─────────────────────────────────────────────────────────
app.get('/api/deals', authenticate, async (req, res) => {
  try {
    let ids = [req.user.id];
    if (req.user.role === 'head_of_sales') {
      const memberIds = await getHOSTeamMemberIds(req.user.id);
      ids = [...new Set([req.user.id, ...memberIds])];
    }
    const { data, error } = await supabase.from('deals').select('*').in('user_id', ids).order('updated_at', { ascending:false });
    if (error) return res.status(500).json({ error:'Erreur récupération' });
    res.json(data);
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.post('/api/deals', authenticate, async (req, res) => {
  const { prospect_name, source, value, status, follow_up_date, notes } = req.body;
  if (!prospect_name) return res.status(400).json({ error:'Nom du prospect requis' });
  const { data, error } = await supabase.from('deals').insert({ user_id:req.user.id, user_name:req.user.name, prospect_name, source, value:value||0, status:status||'prospect', follow_up_date, notes }).select().single();
  if (error) return res.status(500).json({ error:'Erreur création' });
  res.status(201).json(data);
});

app.patch('/api/deals/:id', authenticate, async (req, res) => {
  try {
    const { data: deal } = await supabase.from('deals').select('user_id').eq('id', req.params.id).single();
    if (!deal) return res.status(404).json({ error:'Deal introuvable' });
    if (req.user.role === 'closer' && deal.user_id !== req.user.id) return res.status(403).json({ error:'Accès refusé' });
    const { data, error } = await supabase.from('deals').update({ ...req.body, updated_at:new Date().toISOString() }).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error:'Erreur mise à jour' });
    res.json(data);
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.delete('/api/deals/:id', authenticate, async (req, res) => {
  try {
    const { data: deal } = await supabase.from('deals').select('user_id').eq('id', req.params.id).single();
    if (!deal) return res.status(404).json({ error:'Deal introuvable' });
    if (req.user.role === 'closer' && deal.user_id !== req.user.id) return res.status(403).json({ error:'Accès refusé' });
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
    if (req.user.role !== 'closer') {
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

    return res.json({ joined: true, team });
  } catch (err) {
    console.error('Join team with code error:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/teams', authenticate, requireHOS, async (req, res) => {
  try {
    const { data: teams } = await supabase.from('teams').select('*').eq('owner_id', req.user.id).order('created_at', { ascending:true });
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
  res.status(201).json({ ...team, members:[], inviteCodes:[] });
});

app.patch('/api/teams/:id', authenticate, requireHOS, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error:'Nom requis' });
  const team = await assertTeamOwner(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  const { data } = await supabase.from('teams').update({ name:name.trim() }).eq('id', req.params.id).select().single();
  res.json(data);
});

app.delete('/api/teams/:id', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwner(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  await supabase.from('users').update({ team_id:null }).eq('team_id', req.params.id);
  await supabase.from('invite_codes').delete().eq('team_id', req.params.id);
  await supabase.from('teams').delete().eq('id', req.params.id);
  res.json({ success:true });
});

app.post('/api/teams/:id/invite', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwner(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  const code = generateCode();
  const { data: invite, error } = await supabase.from('invite_codes').insert({ code, team_id:req.params.id, created_by:req.user.id, used:false }).select().single();
  if (error) return res.status(500).json({ error:'Erreur génération' });
  res.json(invite);
});

app.delete('/api/teams/:id/invite/:codeId', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwner(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  await supabase.from('invite_codes').delete().eq('id', req.params.codeId).eq('team_id', req.params.id);
  res.json({ success:true });
});

app.patch('/api/teams/:id/members/:memberId', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwner(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  const { data: allTeams } = await supabase.from('teams').select('id').eq('owner_id', req.user.id);
  const { data: member } = await supabase.from('users').select('id,team_id').eq('id', req.params.memberId).single();
  if (!member || !(allTeams||[]).map(t=>t.id).includes(member.team_id)) return res.status(403).json({ error:'Accès refusé' });
  await supabase.from('users').update({ team_id:req.params.id }).eq('id', req.params.memberId);
  res.json({ success:true });
});

app.delete('/api/teams/:id/members/:memberId', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwner(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  await supabase.from('users').update({ team_id:null }).eq('id', req.params.memberId).eq('team_id', req.params.id);
  res.json({ success:true });
});


// ─── ZAPIER WEBHOOKS ──────────────────────────────────────────────────────────

// Zapier → CloserDebrief : recevoir un deal depuis iClosed
app.post('/api/zapier/iclosed-deal', async (req, res) => {
  try {
    const secret = req.headers['x-zapier-secret'];
    if (secret !== process.env.ZAPIER_SECRET) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const {
      prospect_name,
      source,
      value,
      status,
      follow_up_date,
      notes,
      iclosed_id,
      closer_email,
    } = req.body;

    if (!prospect_name) return res.status(400).json({ error: 'prospect_name requis' });

    // Trouver le closer par email si fourni
    let user_id = null, user_name = 'iClosed';
    if (closer_email) {
      const { data: user } = await supabase
        .from('users').select('id,name').eq('email', closer_email).single();
      if (user) { user_id = user.id; user_name = user.name; }
    }

    // Mapper statut iClosed → CloserDebrief
    const statusMap = {
      'new':         'prospect',
      'contacted':   'premier_appel',
      'follow_up':   'relance',
      'negotiation': 'negociation',
      'won':         'signe',
      'lost':        'perdu',
    };
    const mappedStatus = statusMap[status?.toLowerCase()] || 'prospect';

    // Upsert : créer ou mettre à jour selon iclosed_id
    if (iclosed_id) {
      const { data: existing } = await supabase
        .from('deals').select('id').eq('iclosed_id', iclosed_id).single();

      if (existing) {
        const { data } = await supabase.from('deals')
          .update({ prospect_name, source, value: Number(value)||0, status: mappedStatus, follow_up_date, notes, updated_at: new Date().toISOString() })
          .eq('id', existing.id).select().single();
        return res.json({ action: 'updated', deal: data });
      }
    }

    const { data, error } = await supabase.from('deals').insert({
      user_id, user_name, prospect_name, source,
      value: Number(value) || 0,
      status: mappedStatus,
      follow_up_date,
      notes,
      iclosed_id: iclosed_id || null,
    }).select().single();

    if (error) {
      console.error('Supabase insert error:', JSON.stringify(error));
      return res.status(500).json({ error: 'Erreur création deal', detail: error.message, code: error.code });
    }
    res.status(201).json({ action: 'created', deal: data });

  } catch(err) {
    console.error('Zapier webhook error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// CloserDebrief → Zapier : envoyer un deal vers iClosed
app.post('/api/zapier/push-deal', authenticate, async (req, res) => {
  try {
    const { deal_id } = req.body;
    if (!deal_id) return res.status(400).json({ error: 'deal_id requis' });

    const { data: deal } = await supabase.from('deals').select('*').eq('id', deal_id).single();
    if (!deal) return res.status(404).json({ error: 'Deal introuvable' });

    // Mapper statut CloserDebrief → iClosed
    const statusMap = {
      'prospect':      'new',
      'premier_appel': 'contacted',
      'relance':       'follow_up',
      'negociation':   'negotiation',
      'signe':         'won',
      'perdu':         'lost',
    };

    const zapierUrl = process.env.ZAPIER_WEBHOOK_URL;
    if (!zapierUrl) return res.status(500).json({ error: 'ZAPIER_WEBHOOK_URL non configuré' });

    await fetch(zapierUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prospect_name: deal.prospect_name,
        value:         deal.value,
        status:        statusMap[deal.status] || 'new',
        source:        deal.source,
        notes:         deal.notes,
        follow_up_date:deal.follow_up_date,
        iclosed_id:    deal.iclosed_id,
        closer_name:   deal.user_name,
      }),
    });

    res.json({ success: true });
  } catch(err) {
    console.error('Push deal error:', err);
    res.status(500).json({ error: 'Erreur envoi Zapier' });
  }
});

// ─── DEBRIEF CONFIG ───────────────────────────────────────────────────────────
// GET  /api/debrief-config         — retourne la config active (ou défaut)
// PUT  /api/debrief-config         — sauvegarde (HOS seulement)
// DELETE /api/debrief-config       — reset au défaut (HOS seulement)

app.get('/api/debrief-config', authenticate, async (req, res) => {
  try {
    const { data } = await supabase
      .from('debrief_config')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    if (data) return res.json({ sections: data.sections });
    res.json({ sections: null }); // null = utiliser le défaut côté frontend
  } catch { res.json({ sections: null }); }
});

app.put('/api/debrief-config', authenticate, requireHOS, async (req, res) => {
  const { sections } = req.body;
  if (!sections || !Array.isArray(sections)) return res.status(400).json({ error: 'sections requises' });
  try {
    // Upsert — une seule config globale
    const { data: existing } = await supabase.from('debrief_config').select('id').limit(1).single();
    if (existing) {
      await supabase.from('debrief_config').update({ sections, updated_at: new Date().toISOString(), updated_by: req.user.id }).eq('id', existing.id);
    } else {
      await supabase.from('debrief_config').insert({ sections, updated_by: req.user.id });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/debrief-config', authenticate, requireHOS, async (req, res) => {
  try {
    await supabase.from('debrief_config').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ─── OBJECTION LIBRARY ───────────────────────────────────────────────────────
app.get('/api/objections', authenticate, async (req, res) => {
  try {
    let ids = [req.user.id];
    if (req.user.role === 'head_of_sales') {
      const memberIds = await getHOSTeamMemberIds(req.user.id);
      ids = [...new Set([req.user.id, ...memberIds])];
    }
    const { data: debriefs, error } = await supabase
      .from('debriefs')
      .select('id, user_id, user_name, prospect_name, call_date, is_closed, percentage, sections, section_notes, notes')
      .in('user_id', ids)
      .order('call_date', { ascending: false });
    if (error) return res.status(500).json({ error: 'Erreur récupération' });
    const OBJECTION_LABELS = {
      budget: 'Budget', reflechir: 'Besoin de réfléchir',
      conjoint: 'Conjoint / Tiers', methode: 'Méthode / Doute produit',
    };
    const objMap = {};
    for (const d of (debriefs || [])) {
      const closing = d.sections?.closing || {};
      const objections = closing.objections || [];
      for (const type of objections) {
        if (type === 'aucune') continue;
        if (!objMap[type]) objMap[type] = { type, label: OBJECTION_LABELS[type] || type, count: 0, closed: 0, debriefs: [] };
        objMap[type].count++;
        if (d.is_closed) objMap[type].closed++;
        objMap[type].debriefs.push({
          id: d.id, prospect_name: d.prospect_name, call_date: d.call_date,
          user_name: d.user_name, is_closed: d.is_closed, percentage: d.percentage,
          douleur_reancree: closing.douleur_reancree, objection_isolee: closing.objection_isolee,
          resultat_closing: closing.resultat_closing, notes: d.notes,
          section_notes_closing: d.section_notes?.closing || {},
        });
      }
    }
    const result = Object.values(objMap)
      .map(o => ({
        ...o,
        closingRate: o.count > 0 ? Math.round((o.closed / o.count) * 100) : 0,
        bestResponses: o.debriefs.filter(d => d.is_closed).sort((a, b) => (b.percentage || 0) - (a.percentage || 0)).slice(0, 5),
        worstCases: o.debriefs.filter(d => !d.is_closed).sort((a, b) => (a.percentage || 0) - (b.percentage || 0)).slice(0, 3),
      }))
      .sort((a, b) => b.count - a.count);
    res.json({
      total: (debriefs || []).length,
      totalWithObjections: (debriefs || []).filter(d => {
        const objs = d.sections?.closing?.objections || [];
        return objs.length > 0 && !objs.includes('aucune');
      }).length,
      objections: result,
    });
  } catch (err) { console.error('Objections error:', err); res.status(500).json({ error: 'Erreur serveur' }); }
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
          max_tokens: 4000,
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

app.post('/api/ai/objection-variant', authenticate, async (req, res) => {
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

app.get('/api/ai/health', authenticate, async (req, res) => {
  res.json({
    configured: !!ANTHROPIC_API_KEY,
    modelCandidates: getAnthropicModelCandidates(),
    runtimeHasFetch: typeof fetch === 'function',
  });
});

app.post('/api/ai/analyze', authenticate, async (req, res) => {
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

    // Contrôle d'accès : un closer ne peut analyser que ses propres debriefs
    if (req.user.role === 'closer' && debrief.user_id !== req.user.id) {
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
    const debriefConfigSections = await getActiveDebriefConfigSections();

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

Analyse ce debrief en profondeur et fournis un coaching actionnable.`;

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
    // Contrôle d'accès : HOS ne peut reviewer que les debriefs de son équipe
    const memberIds = await getHOSTeamMemberIds(req.user.id);
    const teamIds = [...new Set([req.user.id, ...memberIds])];
    if (!teamIds.includes(debrief.user_id)) return res.status(403).json({ error:'Accès refusé' });

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
    const memberIds = await getHOSTeamMemberIds(req.user.id);
    const scopeIds = [...new Set([req.user.id, ...memberIds])];
    const { data, error } = await supabase
      .from('debriefs')
      .select('id,user_id,user_name,prospect_name,call_date,submitted_at,overall_quality_score,quality_flags,validation_status')
      .eq('validation_status', 'pending')
      .in('user_id', scopeIds)
      .order('overall_quality_score', { ascending: true })
      .limit(50);
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
    const memberIds = await getHOSTeamMemberIds(req.user.id);
    const scopeIds = [...new Set([req.user.id, ...memberIds])];
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

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status:'ok', version:'22', features: { debrief_quality: FEATURE_DEBRIEF_QUALITY, manager_cockpit: FEATURE_MANAGER_COCKPIT } }));
app.listen(PORT, () => console.log("CloserDebrief API v22 - port " + PORT));
