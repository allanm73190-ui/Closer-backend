// ─── CLOSER DEBRIEF — Backend v9 (objectives, comments, action_plans, deals) ─
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SUPABASE_URL   = process.env.SUPABASE_URL   || '';
const SUPABASE_KEY   = process.env.SUPABASE_KEY   || '';
const JWT_SECRET     = process.env.JWT_SECRET     || 'change-in-prod';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const APP_URL        = process.env.APP_URL        || 'https://closerdebrief.vercel.app';
const PORT           = process.env.PORT           || 3001;

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
    const scores = computeSectionScores(req.body.sections);
    const { data: debrief, error } = await supabase.from('debriefs').insert({ ...req.body, user_id:req.user.id, user_name:req.user.name, scores }).select().single();
    if (error) return res.status(500).json({ error:'Erreur création' });
    // Auto-créer un deal dans le pipeline si prospect_name fourni
    await supabase.from('deals').insert({ user_id:req.user.id, user_name:req.user.name, prospect_name:req.body.prospect_name, source:'debrief', status:req.body.is_closed?'signe':'premier_appel', debrief_id:debrief.id, value:0 });
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
```
// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status:'ok', version:'10' }));
app.listen(PORT, () => console.log(`✅ CloserDebrief API v10 — port ${PORT}`));
