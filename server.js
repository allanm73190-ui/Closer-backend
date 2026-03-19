// ─── CLOSER DEBRIEF — Backend Express + Supabase + JWT + Resend ──────────────
// Pour lancer : node server.js

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ─── ⚙️ COLLE TES CLÉS ICI ───────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'COLLE_TON_URL_ICI';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'COLLE_TA_CLE_ANON_ICI';
const JWT_SECRET   = process.env.JWT_SECRET   || 'change-ce-secret-en-prod';
const RESEND_API_KEY = process.env.RESEND_API_KEY || 'COLLE_TA_CLE_RESEND_ICI';
const APP_URL      = process.env.APP_URL       || 'https://closer-frontend-mu.vercel.app';
// ─────────────────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const PORT = process.env.PORT || 3001;

// ─── GAMIFICATION ─────────────────────────────────────────────────────────────
function computePoints(debrief) {
  let pts = 0;
  pts += Math.round((debrief.percentage || 0) / 10); // 0-10 pts selon score
  if (debrief.is_closed) pts += 5;                   // +5 si closé
  if ((debrief.percentage || 0) >= 80) pts += 3;     // +3 si excellent
  if ((debrief.percentage || 0) >= 90) pts += 2;     // +2 bonus si parfait
  return pts;
}

function computeLevel(totalPoints) {
  if (totalPoints >= 500) return { name: 'Légende', icon: '👑', min: 500, next: null };
  if (totalPoints >= 200) return { name: 'Expert', icon: '💎', min: 200, next: 500 };
  if (totalPoints >= 100) return { name: 'Confirmé', icon: '🥇', min: 100, next: 200 };
  if (totalPoints >= 50)  return { name: 'Intermédiaire', icon: '🥈', min: 50, next: 100 };
  if (totalPoints >= 20)  return { name: 'Débutant+', icon: '🥉', min: 20, next: 50 };
  return { name: 'Débutant', icon: '🌱', min: 0, next: 20 };
}

function computeBadges(debriefs) {
  const badges = [];
  const total = debriefs.length;
  const closed = debriefs.filter(d => d.is_closed).length;
  const perfect = debriefs.filter(d => (d.percentage || 0) >= 90).length;
  const avgScore = total > 0 ? debriefs.reduce((s, d) => s + (d.percentage || 0), 0) / total : 0;

  if (total >= 1)   badges.push({ id: 'first', icon: '🎯', label: 'Premier debrief' });
  if (total >= 10)  badges.push({ id: 'ten', icon: '🔥', label: '10 debriefs' });
  if (total >= 50)  badges.push({ id: 'fifty', icon: '💪', label: '50 debriefs' });
  if (closed >= 1)  badges.push({ id: 'closer', icon: '✅', label: 'Premier closing' });
  if (closed >= 10) badges.push({ id: 'closer10', icon: '🏆', label: '10 closings' });
  if (perfect >= 1) badges.push({ id: 'perfect', icon: '⭐', label: 'Score parfait' });
  if (avgScore >= 80) badges.push({ id: 'consistent', icon: '📈', label: 'Régularité 80%+' });

  return badges;
}

// ─── MIDDLEWARE AUTH ──────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Token manquant' });
  try {
    req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  next();
}

// ─── AUTH : INSCRIPTION ───────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, mot de passe et nom requis' });
  if (password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });

  const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
  if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

  const hashed = await bcrypt.hash(password, 10);
  const { data: user, error } = await supabase.from('users')
    .insert({ email, password: hashed, name, role: 'user' }).select().single();
  if (error) return res.status(500).json({ error: 'Erreur lors de la création du compte' });

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// ─── AUTH : CONNEXION ─────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// ─── AUTH : MON PROFIL ────────────────────────────────────────────────────────
app.get('/api/auth/me', authenticate, async (req, res) => {
  const { data: user } = await supabase.from('users').select('id, email, name, role').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(user);
});

