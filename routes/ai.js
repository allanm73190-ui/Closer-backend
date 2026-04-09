'use strict';
const supabase = require('../lib/supabase');

// AI routes — registered on the express app instance received via registerAiRoutes()
module.exports = function registerAiRoutes(app, { authenticate, requireHOS, aiLimiter, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_FALLBACK_MODELS, isAdminRole, getHOSTeamMemberIds, computePatternInsights, toStartOfDay, getDaysSince, canUserAccessOwnerData, computeSectionScores, getDebriefConfigScopeOwnerId, getActiveDebriefConfigSections, getActiveDebriefTemplateCatalog, sanitizePipelineKey, getSectionDataByKey, getSectionNotesByKey, scoreKeyFromSectionKey, formatAnswerFromQuestion, DEFAULT_DEBRIEF_SECTION_CONFIG }) {

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
  
  const AI_EXPORT_SUMMARY_SYSTEM_PROMPT = `Tu es un coach commercial expert en closing.
  Tu respectes strictement la demande utilisateur et les contraintes de format.
  Ta sortie doit être nette, crédible, et fidèle au texte source.`;
  
  const AI_EXPORT_SUMMARY_PROMPT_TEMPLATE = `Agis comme un coach commercial expert en closing et en analyse de calls.
  
  Je vais te donner un débrief de vente. Ta mission est d’en produire un résumé ultra-condensé de 5 à 6 lignes maximum, en ne gardant que les 20 % d’informations qui permettent de comprendre 80 % de l’analyse.
  
  Le résumé doit obligatoirement contenir :
  1. l’évaluation globale de la performance,
  2. ce qui a permis le closing,
  3. la faiblesse structurelle la plus importante,
  4. le risque que cette faiblesse crée sur des prospects plus difficiles,
  5. l’action prioritaire de coaching.
  
  Contraintes de sortie :
  - un seul bloc de texte
  - aucun bullet point
  - aucune redite
  - aucune formule vague
  - ton analytique, net et crédible
  - rester fidèle au texte source
  
  Voici le débrief :
  [COLLE ICI LE TEXTE]`;
  
  function sanitizeExportSummary(rawText) {
    const lines = String(rawText || '')
      .replace(/\r/g, '\n')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .split('\n')
      .map(line => line.trim())
      .map(line => line.replace(/^[-*•]\s+/, ''))
      .map(line => line.replace(/^\d+\s*[.)]\s+/, ''))
      .filter(Boolean);
  
    let merged = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (!merged) return '';
    if (merged.length > 1400) merged = `${merged.slice(0, 1397).trimEnd()}...`;
    return merged;
  }
  
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
  
  app.post('/api/ai/export-summary', authenticate, aiLimiter, async (req, res) => {
    try {
      if (!ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée' });
      }
  
      const sourceText = String(req.body?.source_text || '').trim();
      if (!sourceText) {
        return res.status(400).json({ error: 'source_text requis' });
      }
  
      const clippedSource = sourceText.slice(0, 18000);
      const userPrompt = AI_EXPORT_SUMMARY_PROMPT_TEMPLATE.replace('[COLLE ICI LE TEXTE]', clippedSource);
  
      const aiResult = await callAnthropicWithFallback(AI_EXPORT_SUMMARY_SYSTEM_PROMPT, userPrompt);
      if (!aiResult.ok) {
        console.error('Anthropic export summary error:', aiResult);
        return res.status(aiResult.status || 502).json({
          error: 'Erreur API IA',
          detail: aiResult.message,
          model: aiResult.modelTried,
        });
      }
  
      const summary = sanitizeExportSummary(aiResult.analysis);
      if (!summary) {
        return res.status(502).json({ error: 'Résumé IA vide' });
      }
  
      return res.json({
        summary,
        model: aiResult.modelUsed || null,
      });
    } catch (err) {
      console.error('AI export summary error:', err);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
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
  

};
