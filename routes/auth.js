'use strict';
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const supabase = require('../lib/supabase');

module.exports = function registerAuthRoutes(app, {
  authLimiter, authenticate, setAuthCookie,
  JWT_SECRET, JWT_EXPIRES_IN,
  emailService, buildGamification,
  attachEffectiveRole, recordSecurityAudit,
  validatePasswordPolicy,
  getLoginState, registerLoginFailure, clearLoginFailures,
}) {

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
      setAuthCookie(res, token);
      res.status(201).json({ token, user:{ id:effectiveUser.id, email:effectiveUser.email, name:effectiveUser.name, role:effectiveUser.role }, gamification:await buildGamification(effectiveUser.id) });
    } catch(err) { console.error(err); res.status(500).json({ error:'Erreur serveur' }); }
  });
  
  app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email||!password) return res.status(400).json({ error:'Email et mot de passe requis' });
      const lockState = await getLoginState(email);
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
        const failureState = await registerLoginFailure(email);
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
      await clearLoginFailures(email);
      const token = jwt.sign({ id:user.id, email:user.email, role:user.role, name:user.name }, JWT_SECRET, { expiresIn:JWT_EXPIRES_IN });
      setAuthCookie(res, token);
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
    await emailService.sendPasswordReset({ to: email, name: user.name, resetToken });
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
  

};