// ─── AUTH : MOT DE PASSE OUBLIÉ ───────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  const { data: user } = await supabase.from('users').select('id, name').eq('email', email).single();
  if (!user) return res.json({ success: true }); // Sécurité : ne pas révéler si l'email existe

  // Générer un token de reset valable 1 heure
  const resetToken = jwt.sign({ id: user.id, type: 'reset' }, JWT_SECRET, { expiresIn: '1h' });
  const resetUrl = `${APP_URL}?reset_token=${resetToken}`;

  // Envoyer l'email via Resend
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'CloserDebrief <onboarding@resend.dev>',
        to: email,
        subject: 'Réinitialisation de votre mot de passe',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
            <h2 style="color: #6366f1;">CloserDebrief</h2>
            <p>Bonjour ${user.name},</p>
            <p>Vous avez demandé la réinitialisation de votre mot de passe.</p>
            <a href="${resetUrl}" style="display:inline-block;background:#6366f1;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
              Réinitialiser mon mot de passe
            </a>
            <p style="color:#94a3b8;font-size:12px;margin-top:24px;">Ce lien expire dans 1 heure.</p>
          </div>
        `
      })
    });
  } catch (err) {
    console.error('Erreur envoi email:', err);
  }

  res.json({ success: true });
});

// ─── AUTH : RESET MOT DE PASSE ────────────────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token et mot de passe requis' });
  if (password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'reset') return res.status(400).json({ error: 'Token invalide' });

    const hashed = await bcrypt.hash(password, 10);
    await supabase.from('users').update({ password: hashed }).eq('id', decoded.id);
    res.json({ success: true });
  } catch {
    return res.status(400).json({ error: 'Token invalide ou expiré' });
  }
});

// ─── DEBRIEFS : LISTE ─────────────────────────────────────────────────────────
app.get('/api/debriefs', authenticate, async (req, res) => {
  let query = supabase.from('debriefs').select('*').order('call_date', { ascending: false });
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Erreur lors de la récupération des debriefs' });
  res.json(data);
});

// ─── DEBRIEFS : DÉTAIL ────────────────────────────────────────────────────────
app.get('/api/debriefs/:id', authenticate, async (req, res) => {
  const { data: debrief } = await supabase.from('debriefs').select('*').eq('id', req.params.id).single();
  if (!debrief) return res.status(404).json({ error: 'Debrief introuvable' });
  if (req.user.role !== 'admin' && debrief.user_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  res.json(debrief);
});

// ─── DEBRIEFS : CRÉER ─────────────────────────────────────────────────────────
app.post('/api/debriefs', authenticate, async (req, res) => {
  const { data: debrief, error } = await supabase.from('debriefs')
    .insert({ ...req.body, user_id: req.user.id, user_name: req.user.name }).select().single();
  if (error) return res.status(500).json({ error: 'Erreur lors de la création du debrief' });
  res.status(201).json(debrief);
});

// ─── DEBRIEFS : SUPPRIMER ────────────────────────────────────────────────────
app.delete('/api/debriefs/:id', authenticate, async (req, res) => {
  const { data: debrief } = await supabase.from('debriefs').select('user_id').eq('id', req.params.id).single();
  if (!debrief) return res.status(404).json({ error: 'Debrief introuvable' });
  if (req.user.role !== 'admin' && debrief.user_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  await supabase.from('debriefs').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ─── GAMIFICATION : MON PROFIL ────────────────────────────────────────────────
app.get('/api/gamification/me', authenticate, async (req, res) => {
  const { data: debriefs } = await supabase.from('debriefs').select('*').eq('user_id', req.user.id);
  if (!debriefs) return res.json({ points: 0, level: computeLevel(0), badges: [] });

  const totalPoints = debriefs.reduce((sum, d) => sum + computePoints(d), 0);
  const level = computeLevel(totalPoints);
  const badges = computeBadges(debriefs);

  res.json({ points: totalPoints, level, badges, totalDebriefs: debriefs.length });
});

// ─── GAMIFICATION : CLASSEMENT ────────────────────────────────────────────────
app.get('/api/gamification/leaderboard', authenticate, async (req, res) => {
  const { data: users } = await supabase.from('users').select('id, name, role');
  const { data: allDebriefs } = await supabase.from('debriefs').select('*');

  if (!users || !allDebriefs) return res.json([]);

  const leaderboard = users
    .filter(u => u.role !== 'admin')
    .map(u => {
      const userDebriefs = allDebriefs.filter(d => d.user_id === u.id);
      const points = userDebriefs.reduce((sum, d) => sum + computePoints(d), 0);
      const avgScore = userDebriefs.length > 0
        ? Math.round(userDebriefs.reduce((s, d) => s + (d.percentage || 0), 0) / userDebriefs.length)
        : 0;
      const closed = userDebriefs.filter(d => d.is_closed).length;
      return { id: u.id, name: u.name, points, level: computeLevel(points), avgScore, totalDebriefs: userDebriefs.length, closed };
    })
    .sort((a, b) => b.points - a.points);

  res.json(leaderboard);
});

// ─── ADMIN : DASHBOARD ÉQUIPE ─────────────────────────────────────────────────
app.get('/api/admin/team', authenticate, requireAdmin, async (req, res) => {
  const { data: users } = await supabase.from('users').select('id, name, email, role, created_at');
  const { data: allDebriefs } = await supabase.from('debriefs').select('*');

  if (!users || !allDebriefs) return res.json([]);

  const team = users
    .filter(u => u.role !== 'admin')
    .map(u => {
      const userDebriefs = allDebriefs.filter(d => d.user_id === u.id);
      const sorted = [...userDebriefs].sort((a, b) => new Date(a.call_date) - new Date(b.call_date));
      const points = userDebriefs.reduce((sum, d) => sum + computePoints(d), 0);
      const avgScore = userDebriefs.length > 0
        ? Math.round(userDebriefs.reduce((s, d) => s + (d.percentage || 0), 0) / userDebriefs.length)
        : 0;
      const closed = userDebriefs.filter(d => d.is_closed).length;
      const chartData = sorted.map(d => ({
        date: d.call_date,
        score: Math.round(d.percentage || 0),
        prospect: d.prospect_name
      }));
      return {
        id: u.id, name: u.name, email: u.email,
        points, level: computeLevel(points),
        avgScore, totalDebriefs: userDebriefs.length,
        closed, chartData,
        badges: computeBadges(userDebriefs)
      };
    });

  res.json(team);
});

// ─── ADMIN : LISTE USERS ──────────────────────────────────────────────────────
app.get('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  const { data } = await supabase.from('users').select('id, email, name, role, created_at');
  res.json(data);
});

// ─── ADMIN : CHANGER RÔLE ─────────────────────────────────────────────────────
app.patch('/api/admin/users/:id/role', authenticate, requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  const { data: user } = await supabase.from('users').update({ role }).eq('id', req.params.id).select().single();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(user);
});

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Closer Debrief API démarrée sur http://localhost:${PORT}`);
});
