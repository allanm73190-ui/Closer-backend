'use strict';
const { google } = require('googleapis');
const { decrypt, encrypt } = require('./tokenCrypto');

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

async function renewExpiredChannels(supabase) {
  const threshold = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from('user_integrations')
    .select('*')
    .eq('gcal_watch_active', true)
    .lt('gcal_channel_expires_at', threshold);

  if (error || !rows || rows.length === 0) return;

  for (const integration of rows) {
    try {
      const accessToken = decrypt(integration.google_access_token_enc) || integration.google_access_token;
      const refreshToken = decrypt(integration.google_refresh_token_enc) || integration.google_refresh_token;
      if (!refreshToken) continue;

      const oauth2 = makeOAuth2Client();
      oauth2.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
        expiry_date: integration.google_token_expiry
          ? new Date(integration.google_token_expiry).getTime()
          : null,
      });

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
      const channelId = require('crypto').randomUUID();
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

      await supabase.from('user_integrations').update({
        gcal_channel_id: channel.id,
        gcal_resource_id: channel.resourceId,
        gcal_channel_expires_at: new Date(Number(channel.expiration)).toISOString(),
        gcal_watch_active: true,
        updated_at: new Date().toISOString(),
      }).eq('user_id', integration.user_id);
    } catch (_) {
      // Silent — individual failure should not block others
    }
  }
}

function startRenewalCron(supabase) {
  const INTERVAL = 60 * 60 * 1000; // every hour
  setInterval(() => {
    renewExpiredChannels(supabase).catch(() => {});
  }, INTERVAL);
}

module.exports = { startRenewalCron, renewExpiredChannels };
