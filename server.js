// ─── CLOSER DEBRIEF — Backend v5 ─────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL   = process.env.SUPABASE_URL   || 'COLLE_TON_URL_ICI';
const SUPABASE_KEY   = process.env.SUPABASE_KEY   || 'COLLE_TA_CLE_ANON_ICI';
const JWT_SECRET     = process.env.JWT_SECRET     || 'change-ce-secret-en-prod';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const APP_URL        = process.env.APP_URL        || 'https://closer-frontend-mu.vercel.app';
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
  if (p >= 500) return { name: 'Légende',      icon: '👑', min: 500, next: null };
  if (p >= 200) return { name: 'Expert',        icon: '💎', min: 200, next: 500 };
  if (p >= 100) return { name: 'Confirmé',      icon: '🥇', min: 100, next: 200 };
  if (p >= 50)  return { name: 'Intermédiaire', icon: '🥈', min: 50,  next: 100 };
  if (p >= 20)  return { name: 'Débutant+',     icon: '🥉', min: 20,  next: 50  };
  return              { name: 'Débutant',       icon: '🌱', min: 0,   next: 20  };
}
function computeBadges(debriefs) {
  const badges = [];
  const total = debriefs.length;
  const closed = debriefs.filter(d => d.is_closed).length;
  const perfect = debriefs.filter(d => (d.percentage||0) >= 90).length;
  const avg = total > 0 ? debriefs.reduce((s,d)=>s+(d.percentage||0),0)/total : 0;
  if (total >= 1)   badges.push({ id:'first',     icon:'🎯', label:'Premier debrief' });
  if (total >= 10)  badges.push({ id:'ten',        icon:'🔥', label:'10 debriefs' });
  if (total >= 50)  badges.push({ id:'fifty',      icon:'💪', label:'50 debriefs' });
  if (closed >= 1)  badges.push({ id:'closer',     icon:'✅', label:'Premier closing' });
  if (closed >= 10) badges.push({ id:'closer10',   icon:'🏆', label:'10 closings' });
  if (perfect >= 1) badges.push({ id:'perfect',    icon:'⭐', label:'Score parfait' });
  if (avg >= 80)    badges.push({ id:'consistent', icon:'📈', label:'Régularité 80%+' });
  return badges;
}

