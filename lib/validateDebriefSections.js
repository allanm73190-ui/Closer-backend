'use strict';

function validateSections(sections) {
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
    return { valid: false, error: 'sections must be an object' };
  }
  for (const key of Object.keys(sections)) {
    if (typeof sections[key] !== 'object' || Array.isArray(sections[key])) {
      return { valid: false, error: `sections.${key} must be an object` };
    }
  }
  return { valid: true };
}

module.exports = { validateSections };
