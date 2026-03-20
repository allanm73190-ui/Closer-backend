// ─── CLOSER DEBRIEF — Backend v7 (multi-team) ────────────────────────────────
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
  if (p >= 500) return { name:'Légende',      icon:'👑', min:500, next:null };
  if (p >= 200) return { name:'Expert',        icon:'💎', min:200, next:500  };
  if (p >= 100) return { name:'Confirmé',      icon:'🥇', min:100, next:200  };
  if (p >= 50)  return { name:'Intermédiaire', icon:'🥈', min:50,  next:100  };
  if (p >= 20)  return { name:'Débutant+',     icon:'🥉', min:20,  next:50   };
  return              { name:'Débutant',       icon:'🌱', min:0,   next:20   };
}
function computeBadges(list) {
  const badges = [];
  const total  = list.length;
  const closed = list.filter(d => d.is_closed).length;
  const avg    = total > 0 ? list.reduce((s,d)=>s+(d.percentage||0),0)/total : 0;
  if (total >= 1)   badges.push({ id:'first',     icon:'🎯', label:'Premier debrief' });
  if (total >= 10)  badges.push({ id:'ten',        icon:'🔥', label:'10 debriefs'     });
  if (total >= 50)  badges.push({ id:'fifty',      icon:'💪', label:'50 debriefs'     });
  if (closed >= 1)  badges.push({ id:'closer1',    icon:'✅', label:'Premier closing' });
  if (closed >= 10) badges.push({ id:'closer10',   icon:'🏆', label:'10 closings'     });
  if (list.some(d=>(d.percentage||0)>=90)) badges.push({ id:'perfect', icon:'⭐', label:'Score parfait' });
  if (avg >= 80)    badges.push({ id:'consistent', icon:'📈', label:'Régularité 80%+' });
  return badges;
}

// ─── SCORES PAR SECTION ───────────────────────────────────────────────────────
function computeSectionScores(sections) {
  const s = sections || {};
  const pct = (pts, max) => max > 0 ? Math.round((pts / max) * 5) : 0;
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
    decouverte: pct(dPts,7), reformulation: pct(rPts,5),
    projection: pct(pPts,3), presentation_offre: pct(oPts,3), closing: pct(cPts,5),
  };
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer '))
    return res.status(401).json({ error:'Token manquant', code:'AUTH_REQUIRED' });
  try { req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET); next(); }
  catch { return res.status(401).json({ error:'Session expirée', code:'TOKEN_EXPIRED' }); }
}
function requireHOS(req, res, next) {
  if (req.user.role !== 'head_of_sales')
    return res.status(403).json({ error:'Accès réservé aux Head of Sales' });
  next();
}

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length:8 }, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function buildGamification(userId) {
  const { data } = await supabase.from('debriefs')
    .select('percentage,is_closed').eq('user_id', userId).order('created_at', { ascending:true });
  const list = data || [];
  const points     = list.reduce((s,d) => s+computePoints(d), 0);
  const prevPoints = list.slice(0,-1).reduce((s,d) => s+computePoints(d), 0);
  const pointsEarned = list.length > 0 ? computePoints(list[list.length-1]) : 0;
  const level     = computeLevel(points);
  const prevLevel = computeLevel(prevPoints);
  return { points, pointsEarned, level, prevLevel, levelUp: level.name!==prevLevel.name && list.length>0, badges:computeBadges(list), totalDebriefs:list.length };
}

function buildMemberStats(member, debriefs) {
  const ud = debriefs.filter(d => d.user_id === member.id);
  const points   = ud.reduce((s,d) => s+computePoints(d), 0);
  const avgScore = ud.length>0 ? Math.round(ud.reduce((s,d)=>s+(d.percentage||0),0)/ud.length) : 0;
  const chartData = [...ud].sort((a,b)=>new Date(a.call_date)-new Date(b.call_date))
    .map(d=>({ date:d.call_date, score:Math.round(d.percentage||0), prospect:d.prospect_name }));
  return { ...member, points, level:computeLevel(points), badges:computeBadges(ud), avgScore, totalDebriefs:ud.length, closed:ud.filter(d=>d.is_closed).length, chartData };
}

