'use strict';
// ─── Google Calendar Integration ─────────────────────────────────────────────
const { google } = require('googleapis');
const crypto = require('crypto');
const { encrypt, decrypt } = require('../lib/tokenCrypto');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

function buildOAuth2WithTokens(integration) {
  const oauth2 = makeOAuth2Client();
  const accessToken = decrypt(integration.google_access_token_enc) || integration.google_access_token;
  const refreshToken = decrypt(integration.google_refresh_token_enc) || integration.google_refresh_token;
  oauth2.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: integration.google_token_expiry
      ? new Date(integration.google_token_expiry).getTime()
      : null,
  });
  return { oauth2, accessToken, refreshToken };
}

function isoStartValue(startDate) {
  if (!startDate) return null;
  const parsed = new Date(startDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function followUpDateValue(startDate) {
  if (!startDate) return null;
  const iso = String(startDate);
  return iso.includes('T') ? iso.split('T')[0] : iso;
}

function buildCalendarNotes({ eventTitle, attendees, prospectEmail, description }) {
  return [
    'Source : Google Agenda',
    `Événement : ${eventTitle}`,
    prospectEmail ? `Email : ${prospectEmail}` : '',
    (attendees || []).length > 1 ? `Participants : ${(attendees || []).map(a => a.email).filter(Boolean).join(', ')}` : '',
    description ? `Description : ${String(description).slice(0, 300)}` : '',
  ].filter(Boolean).join('\n');
}

async function ensureCalendarLeadLink({ supabase, userId, eventId, dealId }) {
  const { data: existingLink } = await supabase
    .from('calendar_leads')
    .select('id,deal_id')
    .eq('user_id', userId)
    .eq('google_event_id', eventId)
    .maybeSingle();

  if (existingLink?.id) {
    if (dealId && !existingLink.deal_id) {
      await supabase
        .from('calendar_leads')
        .update({ deal_id: dealId })
        .eq('id', existingLink.id);
    }
    return existingLink;
  }

  await supabase.from('calendar_leads').insert({
    user_id: userId,
    google_event_id: eventId,
    deal_id: dealId || null,
  }).catch(() => {});
  return null;
}

async function subscribeCalendarWatch(userId, supabase) {
  const { data: integration } = await supabase
    .from('user_integrations')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (!integration) throw new Error('Integration not found');
  const { oauth2, refreshToken } = buildOAuth2WithTokens(integration);
  if (!refreshToken) throw new Error('No refresh token');

  oauth2.on('tokens', async (tokens) => {
    const update = { updated_at: new Date().toISOString() };
    if (tokens.access_token) {
      update.google_access_token = tokens.access_token;
      update.google_access_token_enc = encrypt(tokens.access_token);
    }
    if (tokens.expiry_date) {
      update.google_token_expiry = new Date(tokens.expiry_date).toISOString();
    }
    await supabase.from('user_integrations').update(update).eq('user_id', userId);
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2 });
  const channelId = crypto.randomUUID();
  const expiration = Date.now() + 6 * 24 * 60 * 60 * 1000;

  const { data: channel } = await calendar.events.watch({
    calendarId: 'primary',
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: `${process.env.BACKEND_URL}/api/webhooks/google-calendar`,
      expiration: String(expiration),
    },
  });

  // Get initial syncToken
  const { data: eventsData } = await calendar.events.list({
    calendarId: 'primary',
    maxResults: 1,
    showDeleted: false,
  });

  await supabase.from('user_integrations').update({
    gcal_channel_id: channel.id,
    gcal_resource_id: channel.resourceId,
    gcal_sync_token: eventsData.nextSyncToken || null,
    gcal_channel_expires_at: new Date(Number(channel.expiration)).toISOString(),
    gcal_watch_active: true,
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId);

  return channel;
}

module.exports = function registerIntegrationRoutes(app, { authenticate, supabase }) {

  // ── GET /api/integrations/google/auth — redirect to Google consent ──────────
  app.get('/api/integrations/google/auth', authenticate, (req, res) => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: 'Google OAuth non configuré' });
    }
    const oauth2 = makeOAuth2Client();
    const url = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state: req.user.id,
    });
    res.redirect(url);
  });

  // ── GET /api/integrations/google/callback — OAuth callback ──────────────────
  app.get('/api/integrations/google/callback', async (req, res) => {
    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://closerdebrief.vercel.app';
    try {
      const { code, state: userId, error } = req.query;
      if (error) return res.redirect(`${FRONTEND_URL}?gcal_error=${error}`);
      if (!code || !userId) return res.redirect(`${FRONTEND_URL}?gcal_error=missing_params`);

      const oauth2 = makeOAuth2Client();
      const { tokens } = await oauth2.getToken(code);

      await supabase.from('user_integrations').upsert({
        user_id:                   userId,
        google_access_token:       tokens.access_token,
        google_access_token_enc:   encrypt(tokens.access_token),
        google_refresh_token:      tokens.refresh_token || null,
        google_refresh_token_enc:  tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        google_token_expiry:       tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        gcal_sync_enabled:         true,
        updated_at:                new Date().toISOString(),
      }, { onConflict: 'user_id' });

      await syncCalendarForUser(userId, supabase);

      // Auto-subscribe Watch API
      try { await subscribeCalendarWatch(userId, supabase); } catch (_) {}

      res.redirect(`${FRONTEND_URL}?gcal_connected=1`);
    } catch (err) {
      res.redirect(`${process.env.FRONTEND_URL || 'https://closerdebrief.vercel.app'}?gcal_error=callback_failed`);
    }
  });

  // ── GET /api/integrations/google/status ─────────────────────────────────────
  app.get('/api/integrations/google/status', authenticate, async (req, res) => {
    try {
      const { data } = await supabase
        .from('user_integrations')
        .select('*')
        .eq('user_id', req.user.id)
        .maybeSingle();
      const hasRefresh = !!(
        (data?.google_refresh_token_enc && decrypt(data.google_refresh_token_enc)) ||
        data?.google_refresh_token
      );
      res.json({
        connected: hasRefresh,
        syncEnabled: data?.gcal_sync_enabled ?? false,
        lastSynced: data?.gcal_last_synced_at ?? null,
        watchActive: data?.gcal_watch_active ?? false,
        channelExpiresAt: data?.gcal_channel_expires_at ?? null,
      });
    } catch (_) {
      res.json({ connected: false, syncEnabled: false, lastSynced: null, watchActive: false, channelExpiresAt: null });
    }
  });

  // ── DELETE /api/integrations/google — disconnect ─────────────────────────────
  app.delete('/api/integrations/google', authenticate, async (req, res) => {
    const { data: integration } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (integration?.gcal_channel_id) {
      try {
        const { oauth2 } = buildOAuth2WithTokens(integration);
        const calendar = google.calendar({ version: 'v3', auth: oauth2 });
        await calendar.channels.stop({
          requestBody: {
            id: integration.gcal_channel_id,
            resourceId: integration.gcal_resource_id,
          },
        });
      } catch (_) {}
    }

    await supabase.from('user_integrations').delete().eq('user_id', req.user.id);
    res.json({ ok: true });
  });

  // ── POST /api/integrations/google/sync — manual sync ─────────────────────────
  app.post('/api/integrations/google/sync', authenticate, async (req, res) => {
    try {
      const created = await syncCalendarForUser(req.user.id, supabase);
      res.json({ ok: true, leadsCreated: created });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/integrations/google/preview — upcoming events (no import) ───────
  app.get('/api/integrations/google/preview', authenticate, async (req, res) => {
    try {
      const { data: integration } = await supabase
        .from('user_integrations')
        .select('*')
        .eq('user_id', req.user.id)
        .maybeSingle();

      const refreshToken = decrypt(integration?.google_refresh_token_enc) || integration?.google_refresh_token;
      if (!refreshToken) return res.json({ events: [] });

      const { oauth2 } = buildOAuth2WithTokens(integration);
      const calendar = google.calendar({ version: 'v3', auth: oauth2 });
      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const { data: gcalData } = await calendar.events.list({
        calendarId: integration.google_calendar_id || 'primary',
        timeMin, timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 30,
      });

      const { data: existing } = await supabase
        .from('calendar_leads')
        .select('google_event_id')
        .eq('user_id', req.user.id);
      const syncedIds = new Set((existing || []).map(r => r.google_event_id));

      const events = (gcalData.items || [])
        .filter(e => e.status !== 'cancelled' && e.summary)
        .map(e => {
          const attendees = (e.attendees || []).filter(a => !a.self);
          const startDate = e.start?.dateTime || e.start?.date;
          return {
            id: e.id,
            title: e.summary,
            start: startDate,
            attendees: attendees.map(a => ({ name: a.displayName || '', email: a.email })),
            alreadySynced: syncedIds.has(e.id),
          };
        });

      res.json({ events });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/integrations/google/import — import specific event as lead ──────
  app.post('/api/integrations/google/import', authenticate, async (req, res) => {
    const { eventId, title, start, attendees } = req.body || {};
    if (!eventId || !title) return res.status(400).json({ error: 'eventId and title required' });

    const { data: existing } = await supabase
      .from('calendar_leads')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('google_event_id', eventId)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: 'Déjà importé' });

    const { data: existingDeal } = await supabase
      .from('deals')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('google_event_id', eventId)
      .maybeSingle();
    if (existingDeal?.id) {
      await ensureCalendarLeadLink({ supabase, userId: req.user.id, eventId, dealId: existingDeal.id });
      return res.json({ ok: true, dealId: existingDeal.id, alreadyExisting: true });
    }

    const prospectName = (attendees && attendees[0]?.name) || (attendees && attendees[0]?.email?.split('@')[0]) || title;
    const primaryAttendee = (attendees || [])[0] || {};
    const notes = buildCalendarNotes({
      eventTitle: title,
      attendees: attendees || [],
      prospectEmail: primaryAttendee.email || '',
      description: '',
    });

    const { data: deal } = await supabase.from('deals').insert({
      user_id:       req.user.id,
      user_name:     req.user.name,
      prospect_name: prospectName,
      source:        'google_calendar',
      status:        'prospect',
      value:         0,
      notes,
      google_event_id: eventId,
      scheduled_at: isoStartValue(start),
      follow_up_date: followUpDateValue(start),
    }).select('id').single();

    await ensureCalendarLeadLink({ supabase, userId: req.user.id, eventId, dealId: deal?.id || null });

    res.json({ ok: true, dealId: deal?.id });
  });

  // ── POST /api/integrations/google/subscribe — activate Watch API ─────────────
  app.post('/api/integrations/google/subscribe', authenticate, async (req, res) => {
    try {
      const channel = await subscribeCalendarWatch(req.user.id, supabase);
      res.json({ ok: true, expiresAt: channel.expiration });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/integrations/google/renew-channel — renew before expiry ────────
  app.post('/api/integrations/google/renew-channel', authenticate, async (req, res) => {
    try {
      const { data: integration } = await supabase
        .from('user_integrations')
        .select('gcal_channel_expires_at, gcal_watch_active')
        .eq('user_id', req.user.id)
        .maybeSingle();

      if (!integration?.gcal_watch_active) {
        return res.json({ ok: false, reason: 'watch_not_active' });
      }

      const expiresAt = integration.gcal_channel_expires_at
        ? new Date(integration.gcal_channel_expires_at).getTime()
        : 0;
      const threshold = Date.now() + 24 * 60 * 60 * 1000;

      if (expiresAt > threshold) {
        return res.json({ ok: false, reason: 'not_expiring_soon', expiresAt: integration.gcal_channel_expires_at });
      }

      const channel = await subscribeCalendarWatch(req.user.id, supabase);
      res.json({ ok: true, expiresAt: channel.expiration });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/webhooks/google-calendar — webhook push receiver ───────────────
  // PUBLIC — no authenticate middleware
  app.post('/api/webhooks/google-calendar', async (req, res) => {
    // Always respond 200 immediately — Google requires fast response
    res.sendStatus(200);

    const channelId = req.headers['x-goog-channel-id'];
    const resourceState = req.headers['x-goog-resource-state'];
    if (!channelId || resourceState === 'sync') return;

    const { data: integration } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('gcal_channel_id', channelId)
      .maybeSingle();
    if (!integration) return;

    try {
      const { oauth2 } = buildOAuth2WithTokens(integration);

      oauth2.on('tokens', async (tokens) => {
        const update = { updated_at: new Date().toISOString() };
        if (tokens.access_token) {
          update.google_access_token = tokens.access_token;
          update.google_access_token_enc = encrypt(tokens.access_token);
        }
        if (tokens.expiry_date) {
          update.google_token_expiry = new Date(tokens.expiry_date).toISOString();
        }
        await supabase.from('user_integrations').update(update).eq('user_id', integration.user_id);
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2 });
      const listParams = {
        calendarId: 'primary',
        showDeleted: false,
        singleEvents: true,
      };
      if (integration.gcal_sync_token) {
        listParams.syncToken = integration.gcal_sync_token;
      } else {
        listParams.timeMin = new Date().toISOString();
        listParams.maxResults = 50;
      }

      let gcalData;
      try {
        const resp = await calendar.events.list(listParams);
        gcalData = resp.data;
      } catch (syncErr) {
        // syncToken expired — clear it and retry without
        if (syncErr?.code === 410) {
          await supabase.from('user_integrations')
            .update({ gcal_sync_token: null, updated_at: new Date().toISOString() })
            .eq('user_id', integration.user_id);
        }
        return;
      }

      const events = gcalData.items || [];

      // Update syncToken for next incremental sync
      if (gcalData.nextSyncToken) {
        await supabase.from('user_integrations')
          .update({ gcal_sync_token: gcalData.nextSyncToken, updated_at: new Date().toISOString() })
          .eq('user_id', integration.user_id);
      }

      // Load already-synced IDs
      const { data: existingSynced } = await supabase
        .from('calendar_leads')
        .select('google_event_id')
        .eq('user_id', integration.user_id);
      const syncedIds = new Set((existingSynced || []).map(r => r.google_event_id));

      for (const event of events) {
        if (event.status === 'cancelled') continue;

        const attendees = (event.attendees || []).filter(a => !a.self);
        if (attendees.length === 0) continue;

        const prospect = attendees[0];
        const prospectName  = prospect.displayName || prospect.email?.split('@')[0] || 'Prospect';
        const prospectEmail = prospect.email || '';
        const startDate     = event.start?.dateTime || event.start?.date;
        const eventTitle    = event.summary || 'Rendez-vous';
        const notes = buildCalendarNotes({
          eventTitle,
          attendees,
          prospectEmail,
          description: event.description || '',
        });

        const { data: existingDeal } = await supabase
          .from('deals')
          .select('id,status')
          .eq('user_id', integration.user_id)
          .eq('google_event_id', event.id)
          .maybeSingle();

        let dealId = existingDeal?.id || null;
        let created = false;
        if (dealId) {
          await supabase.from('deals')
            .update({
              prospect_name: prospectName,
              notes,
              scheduled_at: isoStartValue(startDate),
              follow_up_date: followUpDateValue(startDate),
              updated_at: new Date().toISOString(),
            })
            .eq('id', dealId);
        } else {
          const { data: deal } = await supabase.from('deals').insert({
            user_id: integration.user_id,
            prospect_name: prospectName,
            source: 'google_calendar',
            status: 'prospect',
            value: 0,
            notes,
            google_event_id: event.id,
            scheduled_at: isoStartValue(startDate),
            follow_up_date: followUpDateValue(startDate),
          }).select('id').single();
          dealId = deal?.id || null;
          created = !!dealId;
        }

        await ensureCalendarLeadLink({
          supabase,
          userId: integration.user_id,
          eventId: event.id,
          dealId,
        });

        if (created || !syncedIds.has(event.id)) {
          // In-app notification
          await supabase.from('notifications').insert({
            user_id: integration.user_id,
            type: 'gcal_lead',
            title: `Nouveau RDV importé : ${eventTitle}`,
            body: startDate
              ? `${prospectName} — ${new Date(startDate).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
              : prospectName,
            data: { dealId: dealId || null, eventId: event.id },
          });
        }

        syncedIds.add(event.id);
      }
    } catch (_) {
      // Silent — webhook errors should not crash the server
    }
  });

  // ── GET /api/notifications ───────────────────────────────────────────────────
  app.get('/api/notifications', authenticate, async (req, res) => {
    try {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(20);
      res.json(data || []);
    } catch (_) {
      res.json([]);
    }
  });

  // NOTE: read-all MUST be declared before :id/read to avoid Express capturing 'read-all' as an :id param
  app.patch('/api/notifications/read-all', authenticate, async (req, res) => {
    await supabase.from('notifications').update({ read: true })
      .eq('user_id', req.user.id).eq('read', false);
    res.json({ ok: true });
  });

  app.patch('/api/notifications/:id/read', authenticate, async (req, res) => {
    await supabase.from('notifications').update({ read: true })
      .eq('id', req.params.id).eq('user_id', req.user.id);
    res.json({ ok: true });
  });

};

// ─── Core sync function ───────────────────────────────────────────────────────
async function syncCalendarForUser(userId, supabase) {
  const { data: integration } = await supabase
    .from('user_integrations')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  const refreshToken = decrypt(integration?.google_refresh_token_enc) || integration?.google_refresh_token;
  if (!refreshToken) return 0;

  const { oauth2 } = buildOAuth2WithTokens(integration);

  oauth2.on('tokens', async (tokens) => {
    const update = { updated_at: new Date().toISOString() };
    if (tokens.access_token) {
      update.google_access_token = tokens.access_token;
      update.google_access_token_enc = encrypt(tokens.access_token);
    }
    if (tokens.expiry_date) {
      update.google_token_expiry = new Date(tokens.expiry_date).toISOString();
    }
    await supabase.from('user_integrations').update(update).eq('user_id', userId);
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2 });
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data: gcalData } = await calendar.events.list({
    calendarId: integration.google_calendar_id || 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });

  const events = gcalData.items || [];

  const { data: existingSynced } = await supabase
    .from('calendar_leads')
    .select('google_event_id')
    .eq('user_id', userId);
  const syncedIds = new Set((existingSynced || []).map(r => r.google_event_id));

  let leadsCreated = 0;

  for (const event of events) {
    const attendees = (event.attendees || []).filter(a => !a.self);
    if (attendees.length === 0) continue;

    const prospect = attendees[0];
    const prospectName  = prospect.displayName || prospect.email?.split('@')[0] || 'Prospect';
    const prospectEmail = prospect.email || '';
    const startDate     = event.start?.dateTime || event.start?.date;
    const eventTitle    = event.summary || 'Rendez-vous';
    const notes = buildCalendarNotes({
      eventTitle,
      attendees,
      prospectEmail,
      description: event.description || '',
    });

    const { data: existingDeal } = await supabase
      .from('deals')
      .select('id')
      .eq('user_id', userId)
      .eq('google_event_id', event.id)
      .maybeSingle();

    let deal = existingDeal || null;
    if (deal?.id) {
      await supabase.from('deals')
        .update({
          prospect_name: prospectName,
          notes,
          scheduled_at: isoStartValue(startDate),
          follow_up_date: followUpDateValue(startDate),
          updated_at: new Date().toISOString(),
        })
        .eq('id', deal.id)
        .catch(() => {});
    } else {
      try {
        const { data: d } = await supabase.from('deals').insert({
          user_id:        userId,
          prospect_name:  prospectName,
          source:         'google_calendar',
          status:         'prospect',
          value:          0,
          notes,
          google_event_id: event.id,
          scheduled_at: isoStartValue(startDate),
          follow_up_date: followUpDateValue(startDate),
        }).select('id').single();
        deal = d;
      } catch (_) {
        // Fallback: insert without new columns (migration not yet run)
        const { data: d } = await supabase.from('deals').insert({
          user_id:        userId,
          prospect_name:  prospectName,
          status:         'prospect',
          value:          0,
          notes,
          follow_up_date: followUpDateValue(startDate),
        }).select('id').single();
        deal = d;
      }
      if (deal?.id) leadsCreated++;
    }

    await ensureCalendarLeadLink({
      supabase,
      userId,
      eventId: event.id,
      dealId: deal?.id || null,
    });
    syncedIds.add(event.id);
  }

  await supabase.from('user_integrations')
    .update({ gcal_last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  return leadsCreated;
}

module.exports.syncCalendarForUser = syncCalendarForUser;
