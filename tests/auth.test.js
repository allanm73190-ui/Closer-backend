'use strict';
const request = require('supertest');

global.__supabaseMockUser = null;

jest.mock('@supabase/supabase-js', () => {
  function makeChain(leaf) {
    const chain = {
      then(resolve) { resolve({ data: global.__supabaseMockUser, error: null }); return Promise.resolve({ data: global.__supabaseMockUser, error: null }); },
      catch() { return this; },
      single: () => Promise.resolve({ data: global.__supabaseMockUser, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      select: () => makeChain(leaf), eq: () => makeChain(leaf), neq: () => makeChain(leaf),
      in: () => makeChain(leaf), order: () => makeChain(leaf), limit: () => makeChain(leaf),
      range: () => makeChain(leaf), insert: () => makeChain(leaf), update: () => makeChain(leaf),
      upsert: () => makeChain(leaf), delete: () => makeChain(leaf),
    };
    return chain;
  }
  return {
    createClient: () => ({
      from: () => makeChain(null),
      rpc: () => Promise.resolve({ data: null, error: null }),
    }),
  };
});

process.env.JWT_SECRET   = 'test-secret';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_KEY = 'fake-key';

let app;
beforeAll(() => { app = require('../server'); });
afterEach(() => { global.__supabaseMockUser = null; });

describe('Auth — routes protégées', () => {
  it('GET /api/debriefs sans token → 401', async () => {
    const res = await request(app).get('/api/debriefs');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('GET /api/debriefs avec token invalide → 401', async () => {
    const res = await request(app)
      .get('/api/debriefs')
      .set('Authorization', 'Bearer invalid.token.here');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it('POST /api/auth/login email manquant → 400', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'test' });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/login user inexistant → 401', async () => {
    global.__supabaseMockUser = null;
    const res = await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'test' });
    expect(res.status).toBe(401);
  });
});
