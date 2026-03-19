// ─── CLOSER DEBRIEF — Backend Express + Supabase + JWT ───────────────────────
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
const SUPABASE_URL = 'https://vapqizmggnrarppmkdee.supabase.co';         // ex: https://abc.supabase.co
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhcHFpem1nZ25yYXJwcG1rZGVlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5MTI1MzAsImV4cCI6MjA4OTQ4ODUzMH0.9dOIMZPg-zhBYqHjd3T-1qiqHC4vOB4kgXPCqdxWUKE';     // commence par eyJ...
const JWT_SECRET   = 'Bonsoirpariscava';  // mets une phrase longue aléatoire
// ─────────────────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const PORT = process.env.PORT || 3001;

// ─── MIDDLEWARE AUTH ──────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }
  try {
    req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  }
  next();
}

// ─── AUTH : INSCRIPTION ───────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, mot de passe et nom requis' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
  }
  const { data: existing } = await supabase
    .from('users').select('id').eq('email', email).single();
  if (existing) {
    return res.status(409).json({ error: 'Cet email est déjà utilisé' });
  }
  const hashed = await bcrypt.hash(password, 10);
  const { data: user, error } = await supabase
    .from('users')
    .insert({ email, password: hashed, name, role: 'user' })
    .select()
    .single();
if (error) { console.log('ERREUR:', JSON.stringify(error)); return res.status(500).json({ error: error.message }); }  if (error) return res.status(500).json({ error: 'Erreur lors de la création du compte' });
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET, { expiresIn: '7d' }
  );
  res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// ─── AUTH : CONNEXION ─────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }
  const { data: user } = await supabase
    .from('users').select('*').eq('email', email).single();
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET, { expiresIn: '7d' }
  );
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// ─── AUTH : MON PROFIL ────────────────────────────────────────────────────────
app.get('/api/auth/me', authenticate, async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('id, email, name, role').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(user);
});

// ─── DEBRIEFS : LISTE ─────────────────────────────────────────────────────────
app.get('/api/debriefs', authenticate, async (req, res) => {
  let query = supabase.from('debriefs').select('*').order('call_date', { ascending: false });
  if (req.user.role !== 'admin') {
    query = query.eq('user_id', req.user.id);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Erreur lors de la récupération des debriefs' });
  res.json(data);
});

// ─── DEBRIEFS : DÉTAIL ────────────────────────────────────────────────────────
app.get('/api/debriefs/:id', authenticate, async (req, res) => {
  const { data: debrief } = await supabase
    .from('debriefs').select('*').eq('id', req.params.id).single();
  if (!debrief) return res.status(404).json({ error: 'Debrief introuvable' });
  if (req.user.role !== 'admin' && debrief.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  res.json(debrief);
});

// ─── DEBRIEFS : CRÉER ─────────────────────────────────────────────────────────
app.post('/api/debriefs', authenticate, async (req, res) => {
  const { data: debrief, error } = await supabase
    .from('debriefs')
    .insert({ ...req.body, user_id: req.user.id, user_name: req.user.name })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'Erreur lors de la création du debrief' });
  res.status(201).json(debrief);
});

// ─── DEBRIEFS : SUPPRIMER ────────────────────────────────────────────────────
app.delete('/api/debriefs/:id', authenticate, async (req, res) => {
  const { data: debrief } = await supabase
    .from('debriefs').select('user_id').eq('id', req.params.id).single();
  if (!debrief) return res.status(404).json({ error: 'Debrief introuvable' });
  if (req.user.role !== 'admin' && debrief.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  await supabase.from('debriefs').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ─── ADMIN : LISTE DES USERS ──────────────────────────────────────────────────
app.get('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  const { data } = await supabase
    .from('users').select('id, email, name, role, created_at');
  res.json(data);
});

// ─── ADMIN : CHANGER LE RÔLE ─────────────────────────────────────────────────
app.patch('/api/admin/users/:id/role', authenticate, requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide' });
  }
  const { data: user } = await supabase
    .from('users').update({ role }).eq('id', req.params.id).select().single();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(user);
});

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Closer Debrief API démarrée sur http://localhost:${PORT}`);
});