// Vérifier que l'équipe appartient bien au HOS
async function assertTeamOwnership(teamId, userId) {
  const { data } = await supabase.from('teams').select('id,owner_id').eq('id', teamId).single();
  if (!data || data.owner_id !== userId) return null;
  return data;
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, role, invite_code } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error:'Tous les champs sont requis' });
    if (password.length < 8) return res.status(400).json({ error:'Mot de passe trop court (8 caractères min)' });
    const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
    if (existing) return res.status(409).json({ error:'Cet email est déjà utilisé' });

    let finalRole = 'closer', teamId = null;
    if (role === 'head_of_sales') {
      finalRole = 'head_of_sales';
    } else {
      if (!invite_code) return res.status(400).json({ error:"Un code d'invitation est requis" });
      const { data: invite } = await supabase.from('invite_codes')
        .select('*').eq('code', invite_code.toUpperCase()).eq('used', false).single();
      if (!invite) return res.status(400).json({ error:"Code d'invitation invalide ou déjà utilisé" });
      teamId = invite.team_id;
      await supabase.from('invite_codes').update({ used:true, used_at:new Date().toISOString() }).eq('id', invite.id);
    }

    const hashed = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase.from('users')
      .insert({ email, password:hashed, name, role:finalRole, team_id:teamId }).select().single();
    if (error) { console.error(error); return res.status(500).json({ error:'Erreur création compte' }); }

    const token = jwt.sign({ id:user.id, email:user.email, role:user.role, name:user.name }, JWT_SECRET, { expiresIn:'7d' });
    const gamification = await buildGamification(user.id);
    res.status(201).json({ token, user:{ id:user.id, email:user.email, name:user.name, role:user.role }, gamification });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error:'Email et mot de passe requis' });
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error:'Email ou mot de passe incorrect' });
    const token = jwt.sign({ id:user.id, email:user.email, role:user.role, name:user.name }, JWT_SECRET, { expiresIn:'7d' });
    const gamification = await buildGamification(user.id);
    res.json({ token, user:{ id:user.id, email:user.email, name:user.name, role:user.role }, gamification });
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
    await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${RESEND_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        from:'CloserDebrief <onboarding@resend.dev>', to:email,
        subject:'Réinitialisation de votre mot de passe',
        html:`<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto"><h2 style="color:#6366f1">CloserDebrief</h2><p>Bonjour ${user.name},</p><a href="${APP_URL}?reset_token=${resetToken}" style="display:inline-block;background:#6366f1;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">Réinitialiser mon mot de passe</a><p style="color:#94a3b8;font-size:12px;margin-top:24px">Ce lien expire dans 1 heure.</p></div>`
      })
    }).catch(console.error);
  }
  res.json({ success:true });
});

app.post('/api/auth/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Champs requis' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Mot de passe trop court' });
  const { data: user } = await supabase.from('users').select('password').eq('id', req.user.id).single();
  if (!user || !(await bcrypt.compare(currentPassword, user.password)))
    return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  const hashed = await bcrypt.hash(newPassword, 10);
  await supabase.from('users').update({ password: hashed }).eq('id', req.user.id);
  res.json({ success: true });
});


  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error:'Token et mot de passe requis' });
  if (password.length < 8) return res.status(400).json({ error:'Mot de passe trop court' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'reset') return res.status(400).json({ error:'Token invalide' });
    const hashed = await bcrypt.hash(password, 10);
    await supabase.from('users').update({ password:hashed }).eq('id', decoded.id);
    res.json({ success:true });
  } catch { return res.status(400).json({ error:'Token invalide ou expiré' }); }
});