// ─── SCORES PAR SECTION ───────────────────────────────────────────────────────
function computeSectionScores(sections) {
  const s = sections || {};
  const score = (pts, max) => max > 0 ? Math.round((pts / max) * 5) : 0;
  const d = s.decouverte || {};
  let dPts = 0;
  if (d.douleur_surface === 'oui') dPts++;
  if (['oui','partiel'].includes(d.douleur_profonde)) dPts++;
  if (Array.isArray(d.couches_douleur)) dPts += Math.min(d.couches_douleur.length, 3);
  if (d.temporalite === 'oui') dPts++;
  if (['oui','artificielle'].includes(d.urgence)) dPts++;
  const r = s.reformulation || {};
  let rPts = 0;
  if (['oui','partiel'].includes(r.reformulation)) rPts++;
  if (['oui','moyen'].includes(r.prospect_reconnu)) rPts++;
  if (Array.isArray(r.couches_reformulation)) rPts += Math.min(r.couches_reformulation.length, 3);
  const p = s.projection || {};
  let pPts = 0;
  if (p.projection_posee === 'oui') pPts++;
  if (['forte','moyenne'].includes(p.qualite_reponse)) pPts++;
  if (p.deadline_levier === 'oui') pPts++;
  const o = s.offre || {};
  let oPts = 0;
  if (['oui','partiel'].includes(o.colle_douleurs)) oPts++;
  if (['oui','moyen'].includes(o.exemples_transformation)) oPts++;
  if (['oui','partiel'].includes(o.duree_justifiee)) oPts++;
  const c = s.closing || {};
  let cPts = 0;
  if (c.annonce_prix === 'directe') cPts++;
  if (c.silence_prix === 'oui') cPts++;
  if (c.douleur_reancree === 'oui') cPts++;
  if (c.objection_isolee === 'oui') cPts++;
  if (['close','retrograde','relance'].includes(c.resultat_closing)) cPts++;
  return {
    decouverte: score(dPts,7), reformulation: score(rPts,5),
    projection: score(pPts,3), presentation_offre: score(oPts,3), closing: score(cPts,5),
  };
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token manquant', code: 'AUTH_REQUIRED' });
  try { req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Session expirée, veuillez vous reconnecter', code: 'TOKEN_EXPIRED' }); }
}
function requireHOS(req, res, next) {
  if (req.user.role !== 'head_of_sales') return res.status(403).json({ error: 'Accès réservé aux Head of Sales' });
  next();
}

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── HELPER : obtenir ou créer l'équipe du HOS ────────────────────────────────
async function getOrCreateTeam(userId, userName) {
  let { data: team } = await supabase.from('teams').select('*').eq('owner_id', userId).single();
  if (!team) {
    const { data: newTeam } = await supabase.from('teams')
      .insert({ name: `Équipe de ${userName}`, owner_id: userId })
      .select().single();
    if (newTeam) {
      await supabase.from('users').update({ team_id: newTeam.id }).eq('id', userId);
      team = newTeam;
    }
  }
  return team;
}

async function buildGamification(userId) {
  const { data: debriefs } = await supabase.from('debriefs').select('percentage,is_closed').eq('user_id', userId);
  const list = debriefs || [];
  const points = list.reduce((s, d) => s + computePoints(d), 0);
  const prevPoints = list.slice(0, -1).reduce((s, d) => s + computePoints(d), 0);
  const lastDebrief = list[list.length - 1];
  const pointsEarned = lastDebrief ? computePoints(lastDebrief) : 0;
  return {
    points, prevPoints, pointsEarned,
    level: computeLevel(points),
    prevLevel: computeLevel(prevPoints),
    badges: computeBadges(list),
    totalDebriefs: list.length,
    levelUp: computeLevel(points).name !== computeLevel(prevPoints).name,
  };
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, role, invite_code } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Tous les champs sont requis' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères min)' });
  const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
  if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

  let finalRole = 'closer', teamId = null;
  if (role === 'head_of_sales') {
    finalRole = 'head_of_sales';
  } else {
    if (!invite_code) return res.status(400).json({ error: "Un code d'invitation est requis" });
    const { data: invite } = await supabase.from('invite_codes')
      .select('*').eq('code', invite_code.toUpperCase()).eq('used', false).single();
    if (!invite) return res.status(400).json({ error: "Code d'invitation invalide ou déjà utilisé" });
    teamId = invite.team_id;
    await supabase.from('invite_codes').update({ used: true, used_at: new Date().toISOString() }).eq('id', invite.id);
  }

  const hashed = await bcrypt.hash(password, 10);
  const { data: user, error } = await supabase.from('users')
    .insert({ email, password: hashed, name, role: finalRole, team_id: teamId }).select().single();
  if (error) { console.error(error); return res.status(500).json({ error: 'Erreur création compte' }); }

  if (finalRole === 'head_of_sales') {
    await getOrCreateTeam(user.id, user.name);
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  const gamification = await buildGamification(user.id);
  res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role }, gamification });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  // Auto-créer l'équipe si HOS sans équipe
  if (user.role === 'head_of_sales') await getOrCreateTeam(user.id, user.name);
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  const gamification = await buildGamification(user.id);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role }, gamification });
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  const { data: user } = await supabase.from('users').select('id,email,name,role').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (user.role === 'head_of_sales') await getOrCreateTeam(user.id, user.name);
  res.json(user);
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });
  const { data: user } = await supabase.from('users').select('id,name').eq('email', email).single();
  if (!user) return res.json({ success: true });
  const resetToken = jwt.sign({ id: user.id, type: 'reset' }, JWT_SECRET, { expiresIn: '1h' });
  if (RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'CloserDebrief <onboarding@resend.dev>', to: email,
        subject: 'Réinitialisation de votre mot de passe',
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto"><h2 style="color:#6366f1">CloserDebrief</h2><p>Bonjour ${user.name},</p><a href="${APP_URL}?reset_token=${resetToken}" style="display:inline-block;background:#6366f1;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Réinitialiser mon mot de passe</a><p style="color:#94a3b8;font-size:12px;margin-top:24px">Ce lien expire dans 1 heure.</p></div>`
      })
    }).catch(console.error);
  }
  res.json({ success: true });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token et mot de passe requis' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'reset') return res.status(400).json({ error: 'Token invalide' });
    const hashed = await bcrypt.hash(password, 10);
    await supabase.from('users').update({ password: hashed }).eq('id', decoded.id);
    res.json({ success: true });
  } catch { return res.status(400).json({ error: 'Token invalide ou expiré' }); }
});

// ─── DEBRIEFS ─────────────────────────────────────────────────────────────────
app.get('/api/debriefs', authenticate, async (req, res) => {
  let ids = [req.user.id];
  if (req.user.role === 'head_of_sales') {
    const team = await getOrCreateTeam(req.user.id, req.user.name);
    if (team) {
      const { data: members } = await supabase.from('users').select('id').eq('team_id', team.id);
      ids = [req.user.id, ...(members||[]).map(m => m.id)];
    }
  }
  const { data, error } = await supabase.from('debriefs').select('*').in('user_id', ids).order('call_date', { ascending: false });
  if (error) return res.status(500).json({ error: 'Erreur récupération debriefs' });
  res.json(data);
});

app.get('/api/debriefs/:id', authenticate, async (req, res) => {
  const { data: debrief } = await supabase.from('debriefs').select('*').eq('id', req.params.id).single();
  if (!debrief) return res.status(404).json({ error: 'Debrief introuvable' });
  if (req.user.role === 'closer' && debrief.user_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });
  res.json(debrief);
});

app.post('/api/debriefs', authenticate, async (req, res) => {
  const scores = computeSectionScores(req.body.sections);
  const { data: debrief, error } = await supabase.from('debriefs')
    .insert({ ...req.body, user_id: req.user.id, user_name: req.user.name, scores }).select().single();
  if (error) { console.error(error); return res.status(500).json({ error: 'Erreur création debrief' }); }
  const gamification = await buildGamification(req.user.id);
  res.status(201).json({ debrief, gamification });
});

