// src/index.ts

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
//import fetch from 'node-fetch';
import { google } from 'googleapis';
import { IAMCredentialsClient } from '@google-cloud/iam-credentials';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuid } from 'uuid';
import { parseStringPromise } from 'xml2js';

const app = express();
app.use(cors());
app.use(express.json());

/**
 * ============================
 * Environment variables
 * ============================
 */
const {
  PORT = 8080,
  CALENDAR_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_DELEGATED_USER,
  USE_DWD = 'false',
  USE_MEET = 'auto',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

const USE_DWD_BOOL = String(USE_DWD).toLowerCase() === 'true';
const USE_MEET_MODE = String(USE_MEET || 'auto').toLowerCase(); // auto | never | force

// Supabase client
export const supa =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

/**
 * ============================
 * Google Calendar auth (JWT)
 * ============================
 */
const jwtClient = new google.auth.JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/calendar'],
  subject: GOOGLE_DELEGATED_USER,
});
const calendar = google.calendar({ version: 'v3', auth: jwtClient });

/**
 * ============================
 * Helper: Token exchange via IAMCredentials
 * ============================
 */
type TokenResp = { access_token: string };

async function getUserAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    sub: GOOGLE_DELEGATED_USER,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const name = `projects/-/serviceAccounts/${GOOGLE_SERVICE_ACCOUNT_EMAIL}`;
  const iam = new IAMCredentialsClient();
  const [resp] = await iam.signJwt({ name, payload: JSON.stringify(payload) });
  if (!resp.signedJwt) throw new Error('signJwt returned empty token');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: resp.signedJwt,
    }),
  });

  if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
  const tokenJson = (await res.json()) as TokenResp;
  return tokenJson.access_token;
}

/**
 * ============================
 * Routes
 * ============================
 */

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Example: direct events creation endpoint
app.post('/events', async (req, res) => {
  try {
    const { summary, description, startISO, endISO, attendees = [] } = req.body;

    const accessToken = await getUserAccessToken();
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

    const c = google.calendar({ version: 'v3', auth });

    const event = {
      summary,
      description,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees,
      conferenceData: {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    };

    const { data } = await c.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      sendUpdates: 'all',
      requestBody: event,
    });

    const meetLink =
      data.hangoutLink ||
      data.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')?.uri;

    res.json({ eventId: data.id, htmlLink: data.htmlLink, meetLink });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * ============================
 * Supabase profile & logs
 * ============================
 */
app.post('/api/profile', async (req, res) => {
  try {
    if (!supa) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
    const { id, email, name, avatarUrl, provider } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });

    const { error } = await supa.from('users').upsert({
      id: String(id),
      email: email ?? null,
      name: name ?? null,
      avatar_url: avatarUrl ?? null,
      provider: provider ?? null,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;

    res.json({ ok: true });
  } catch (e) {
    console.error('profile_upsert_failed', e);
    res.status(500).json({ ok: false, error: 'profile_upsert_failed' });
  }
});

// similar handlers for logs, summaries, etc…

/**
 * ============================
 * Availability & Booking
 * ============================
 */
app.get('/api/availability', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(String(start)).toISOString(),
        timeMax: new Date(String(end)).toISOString(),
        items: [{ id: CALENDAR_ID! }],
      },
    });

    const busy = fb.data.calendars?.[CALENDAR_ID!] || {};
    res.json({ busy });
  } catch (e: any) {
    console.error('freebusy_failed', e);
    res.status(500).json({ error: 'freebusy_failed', details: e.message });
  }
});

app.post('/api/book', async (req, res) => {
  try {
    const { start, end, email, name } = req.body || {};
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const mode = String(req.body?.mode || 'virtual').toLowerCase();
    const summary = `${name || email || 'Client'}/Simon: ${
      mode === 'inperson' ? 'In Person Session' : 'Virtual Session'
    }`;
    const requestId = uuid();

    let created;
    try {
      const r = await calendar.events.insert({
        calendarId: CALENDAR_ID!,
        conferenceDataVersion: mode === 'virtual' ? 1 : 0,
        sendUpdates: 'all',
        requestBody: {
          summary,
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(end).toISOString() },
          attendees: email ? [{ email, displayName: name }] : [],
          conferenceData:
            mode === 'virtual'
              ? { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } }
              : undefined,
        },
      });
      created = r.data;
    } catch (err: any) {
      console.error('booking insert failed', err);
      return res.status(500).json({ error: 'booking_failed', details: err.message });
    }

    const pickMeet = (ev: any) =>
      ev?.hangoutLink ||
      (ev?.conferenceData?.entryPoints || []).find((x: any) => x?.entryPointType === 'video')?.uri ||
      null;

    res.json({
      ok: true,
      eventId: created.id,
      start: created.start?.dateTime || created.start?.date,
      end: created.end?.dateTime || created.end?.date,
      summary: created.summary,
      location: created.location || null,
      hangoutLink: pickMeet(created),
    });
  } catch (e: any) {
    res.status(500).json({ error: 'booking_failed', details: e.message });
  }
});

/**
 * ============================
 * YouTube feed (xml2js)
 * ============================
 */
app.get('/api/youtube', async (req, res) => {
  try {
    const { channelId } = req.query;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    if (!r.ok) return res.status(502).json({ error: 'youtube_fetch_failed' });

    const xml = await r.text();
    const parsed = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true });
    const entries = Array.isArray(parsed.feed.entry)
      ? parsed.feed.entry
      : parsed.feed.entry
      ? [parsed.feed.entry]
      : [];

    const videos = entries.map((e: any) => ({
      id: e['yt:videoId'],
      title: e.title,
      link: e.link?.href || `https://www.youtube.com/watch?v=${e['yt:videoId']}`,
      published: e.published,
      thumb:
        e['media:group']?.['media:thumbnail']?.url ||
        `https://i.ytimg.com/vi/${e['yt:videoId']}/hqdefault.jpg`,
    }));

    res.json({ videos });
  } catch (e: any) {
    console.error('youtube_parse_failed', e);
    res.status(500).json({ error: 'youtube_parse_failed', details: e.message });
  }
});

/**
 * ============================
 * Start server
 * ============================
 */
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