// ─── DEBRIEFS ─────────────────────────────────────────────────────────────────
app.get('/api/debriefs', authenticate, async (req, res) => {
  try {
    let ids = [req.user.id];
    if (req.user.role === 'head_of_sales') {
      // HOS voit tous les debriefs de tous ses closers (toutes équipes)
      const { data: teams } = await supabase.from('teams').select('id').eq('owner_id', req.user.id);
      if (teams?.length) {
        const teamIds = teams.map(t => t.id);
        const { data: members } = await supabase.from('users').select('id').in('team_id', teamIds);
        ids = [...new Set([req.user.id, ...(members||[]).map(m=>m.id)])];
      }
    }
    const { data, error } = await supabase.from('debriefs').select('*').in('user_id', ids).order('call_date', { ascending:false });
    if (error) return res.status(500).json({ error:'Erreur récupération debriefs' });
    res.json(data);
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.get('/api/debriefs/:id', authenticate, async (req, res) => {
  const { data: debrief } = await supabase.from('debriefs').select('*').eq('id', req.params.id).single();
  if (!debrief) return res.status(404).json({ error:'Debrief introuvable' });
  if (req.user.role === 'closer' && debrief.user_id !== req.user.id)
    return res.status(403).json({ error:'Accès refusé' });
  res.json(debrief);
});

app.post('/api/debriefs', authenticate, async (req, res) => {
  try {
    const scores = computeSectionScores(req.body.sections);
    const { data: debrief, error } = await supabase.from('debriefs')
      .insert({ ...req.body, user_id:req.user.id, user_name:req.user.name, scores }).select().single();
    if (error) { console.error(error); return res.status(500).json({ error:'Erreur création debrief' }); }
    const gamification = await buildGamification(req.user.id);
    res.status(201).json({ debrief, gamification });
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

app.delete('/api/debriefs/:id', authenticate, async (req, res) => {
  const { data: debrief } = await supabase.from('debriefs').select('user_id').eq('id', req.params.id).single();
  if (!debrief) return res.status(404).json({ error:'Debrief introuvable' });
  if (req.user.role === 'closer' && debrief.user_id !== req.user.id)
    return res.status(403).json({ error:'Accès refusé' });
  await supabase.from('debriefs').delete().eq('id', req.params.id);
  const gamification = await buildGamification(req.user.id);
  res.json({ success:true, gamification });
});

// ─── GAMIFICATION ─────────────────────────────────────────────────────────────
app.get('/api/gamification/me', authenticate, async (req, res) => {
  res.json(await buildGamification(req.user.id));
});

app.get('/api/gamification/leaderboard', authenticate, async (req, res) => {
  const { data: users }      = await supabase.from('users').select('id,name,role');
  const { data: allDebriefs } = await supabase.from('debriefs').select('percentage,is_closed,user_id');
  if (!users || !allDebriefs) return res.json([]);
  const board = users.filter(u=>u.role!=='head_of_sales').map(u => {
    const ud = allDebriefs.filter(d=>d.user_id===u.id);
    const points   = ud.reduce((s,d)=>s+computePoints(d),0);
    const avgScore = ud.length>0 ? Math.round(ud.reduce((s,d)=>s+(d.percentage||0),0)/ud.length) : 0;
    return { id:u.id, name:u.name, points, level:computeLevel(points), avgScore, totalDebriefs:ud.length, closed:ud.filter(d=>d.is_closed).length };
  }).sort((a,b)=>b.points-a.points);
  res.json(board);
});

// ─── TEAMS (MULTI-ÉQUIPES) ────────────────────────────────────────────────────

// GET /api/teams — toutes les équipes du HOS avec membres + stats
app.get('/api/teams', authenticate, requireHOS, async (req, res) => {
  try {
    const { data: teams } = await supabase.from('teams').select('*')
      .eq('owner_id', req.user.id).order('created_at', { ascending:true });
    if (!teams?.length) return res.json([]);

    const teamIds  = teams.map(t=>t.id);
    const { data: allMembers }     = await supabase.from('users').select('id,name,email,role,created_at,team_id').in('team_id', teamIds);
    const memberIds = (allMembers||[]).map(m=>m.id);
    let allDebriefs = [];
    if (memberIds.length) {
      const { data } = await supabase.from('debriefs').select('*').in('user_id', memberIds);
      allDebriefs = data || [];
    }
    const { data: allCodes } = await supabase.from('invite_codes').select('*').in('team_id', teamIds).eq('used', false).order('created_at', { ascending:false });

    const result = teams.map(team => {
      const members    = (allMembers||[]).filter(m=>m.team_id===team.id).map(m=>buildMemberStats(m, allDebriefs));
      const inviteCodes = (allCodes||[]).filter(c=>c.team_id===team.id);
      return { ...team, members, inviteCodes };
    });
    res.json(result);
  } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
});

// POST /api/teams — créer une nouvelle équipe
app.post('/api/teams', authenticate, requireHOS, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error:'Nom requis' });
  const { data: team, error } = await supabase.from('teams')
    .insert({ name:name.trim(), owner_id:req.user.id }).select().single();
  if (error) { console.error(error); return res.status(500).json({ error:'Erreur création équipe' }); }
  res.status(201).json({ ...team, members:[], inviteCodes:[] });
});

// PATCH /api/teams/:id — renommer une équipe
app.patch('/api/teams/:id', authenticate, requireHOS, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error:'Nom requis' });
  const team = await assertTeamOwnership(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Équipe introuvable ou accès refusé' });
  const { data: updated } = await supabase.from('teams').update({ name:name.trim() }).eq('id', req.params.id).select().single();
  res.json(updated);
});

// DELETE /api/teams/:id — supprimer une équipe (libère les membres)
app.delete('/api/teams/:id', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwnership(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Équipe introuvable ou accès refusé' });
  // Libérer les membres avant suppression
  await supabase.from('users').update({ team_id:null }).eq('team_id', req.params.id);
  await supabase.from('invite_codes').delete().eq('team_id', req.params.id);
  await supabase.from('teams').delete().eq('id', req.params.id);
  res.json({ success:true });
});

// POST /api/teams/:id/invite — générer un code pour une équipe
app.post('/api/teams/:id/invite', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwnership(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Équipe introuvable ou accès refusé' });
  const code = generateInviteCode();
  const { data: invite, error } = await supabase.from('invite_codes')
    .insert({ code, team_id:req.params.id, created_by:req.user.id, used:false }).select().single();
  if (error) { console.error(error); return res.status(500).json({ error:'Erreur génération code' }); }
  res.json(invite);
});

// DELETE /api/teams/:id/invite/:codeId — supprimer un code
app.delete('/api/teams/:id/invite/:codeId', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwnership(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  await supabase.from('invite_codes').delete().eq('id', req.params.codeId).eq('team_id', req.params.id);
  res.json({ success:true });
});

// PATCH /api/teams/:id/members/:memberId — déplacer un membre vers cette équipe
app.patch('/api/teams/:id/members/:memberId', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwnership(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Équipe introuvable ou accès refusé' });
  // Vérifier que le membre est bien dans une équipe du HOS
  const { data: allTeams } = await supabase.from('teams').select('id').eq('owner_id', req.user.id);
  const teamIds = (allTeams||[]).map(t=>t.id);
  const { data: member } = await supabase.from('users').select('id,team_id').eq('id', req.params.memberId).single();
  if (!member || !teamIds.includes(member.team_id))
    return res.status(403).json({ error:'Membre introuvable ou accès refusé' });
  await supabase.from('users').update({ team_id:req.params.id }).eq('id', req.params.memberId);
  res.json({ success:true });
});

// DELETE /api/teams/:id/members/:memberId — retirer un membre
app.delete('/api/teams/:id/members/:memberId', authenticate, requireHOS, async (req, res) => {
  const team = await assertTeamOwnership(req.params.id, req.user.id);
  if (!team) return res.status(403).json({ error:'Accès refusé' });
  await supabase.from('users').update({ team_id:null }).eq('id', req.params.memberId).eq('team_id', req.params.id);
  res.json({ success:true });
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status:'ok', version:'7' }));

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ CloserDebrief API v7 — port ${PORT}`));
