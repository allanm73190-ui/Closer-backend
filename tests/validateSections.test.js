'use strict';
const { validateSections } = require('../lib/validateDebriefSections');

describe('validateSections', () => {
  it('retourne invalid si sections est une string', () => {
    const result = validateSections('bad');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/object/);
  });
  it('retourne invalid si une section est une string', () => {
    const result = validateSections({ prospect: 'bad' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/prospect/);
  });

  it('retourne valid pour un objet de sections correct', () => {
    const result = validateSections({ prospect: { q1: 'yes' }, pain_points: {} });
    expect(result.valid).toBe(true);
  });
});