app.delete('/api/debriefs/:id', authenticate, async (req, res) => {
  const { data: debrief } = await supabase.from('debriefs').select('user_id').eq('id', req.params.id).single();
  if (!debrief) return res.status(404).json({ error: 'Debrief introuvable' });
  if (req.user.role === 'closer' && debrief.user_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });
  await supabase.from('debriefs').delete().eq('id', req.params.id);
  const gamification = await buildGamification(req.user.id);
  res.json({ success: true, gamification });
});

// ─── GAMIFICATION ─────────────────────────────────────────────────────────────
app.get('/api/gamification/me', authenticate, async (req, res) => {
  res.json(await buildGamification(req.user.id));
});

app.get('/api/gamification/leaderboard', authenticate, async (req, res) => {
  const { data: users } = await supabase.from('users').select('id,name,role');
  const { data: allDebriefs } = await supabase.from('debriefs').select('percentage,is_closed,user_id');
  if (!users || !allDebriefs) return res.json([]);
  const board = users.filter(u => u.role !== 'head_of_sales').map(u => {
    const ud = allDebriefs.filter(d => d.user_id === u.id);
    const points = ud.reduce((s,d)=>s+computePoints(d),0);
    const avgScore = ud.length > 0 ? Math.round(ud.reduce((s,d)=>s+(d.percentage||0),0)/ud.length) : 0;
    return { id:u.id, name:u.name, points, level:computeLevel(points), avgScore, totalDebriefs:ud.length, closed:ud.filter(d=>d.is_closed).length };
  }).sort((a,b)=>b.points-a.points);
  res.json(board);
});

// ─── TEAM ─────────────────────────────────────────────────────────────────────
async function buildTeamData(userId, userName) {
  const team = await getOrCreateTeam(userId, userName);
  if (!team) return { team: null, members: [], inviteCodes: [] };

  const { data: allMembers } = await supabase.from('users').select('id,name,email,role,created_at').eq('team_id', team.id).neq('id', userId);
  const memberIds = (allMembers||[]).map(m => m.id);

  let allDebriefs = [];
  if (memberIds.length > 0) {
    const { data } = await supabase.from('debriefs').select('*').in('user_id', memberIds);
    allDebriefs = data || [];
  }

  const { data: inviteCodes } = await supabase.from('invite_codes').select('*').eq('team_id', team.id).eq('used', false);

  const members = (allMembers||[]).map(m => {
    const ud = allDebriefs.filter(d => d.user_id === m.id);
    const points = ud.reduce((s,d)=>s+computePoints(d),0);
    const avgScore = ud.length > 0 ? Math.round(ud.reduce((s,d)=>s+(d.percentage||0),0)/ud.length) : 0;
    const chartData = [...ud].sort((a,b)=>new Date(a.call_date)-new Date(b.call_date))
      .map(d => ({ date:d.call_date, score:Math.round(d.percentage||0), prospect:d.prospect_name }));
    return { ...m, points, level:computeLevel(points), badges:computeBadges(ud), avgScore, totalDebriefs:ud.length, closed:ud.filter(d=>d.is_closed).length, chartData };
  });

  return { team, members, inviteCodes: inviteCodes||[] };
}

app.get('/api/team', authenticate, requireHOS, async (req, res) => {
  res.json(await buildTeamData(req.user.id, req.user.name));
});

// Renommer l'équipe
app.patch('/api/team', authenticate, requireHOS, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
  const team = await getOrCreateTeam(req.user.id, req.user.name);
  if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
  const { data: updated } = await supabase.from('teams').update({ name: name.trim() }).eq('id', team.id).select().single();
  res.json(updated);
});

// Générer un code d'invitation
app.post('/api/team/invite', authenticate, requireHOS, async (req, res) => {
  const team = await getOrCreateTeam(req.user.id, req.user.name);
  if (!team) return res.status(500).json({ error: 'Impossible de créer/trouver l\'équipe' });
  const code = generateInviteCode();
  const { data: invite, error } = await supabase.from('invite_codes')
    .insert({ code, team_id: team.id, created_by: req.user.id, used: false }).select().single();
  if (error) { console.error(error); return res.status(500).json({ error: 'Erreur génération code' }); }
  res.json(invite);
});

// Supprimer un code d'invitation
app.delete('/api/team/invite/:id', authenticate, requireHOS, async (req, res) => {
  await supabase.from('invite_codes').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// Retirer un membre
app.delete('/api/team/members/:id', authenticate, requireHOS, async (req, res) => {
  const team = await getOrCreateTeam(req.user.id, req.user.name);
  if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
  await supabase.from('users').update({ team_id: null }).eq('id', req.params.id).eq('team_id', team.id);
  res.json({ success: true });
});

// Dashboard équipe pour le HOS
app.get('/api/team/dashboard', authenticate, requireHOS, async (req, res) => {
  const data = await buildTeamData(req.user.id, req.user.name);
  res.json(data.members);
});

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ API v5 démarrée sur http://localhost:${PORT}`));
