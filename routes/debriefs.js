'use strict';
const supabase = require('../lib/supabase');

function fallbackDebriefQuality() {
  return {
    overall_quality_score: 0,
    quality_flags: [],
    quality_breakdown: {},
  };
}
function normalizeRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'admin') return 'admin';
  if (normalized === 'head_of_sales') return 'head_of_sales';
  return 'closer';
}

function parsePagination(query) {
  const page   = Math.max(1, parseInt(query.page)  || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}


module.exports = function register(app, {
  authenticate,
  requireHOS,
  requireAdmin,
  validateSections,
  canUserAccessOwnerData,
  buildGamification,
  invalidateGamCache,
  recordSecurityAudit,
  attachEffectiveRole,
  isAdminRole,
  isManagerRole,
  debriefQuality,
  FEATURE_DEBRIEF_QUALITY,
  FEATURE_MANAGER_COCKPIT,
  getHOSTeamMemberIds,
  computeDebriefTotals,
  computeSectionScores,
  sanitizeContactText,
  sanitizeContactDate,
  getUserWithEffectiveRole,
  getPipelineStatusContextForOwnerId,
  logEvent,
}) {
  const computeDebriefQuality = debriefQuality?.computeDebriefQuality || fallbackDebriefQuality;

  // ─── DEBRIEFS ─────────────────────────────────────────────────────────────────
  app.get('/api/debriefs', authenticate, async (req, res) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      if (isAdminRole(req.user.role)) {
        const { data, error, count } = await supabase.from('debriefs').select('*', { count: 'exact' }).order('call_date', { ascending:false }).range(offset, offset + limit - 1);
        if (error) return res.status(500).json({ error:'Erreur récupération' });
        return res.json({ data: data || [], meta: { total: count || 0, page, pages: Math.ceil((count || 0) / limit), limit } });
      }
      let ids = [req.user.id];
      if (normalizeRole(req.user.role) === 'head_of_sales') {
        const memberIds = await getHOSTeamMemberIds(req.user.id);
        ids = [...new Set([req.user.id, ...memberIds])];
      }
      const { data, error, count } = await supabase.from('debriefs').select('*', { count: 'exact' }).in('user_id', ids).order('call_date', { ascending:false }).range(offset, offset + limit - 1);
      if (error) return res.status(500).json({ error:'Erreur récupération' });
      res.json({ data: data || [], meta: { total: count || 0, page, pages: Math.ceil((count || 0) / limit), limit } });
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
      const raw = req.body || {};
      if (raw.sections !== undefined) {
        const sv = validateSections(raw.sections);
        if (!sv.valid) return res.status(400).json({ error: sv.error });
      }
      const sections = raw.sections && typeof raw.sections === 'object' ? raw.sections : {};
      const sectionNotes = raw.section_notes && typeof raw.section_notes === 'object' ? raw.section_notes : {};
      const totals = computeDebriefTotals(sections);
      const scores = computeSectionScores(sections);
  
      const prospectName = sanitizeContactText(raw.prospect_name, 220);
      if (!prospectName) return res.status(400).json({ error:'Nom du prospect requis' });
  
      const callDate = sanitizeContactDate(raw.call_date) || new Date().toISOString().slice(0, 10);
      const closerName = sanitizeContactText(raw.closer_name, 180);
      const callLink = sanitizeContactText(raw.call_link, 600) || null;
      const linkedDealId = typeof raw.linked_deal_id === 'string' ? raw.linked_deal_id.trim() : '';
      const notes = typeof raw.notes === 'string' ? raw.notes : '';
      const isClosed = typeof raw.is_closed === 'boolean' ? raw.is_closed : false;
      let linkedDeal = null;
      if (linkedDealId) {
        const { data: existingDeal, error: dealLookupError } = await supabase
          .from('deals')
          .select('id,user_id,user_name,status')
          .eq('id', linkedDealId)
          .single();
        if (!dealLookupError && existingDeal) {
          const canAccessLinkedDeal = await canUserAccessOwnerData(req.user, existingDeal.user_id);
          if (!canAccessLinkedDeal) {
            return res.status(403).json({ error:'Accès refusé' });
          }
          linkedDeal = existingDeal;
        }
      }
  
      const ownerUserId = linkedDeal?.user_id || req.user.id;
      let ownerUserName = linkedDeal?.user_name || req.user.name;
      if (ownerUserId !== req.user.id) {
        const ownerUser = await getUserWithEffectiveRole(ownerUserId);
        if (ownerUser?.name) ownerUserName = ownerUser.name;
      }
      const pipelineContext = await getPipelineStatusContextForOwnerId(ownerUserId);
  
      const submittedAt = new Date().toISOString();
  
      const payload = {
        user_id: ownerUserId,
        user_name: ownerUserName,
        prospect_name: prospectName,
        call_date: callDate,
        closer_name: closerName || ownerUserName,
        call_link: callLink,
        is_closed: isClosed,
        notes,
        sections,
        section_notes: sectionNotes,
        total_score: totals.total,
        max_score: totals.max,
        percentage: totals.percentage,
        scores,
      };
  
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
      if (error) {
        return res.status(500).json({ error:'Erreur création', detail:error.message || '' });
      }
  
      if (debrief) {
        logEvent('debrief_submitted', { debrief_id: debrief.id, user_id: ownerUserId, mode: payload.debrief_mode });
        if (FEATURE_DEBRIEF_QUALITY) {
          logEvent('debrief_quality_scored', { debrief_id: debrief.id, score: payload.overall_quality_score, flags: payload.quality_flags });
        }
      }
  
      let linkedExistingDeal = false;
      if (linkedDeal) {
        const existingStatus = typeof linkedDeal.status === 'string' ? linkedDeal.status : '';
        const existingIsClosed = pipelineContext.closedKeys.has(existingStatus);
        const nextStatus = isClosed
          ? pipelineContext.wonKey
          : (existingStatus && !existingIsClosed ? existingStatus : pipelineContext.openKey);
        const { error: linkError } = await supabase
          .from('deals')
          .update({
            debrief_id: debrief.id,
            prospect_name: prospectName,
            status: nextStatus,
            updated_at: new Date().toISOString(),
          })
          .eq('id', linkedDeal.id);
        linkedExistingDeal = !linkError;
      }
  
      if (!linkedExistingDeal && !linkedDeal) {
        // Auto-créer un deal pipeline si aucun lead existant n'a pu être lié
        await supabase.from('deals').insert({
          user_id: ownerUserId,
          user_name: ownerUserName,
          prospect_name: prospectName,
          source:'debrief',
          status:isClosed ? pipelineContext.wonKey : pipelineContext.openKey,
          debrief_id:debrief.id,
          value:0,
        });
      }
      invalidateGamCache(ownerUserId);
      res.status(201).json({ debrief, gamification:await buildGamification(ownerUserId) });
    } catch(err) {
      console.error(err);
      res.status(500).json({ error:'Erreur serveur' });
    }
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
  
      const nextProspectName = sanitizeContactText(payload.prospect_name ?? existing.prospect_name, 220);
      if (!nextProspectName) return res.status(400).json({ error:'Nom du prospect requis' });
      const nextCallDate = sanitizeContactDate(payload.call_date) || sanitizeContactDate(existing.call_date) || new Date().toISOString().slice(0, 10);
      const nextCloserName = sanitizeContactText(payload.closer_name ?? existing.closer_name, 180) || req.user.name;
      const nextCallLink = payload.call_link !== undefined
        ? (sanitizeContactText(payload.call_link, 600) || null)
        : (existing.call_link || null);
      const nextNotes = typeof payload.notes === 'string'
        ? payload.notes
        : (typeof existing.notes === 'string' ? existing.notes : '');
  
      const updateData = {
        prospect_name: nextProspectName,
        call_date: nextCallDate,
        closer_name: nextCloserName,
        call_link: nextCallLink,
        is_closed: typeof payload.is_closed === 'boolean' ? payload.is_closed : existing.is_closed,
        notes: nextNotes,
        sections: nextSections,
        section_notes: nextSectionNotes,
        total_score: totals.total,
        max_score: totals.max,
        percentage: totals.percentage,
        scores: sectionScores,
      };
  
      if (FEATURE_DEBRIEF_QUALITY) {
        const quality = computeDebriefQuality({
          sections: nextSections,
          section_notes: nextSectionNotes,
          call_date: nextCallDate,
          submitted_at: existing.submitted_at || existing.created_at || new Date().toISOString(),
        });
        updateData.overall_quality_score = quality.overall_quality_score;
        updateData.quality_flags = quality.quality_flags;
        updateData.quality_breakdown = quality.quality_breakdown;
      }
  
      const { data: updated, error: updateError } = await supabase
        .from('debriefs')
        .update(updateData)
        .eq('id', req.params.id)
        .select()
        .single();
      if (updateError || !updated) return res.status(500).json({ error:'Erreur mise à jour', detail:updateError?.message || '' });
  
      const pipelineContext = await getPipelineStatusContextForOwnerId(existing.user_id);
      const dealUpdateData = {
        prospect_name: updateData.prospect_name,
        updated_at: new Date().toISOString(),
      };
      if (updateData.is_closed) {
        dealUpdateData.status = pipelineContext.wonKey;
      } else if (existing.is_closed && !updateData.is_closed) {
        dealUpdateData.status = pipelineContext.openKey;
      }
  
      await supabase
        .from('deals')
        .update(dealUpdateData)
        .eq('debrief_id', existing.id);
  
      invalidateGamCache(existing.user_id);
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
      invalidateGamCache(debrief.user_id);
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
  

};
