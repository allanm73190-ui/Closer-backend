'use strict';
const request = require('supertest');
const jwt     = require('jsonwebtoken');

global.__rbacMock = { data: [], count: 0 };

jest.mock('@supabase/supabase-js', () => {
  function makeChain() {
    return {
      then(resolve) { const m = global.__rbacMock || { data: [], count: 0 }; resolve({ data: m.data, error: null, count: m.count }); return Promise.resolve({ data: m.data, error: null }); },
      catch() { return this; },
      single: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      select: () => makeChain(), eq: () => makeChain(), neq: () => makeChain(),
      in: () => makeChain(), order: () => makeChain(), limit: () => makeChain(),
      range: () => makeChain(), insert: () => makeChain(), update: () => makeChain(),
      upsert: () => makeChain(), delete: () => makeChain(),
    };
  }
  return { createClient: () => ({ from: () => makeChain(), rpc: () => Promise.resolve({ data: null, error: null }) }) };
});

process.env.JWT_SECRET   = 'test-secret';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_KEY = 'fake-key';

let app;
beforeAll(() => { app = require('../server'); });
afterEach(() => { global.__rbacMock = { data: [], count: 0 }; });

function token(role) {
  return jwt.sign({ id: 'u1', email: 'a@b.com', role, name: 'Test', team_id: null }, 'test-secret', { expiresIn: '1h' });
}

describe('RBAC — accès HOS uniquement', () => {
  it('GET /api/teams avec role closer → 403', async () => {
    const res = await request(app).get('/api/teams').set('Authorization', `Bearer ${token('closer')}`);
    expect(res.status).toBe(403);
  });

  it('GET /api/teams avec role head_of_sales → 200', async () => {
    const res = await request(app).get('/api/teams').set('Authorization', `Bearer ${token('head_of_sales')}`);
    expect(res.status).toBe(200);
  });

  it('GET /api/debriefs sans token → 401', async () => {
    const res = await request(app).get('/api/debriefs');
    expect(res.status).toBe(401);
  });

  it('GET /api/debriefs avec role closer → 200', async () => {
    const res = await request(app).get('/api/debriefs').set('Authorization', `Bearer ${token('closer')}`);
    expect(res.status).toBe(200);
  });
});
