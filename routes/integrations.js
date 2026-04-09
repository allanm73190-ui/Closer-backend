'use strict';
// ─── Google Calendar Integration ─────────────────────────────────────────────
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI, // e.g. https://your-api.railway.app/api/integrations/google/callback
  );
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
      state: req.user.id,           // pass user id to callback
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
        user_id:             userId,
        google_access_token:  tokens.access_token,
        google_refresh_token: tokens.refresh_token || null,
        google_token_expiry:  tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        gcal_sync_enabled:   true,
        updated_at:          new Date().toISOString(),
      }, { onConflict: 'user_id' });

      // Trigger first sync immediately
      await syncCalendarForUser(userId, supabase);

      res.redirect(`${FRONTEND_URL}?gcal_connected=1`);
    } catch (err) {
      console.error('[GCal callback]', err);
      res.redirect(`${process.env.FRONTEND_URL || 'https://closerdebrief.vercel.app'}?gcal_error=callback_failed`);
    }
  });

  // ── GET /api/integrations/google/status — is Google connected? ──────────────
  app.get('/api/integrations/google/status', authenticate, async (req, res) => {
    const { data } = await supabase
      .from('user_integrations')
      .select('google_refresh_token, gcal_sync_enabled, gcal_last_synced_at')
      .eq('user_id', req.user.id)
      .maybeSingle();
    res.json({
      connected: !!(data?.google_refresh_token),
      syncEnabled: data?.gcal_sync_enabled ?? false,
      lastSynced: data?.gcal_last_synced_at ?? null,
    });
  });

  // ── DELETE /api/integrations/google — disconnect ─────────────────────────────
  app.delete('/api/integrations/google', authenticate, async (req, res) => {
    await supabase.from('user_integrations').delete().eq('user_id', req.user.id);
    res.json({ ok: true });
  });

  // ── POST /api/integrations/google/sync — manual sync ─────────────────────────
  app.post('/api/integrations/google/sync', authenticate, async (req, res) => {
    try {
      const created = await syncCalendarForUser(req.user.id, supabase);
      res.json({ ok: true, leadsCreated: created });
    } catch (err) {
      console.error('[GCal manual sync]', err);
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

      if (!integration?.google_refresh_token) {
        return res.json({ events: [] });
      }

      const oauth2 = makeOAuth2Client();
      oauth2.setCredentials({
        access_token:  integration.google_access_token,
        refresh_token: integration.google_refresh_token,
        expiry_date:   integration.google_token_expiry ? new Date(integration.google_token_expiry).getTime() : null,
      });

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

      // Load already-synced event IDs
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
            id:          e.id,
            title:       e.summary,
            start:       startDate,
            attendees:   attendees.map(a => ({ name: a.displayName || '', email: a.email })),
            alreadySynced: syncedIds.has(e.id),
          };
        });

      res.json({ events });
    } catch (err) {
      console.error('[GCal preview]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/integrations/google/import — import specific event as lead ──────
  app.post('/api/integrations/google/import', authenticate, async (req, res) => {
    const { eventId, title, start, attendees } = req.body || {};
    if (!eventId || !title) return res.status(400).json({ error: 'eventId and title required' });

    // Check not already synced
    const { data: existing } = await supabase
      .from('calendar_leads')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('google_event_id', eventId)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: 'Déjà importé' });

    const prospectName = (attendees && attendees[0]?.name) || (attendees && attendees[0]?.email?.split('@')[0]) || title;
    const notes = [
      'Source : Google Agenda',
      `Événement : ${title}`,
      ...(attendees || []).map(a => `Participant : ${a.name || ''} ${a.email || ''}`.trim()),
    ].join('\n');

    const { data: deal } = await supabase.from('deals').insert({
      user_id:       req.user.id,
      prospect_name: prospectName,
      source:        'google_calendar',
      status:        'prospect',
      value:         0,
      notes,
      follow_up_date: start ? start.split('T')[0] : null,
    }).select('id').single();

    await supabase.from('calendar_leads').insert({
      user_id:         req.user.id,
      google_event_id: eventId,
      deal_id:         deal?.id || null,
    });

    res.json({ ok: true, dealId: deal?.id });
  });
};

// ─── Core sync function (also called by background job) ──────────────────────
async function syncCalendarForUser(userId, supabase) {
  // 1. Load stored tokens
  const { data: integration } = await supabase
    .from('user_integrations')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (!integration?.google_refresh_token) return 0;

  // 2. Build authenticated client
  const oauth2 = makeOAuth2Client();
  oauth2.setCredentials({
    access_token:  integration.google_access_token,
    refresh_token: integration.google_refresh_token,
    expiry_date:   integration.google_token_expiry ? new Date(integration.google_token_expiry).getTime() : null,
  });

  // Refresh access token if needed and persist
  oauth2.on('tokens', async (tokens) => {
    const update = { updated_at: new Date().toISOString() };
    if (tokens.access_token) update.google_access_token = tokens.access_token;
    if (tokens.expiry_date)  update.google_token_expiry = new Date(tokens.expiry_date).toISOString();
    await supabase.from('user_integrations').update(update).eq('user_id', userId);
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2 });

  // 3. Fetch events from now to +14 days
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

  // 4. Load already-synced event IDs to avoid duplicates
  const { data: existingSynced } = await supabase
    .from('calendar_leads')
    .select('google_event_id')
    .eq('user_id', userId);
  const syncedIds = new Set((existingSynced || []).map(r => r.google_event_id));

  let leadsCreated = 0;

  for (const event of events) {
    if (syncedIds.has(event.id)) continue;

    // Import events with at least one other participant (skip personal/solo events)
    const attendees = (event.attendees || []).filter(a => !a.self);
    if (attendees.length === 0) continue;

    // Build prospect info from first external attendee
    const prospect = attendees[0];
    const prospectName  = prospect.displayName || prospect.email?.split('@')[0] || 'Prospect';
    const prospectEmail = prospect.email || '';
    const startDate     = event.start?.dateTime || event.start?.date;
    const eventTitle    = event.summary || 'Rendez-vous';
    const notes = [
      `Source : Google Agenda`,
      `Événement : ${eventTitle}`,
      prospectEmail ? `Email : ${prospectEmail}` : '',
      attendees.length > 1 ? `Participants : ${attendees.map(a => a.email).join(', ')}` : '',
      event.description ? `Description : ${event.description.slice(0, 300)}` : '',
    ].filter(Boolean).join('\n');

    // Create deal (lead)
    const { data: deal } = await supabase.from('deals').insert({
      user_id:        userId,
      prospect_name:  prospectName,
      source:         'google_calendar',
      status:         'prospect',
      value:          0,
      notes,
      follow_up_date: startDate ? startDate.split('T')[0] : null,
    }).select('id').single();

    // Mark as synced
    await supabase.from('calendar_leads').insert({
      user_id:         userId,
      google_event_id: event.id,
      deal_id:         deal?.id || null,
    });

    leadsCreated++;
  }

  // 5. Update last synced timestamp
  await supabase.from('user_integrations')
    .update({ gcal_last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  return leadsCreated;
}

module.exports.syncCalendarForUser = syncCalendarForUser;
