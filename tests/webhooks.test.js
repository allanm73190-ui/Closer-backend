'use strict';
const request = require('supertest');
const crypto  = require('crypto');

// ─── Mock Supabase ────────────────────────────────────────────────────────────
jest.mock('@supabase/supabase-js', () => {
  function makeChain() {
    const chain = {
      then(resolve) {
        resolve({ data: global.__supabaseMock, error: null });
        return Promise.resolve({ data: global.__supabaseMock, error: null });
      },
      catch() { return this; },
      single:      () => Promise.resolve({ data: global.__supabaseMock, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      select:  () => makeChain(),
      eq:      () => makeChain(),
      insert:  () => makeChain(),
      update:  () => makeChain(),
      delete:  () => makeChain(),
    };
    return chain;
  }
  return {
    createClient: () => ({
      from: () => makeChain(),
      rpc:  () => Promise.resolve({ data: null, error: null }),
    }),
  };
});

process.env.JWT_SECRET   = 'test-secret';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_KEY = 'fake-key';

let app;
beforeAll(() => { app = require('../server'); });
beforeEach(() => { global.__supabaseMock = null; });

// ─── Calendly Webhook ─────────────────────────────────────────────────────────
describe('POST /api/webhooks/calendly', () => {
  const payload = {
    event: 'invitee.created',
    payload: {
      event_type: { name: 'Demo Call' },
      scheduled_event: {
        start_time: '2026-05-01T10:00:00Z',
        event_memberships: [{ user_email: 'closer@example.com' }],
      },
      invitee: { name: 'Prospect Doe', email: 'prospect@example.com' },
    },
  };

  it('returns 200 when no signing key configured', async () => {
    global.__supabaseMock = { id: 'u1', role: 'closer' };
    const res = await request(app)
      .post('/api/webhooks/calendly')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('ignores non-invitee.created events', async () => {
    const res = await request(app)
      .post('/api/webhooks/calendly')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ event: 'invitee.canceled', payload: {} }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects invalid HMAC signature when signing key is set', async () => {
    process.env.CALENDLY_SIGNING_KEY = 'test-signing-key';
    try {
      const res = await request(app)
        .post('/api/webhooks/calendly')
        .set('Content-Type', 'application/json')
        .set('calendly-webhook-signature', 't=12345,v1=0000000000000000000000000000000000000000000000000000000000000000')
        .send(JSON.stringify(payload));
      expect(res.status).toBe(403);
    } finally {
      delete process.env.CALENDLY_SIGNING_KEY;
    }
  });

  it('accepts valid HMAC signature when signing key is set', async () => {
    process.env.CALENDLY_SIGNING_KEY = 'test-signing-key';
    global.__supabaseMock = { id: 'u1', role: 'closer' };
    // Server pre-parses JSON then re-serializes for HMAC: use JSON.stringify(JSON.parse(body))
    const body = JSON.stringify(payload);
    const normalizedBody = JSON.stringify(JSON.parse(body));
    const t = Date.now().toString();
    const sig = crypto.createHmac('sha256', 'test-signing-key').update(`${t}.${normalizedBody}`).digest('hex');
    try {
      const res = await request(app)
        .post('/api/webhooks/calendly')
        .set('Content-Type', 'application/json')
        .set('calendly-webhook-signature', `t=${t},v1=${sig}`)
        .send(body);
      expect(res.status).toBe(200);
    } finally {
      delete process.env.CALENDLY_SIGNING_KEY;
    }
  });
});

// ─── Cookie-based Auth ────────────────────────────────────────────────────────
describe('Cookie-based authentication', () => {
  const jwt = require('jsonwebtoken');

  it('GET /api/auth/me with valid cookie returns user', async () => {
    global.__supabaseMock = { id: 'u1', email: 'a@b.com', name: 'Test', role: 'closer' };
    const token = jwt.sign({ id: 'u1', email: 'a@b.com', role: 'closer', name: 'Test' }, 'test-secret', { expiresIn: '1h' });
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `cd_token=${token}`);
    expect(res.status).toBe(200);
  });

  it('GET /api/auth/me without token returns 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/logout sets cleared cookie', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
