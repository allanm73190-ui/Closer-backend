'use strict';
// Tests for notifications routes — ensures read-all is not captured by :id/read
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@supabase/supabase-js', () => {
  function makeChain() {
    const chain = {
      then(resolve) { resolve({ data: [], error: null }); return Promise.resolve({ data: [], error: null }); },
      catch() { return this; },
      single:      () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      select:  () => makeChain(),
      eq:      () => makeChain(),
      in:      () => makeChain(),
      order:   () => makeChain(),
      limit:   () => makeChain(),
      range:   () => makeChain(),
      insert:  () => makeChain(),
      update:  () => makeChain(),
      upsert:  () => makeChain(),
      delete:  () => makeChain(),
      not:     () => makeChain(),
    };
    return chain;
  }
  return {
    createClient: () => ({
      from: () => makeChain(),
      rpc: () => Promise.resolve({ data: null, error: null }),
    }),
  };
});

process.env.JWT_SECRET   = 'test-secret';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_KEY = 'fake-key';

let app;
beforeAll(() => { app = require('../server'); });

function makeToken(role = 'closer') {
  return jwt.sign({ id: 'u1', email: 'a@b.com', role, name: 'Test' }, 'test-secret', { expiresIn: '1h' });
}

describe('Notifications route order — read-all not captured by :id/read', () => {
  it('PATCH /api/notifications/read-all returns 200 with { ok: true }', async () => {
    const res = await request(app)
      .patch('/api/notifications/read-all')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });
});
