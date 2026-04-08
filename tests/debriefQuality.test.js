// Run with: node --test tests/debriefQuality.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDebriefQuality } = require('../lib/debriefQuality');

test('debrief vide → score bas + flags missing/low_detail', () => {
  const r = computeDebriefQuality({ sections: {}, section_notes: {} });
  assert.ok(r.overall_quality_score < 40);
  assert.ok(r.quality_flags.includes('missing_required_answers'));
  assert.ok(r.quality_flags.includes('low_detail'));
});

test('debrief riche et frais → score haut, pas de flags graves', () => {
  const today = new Date().toISOString().slice(0, 10);
  const sections = {
    decouverte: { douleur_surface: 'oui', douleur_profonde: 'oui', temporalite: 'oui' },
    reformulation: { reformulation: 'oui', prospect_reconnu: 'oui', couches_reformulation: ['a'] },
    projection: { projection_posee: 'oui', qualite_reponse: 'forte', deadline_levier: 'oui' },
    offre: { colle_douleurs: 'oui', exemples_transformation: 'oui', duree_justifiee: 'oui' },
    closing: { annonce_prix: 'directe', silence_prix: 'oui', resultat_closing: 'close' },
  };
  const longNote = 'Note détaillée sur cette section avec beaucoup de contenu pertinent pour le coach.';
  const section_notes = {
    decouverte: longNote, reformulation: longNote, projection: longNote, offre: longNote, closing: longNote,
  };
  const r = computeDebriefQuality({ sections, section_notes, call_date: today, submitted_at: new Date().toISOString() });
  assert.ok(r.overall_quality_score >= 80, `score=${r.overall_quality_score}`);
  assert.deepEqual(r.quality_flags, []);
});

test('soumission tardive → flag late_submission', () => {
  const callDate = '2026-01-01';
  const submitted = '2026-01-15T10:00:00Z';
  const r = computeDebriefQuality({ sections: {}, section_notes: {}, call_date: callDate, submitted_at: submitted });
  assert.ok(r.quality_flags.includes('late_submission'));
  assert.equal(r.quality_breakdown.late_days, 14);
});

test('réponses uniformes baclées → flag suspicious_uniform_answers', () => {
  const sections = {
    decouverte: { a: 'non', b: 'non', c: 'non' },
    reformulation: { a: 'non', b: 'non' },
    projection: { a: 'non' },
    offre: { a: 'non', b: 'non' },
    closing: { a: 'non' },
  };
  const r = computeDebriefQuality({ sections, section_notes: {} });
  assert.ok(r.quality_flags.includes('suspicious_uniform_answers'));
});

test('breakdown contient les 4 dimensions', () => {
  const r = computeDebriefQuality({ sections: {}, section_notes: {} });
  for (const k of ['completeness_score', 'freshness_score', 'detail_score', 'consistency_score']) {
    assert.ok(typeof r.quality_breakdown[k] === 'number');
  }
});
