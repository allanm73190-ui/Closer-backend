'use strict';
const request = require('supertest');
const jwt     = require('jsonwebtoken');

global.__debriefsMock = { data: [], count: 0 };

jest.mock('@supabase/supabase-js', () => {
  function makeChain(table) {
    const chain = {
      then(resolve) {
        const mock = global.__debriefsMock || { data: [], count: 0 };
        resolve({ data: mock.data, error: null, count: mock.count });
        return Promise.resolve({ data: mock.data, error: null, count: mock.count });
      },
      catch() { return this; },
      single:      () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      select:  () => makeChain(table),
      eq:      () => makeChain(table),
      neq:     () => makeChain(table),
      in:      () => makeChain(table),
      gt:      () => makeChain(table),
      gte:     () => makeChain(table),
      lte:     () => makeChain(table),
      order:   () => makeChain(table),
      limit:   () => makeChain(table),
      range:   () => makeChain(table),
      insert:  () => makeChain(table),
      update:  () => makeChain(table),
      upsert:  () => makeChain(table),
      delete:  () => makeChain(table),
    };
    return chain;
  }
  return {
    createClient: () => ({
      from: (table) => makeChain(table),
      rpc:  () => Promise.resolve({ data: null, error: null }),
    }),
  };
});

process.env.JWT_SECRET   = 'test-secret';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_KEY = 'fake-key';

let app;
beforeAll(() => { app = require('../server'); });
afterEach(() => { global.__debriefsMock = { data: [], count: 0 }; });

function makeToken(role = 'closer') {
  return jwt.sign(
    { id: 'u1', email: 'a@b.com', role, name: 'Test', team_id: null },
    'test-secret',
    { expiresIn: '1h' },
  );
}

describe('Pagination GET /api/debriefs', () => {

  it('sans paramètres → page=1 limit=20 par défaut', async () => {
    global.__debriefsMock = { data: [], count: 5 };
    const res = await request(app)
      .get('/api/debriefs')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 5 });
  });

    it('retourne { data, meta } avec page/limit explicites', async () => {
    global.__debriefsMock = { data: [{ id: 'd1' }, { id: 'd2' }], count: 42 };
    const res = await request(app)
      .get('/api/debriefs?page=1&limit=2')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toMatchObject({ page: 1, limit: 2, total: 42, pages: 21 });
  });

  it('limit clampée à 100 max', async () => {
    global.__debriefsMock = { data: [], count: 0 };
    const res = await request(app)
      .get('/api/debriefs?limit=999')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(100);
  });

});

describe('Pagination GET /api/deals', () => {
  it('retourne un tableau par défaut (compat legacy)', async () => {
    global.__debriefsMock = { data: [], count: 0 };
    const res = await request(app)
      .get('/api/deals?page=1&limit=5')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('retourne { data, meta } si meta=1', async () => {
    global.__debriefsMock = { data: [], count: 0 };
    const res = await request(app)
      .get('/api/deals?page=1&limit=5&meta=1')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toMatchObject({ page: 1, limit: 5 });
  });
});

describe('POST /api/debriefs — validation sections', () => {
  it('sections = string → 400', async () => {
    const res = await request(app)
      .post('/api/debriefs')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ sections: 'bad', prospect_name: 'Acme', call_date: '2026-04-08' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sections/);
  });
});
