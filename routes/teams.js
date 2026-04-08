'use strict';
const supabase = require('../lib/supabase');

function normalizeRole(role) {
  const n = String(role||'').trim().toLowerCase();
  return n === 'admin' ? 'admin' : n === 'head_of_sales' ? 'head_of_sales' : 'closer';
}
function isAdminRole(role) { return normalizeRole(role) === 'admin'; }

module.exports = function registerTeamsRoutes(app, { authenticate, requireHOS, requireAdmin, assertTeamOwner, recordSecurityAudit }) {

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
  

};
