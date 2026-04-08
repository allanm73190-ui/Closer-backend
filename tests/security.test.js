'use strict';
const request = require('supertest');

global.__supabaseMockUser = null;

jest.mock('@supabase/supabase-js', () => {
  function makeChain(singleLeaf) {
    const chain = {
      then(resolve, reject) { resolve({ data: [], error: null, count: 0 }); return Promise.resolve({ data: [], error: null }); },
      catch() { return this; },
      single: () => Promise.resolve({ data: singleLeaf, error: null }),
      select:  () => makeChain(singleLeaf),
      eq:      () => makeChain(singleLeaf),
      neq:     () => makeChain(singleLeaf),
      in:      () => makeChain(singleLeaf),
      gt:      () => makeChain(singleLeaf),
      gte:     () => makeChain(singleLeaf),
      lte:     () => makeChain(singleLeaf),
      order:   () => makeChain(singleLeaf),
      limit:   () => makeChain(singleLeaf),
      range:   () => makeChain(singleLeaf),
      insert:  () => makeChain(singleLeaf),
      update:  () => makeChain(singleLeaf),
      upsert:  () => makeChain(singleLeaf),
      delete:  () => makeChain(singleLeaf),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    };
    return chain;
  }
  return {
    createClient: () => ({
      from: (table) => makeChain(table === 'users' ? global.__supabaseMockUser : null),
      rpc: () => Promise.resolve({ data: null, error: null }),
    }),
  };
});

process.env.JWT_SECRET           = 'test-secret';
process.env.SUPABASE_URL         = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-key';

let app;
beforeAll(() => { app = require('../server'); });
afterEach(() => { global.__supabaseMockUser = null; });

describe('CSP', () => {
  it('GET /api/health retourne un header Content-Security-Policy', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});

describe('Auth logout', () => {
  it('POST /api/auth/logout répond 200', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
  });
});

describe('CORS credentials', () => {
  it('OPTIONS /api/health avec Origin Vercel retourne Access-Control-Allow-Credentials: true', async () => {
    const res = await request(app)
      .options('/api/health')
      .set('Origin', 'https://closerdebrief.vercel.app')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('JWT cookie httpOnly', () => {
  it('POST /api/auth/login réussi → Set-Cookie cd_token avec httponly', async () => {
    const bcrypt = require('bcryptjs');
    const hashed = await bcrypt.hash('mypassword', 1);
    global.__supabaseMockUser = {
      id: 'u1', email: 'a@b.com', password: hashed,
      name: 'Test', role: 'closer', team_id: null,
      login_attempts: 0, locked_until: null,
    };
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.com', password: 'mypassword' });
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'];
    const tokenCookie = (Array.isArray(cookies) ? cookies : [cookies]).find(c => c.startsWith('cd_token'));
    expect(tokenCookie).toBeDefined();
    expect(tokenCookie.toLowerCase()).toContain('httponly');
  });
});
