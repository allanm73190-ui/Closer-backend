// ─────────────────────────────────────────────────────────────────────────────
// Debrief Quality v1 — fonction pure, déterministe
// Hypothèses :
//   - debrief.sections est un objet (peut être vide)
//   - debrief.section_notes est un objet de notes texte par section
//   - debrief.call_date est une date ISO (YYYY-MM-DD)
//   - debrief.submitted_at / created_at peuvent servir de référence "fraîcheur"
// Sortie :
//   { overall_quality_score: 0-100, breakdown: {...}, flags: [...] }
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_SECTIONS = ['decouverte', 'reformulation', 'projection', 'offre', 'closing'];
const FRESHNESS_GRACE_DAYS = 2;
const FRESHNESS_LATE_DAYS = 5;
const MIN_NOTE_CHARS = 40;
const SUSPICIOUS_REPEAT_THRESHOLD = 4;

function safeObj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function countAnsweredFields(section) {
  if (!section || typeof section !== 'object') return 0;
  let count = 0;
  for (const value of Object.values(section)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    count += 1;
  }
  return count;
}

function computeCompleteness(sections) {
  let totalAnswered = 0;
  let totalExpected = 0;
  const missing = [];
  for (const key of REQUIRED_SECTIONS) {
    const section = safeObj(sections[key]);
    const answered = countAnsweredFields(section);
    const expected = 3;
    totalAnswered += Math.min(answered, expected);
    totalExpected += expected;
    if (answered === 0) missing.push(key);
  }
  const ratio = totalExpected > 0 ? totalAnswered / totalExpected : 0;
  return { score: Math.round(ratio * 100), missing };
}

function diffDays(a, b) {
  const ms = a.getTime() - b.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function computeFreshness(callDate, submittedAt) {
  if (!callDate || !submittedAt) return { score: 80, lateDays: null };
  const call = new Date(callDate);
  const submit = new Date(submittedAt);
  if (Number.isNaN(call.getTime()) || Number.isNaN(submit.getTime())) {
    return { score: 80, lateDays: null };
  }
  const lateDays = Math.max(0, diffDays(submit, call));
  let score;
  if (lateDays <= FRESHNESS_GRACE_DAYS) score = 100;
  else if (lateDays <= FRESHNESS_LATE_DAYS) score = 70;
  else if (lateDays <= 10) score = 40;
  else score = 10;
  return { score, lateDays };
}

function computeDetail(sections, sectionNotes) {
  const notes = safeObj(sectionNotes);
  let totalChars = 0;
  let filledNotes = 0;
  for (const key of REQUIRED_SECTIONS) {
    const note = typeof notes[key] === 'string' ? notes[key].trim() : '';
    if (note.length >= MIN_NOTE_CHARS) filledNotes += 1;
    totalChars += note.length;
  }
  const charScore = Math.min(100, Math.round((totalChars / 400) * 100));
  const fillScore = Math.round((filledNotes / REQUIRED_SECTIONS.length) * 100);
  return { score: Math.round((charScore + fillScore) / 2), totalChars, filledNotes };
}

function computeConsistency(sections) {
  const allValues = [];
  for (const key of REQUIRED_SECTIONS) {
    const section = safeObj(sections[key]);
    for (const v of Object.values(section)) {
      if (typeof v === 'string') allValues.push(v);
    }
  }
  if (allValues.length === 0) return { score: 50, suspicious: false };
  const counts = allValues.reduce((acc, v) => {
    acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {});
  const maxRepeat = Math.max(...Object.values(counts));
  const ratio = maxRepeat / allValues.length;
  const suspicious = maxRepeat >= SUSPICIOUS_REPEAT_THRESHOLD && ratio > 0.75 && allValues.length <= 12;
  const score = suspicious ? 30 : 90;
  return { score, suspicious, maxRepeat };
}

function computeDebriefQuality(debrief = {}) {
  const sections = safeObj(debrief.sections);
  const sectionNotes = safeObj(debrief.section_notes);
  const submittedAt = debrief.submitted_at || debrief.created_at || new Date().toISOString();

  const completeness = computeCompleteness(sections);
  const freshness = computeFreshness(debrief.call_date, submittedAt);
  const detail = computeDetail(sections, sectionNotes);
  const consistency = computeConsistency(sections);

  const overall = Math.round(
    completeness.score * 0.4 +
    detail.score * 0.25 +
    freshness.score * 0.2 +
    consistency.score * 0.15
  );

  const flags = [];
  if (completeness.missing.length > 0) flags.push('missing_required_answers');
  if (detail.score < 40) flags.push('low_detail');
  if (freshness.lateDays !== null && freshness.lateDays > FRESHNESS_LATE_DAYS) flags.push('late_submission');
  if (consistency.suspicious) flags.push('suspicious_uniform_answers');

  return {
    overall_quality_score: overall,
    quality_flags: flags,
    quality_breakdown: {
      completeness_score: completeness.score,
      freshness_score: freshness.score,
      detail_score: detail.score,
      consistency_score: consistency.score,
      missing_sections: completeness.missing,
      late_days: freshness.lateDays,
    },
  };
}

module.exports = {
  computeDebriefQuality,
  _internals: {
    computeCompleteness,
    computeFreshness,
    computeDetail,
    computeConsistency,
  },
};
