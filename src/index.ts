// server/index.js
// Load env locally (Cloud Run ignores this and uses service env)
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuid } from 'uuid';
import { parseStringPromise } from 'xml2js';
import { IAMCredentialsClient } from '@google-cloud/iam-credentials';
import { randomUUID } from 'crypto';

/**
 * ============================
 * Environment variables
 * ============================
 * PORT                       – API port (default 3000 for local dev)
 * SERVICE_ACCOUNT_EMAIL      – Cloud Run runtime SA (with DWD enabled)
 * IMPERSONATE_USER           – Workspace user to act as (email)
 * CALENDAR_ID                – 'primary' or a specific calendar id/email (default: 'primary')
 * USE_DWD                    – "true"/"false": whether to include attendees in events
 * USE_MEET                   – 'auto' | 'never' | 'force'
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 * YOUTUBE_API_KEY            – for /youtube/search (optional)
 */
const {
  PORT = 3000,
  SERVICE_ACCOUNT_EMAIL,
  IMPERSONATE_USER,
  CALENDAR_ID: CALENDAR_ID_RAW = 'primary',
  USE_DWD = 'true',
  USE_MEET = 'auto',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  YOUTUBE_API_KEY,
} = process.env;

const CALENDAR_ID = String(CALENDAR_ID_RAW || 'primary').trim();
const USE_DWD_BOOL = String(USE_DWD).toLowerCase() === 'true';
const USE_MEET_MODE = String(USE_MEET || 'auto').toLowerCase(); // 'auto' | 'never' | 'force'

/** ===== Express ===== */
const app = express();
app.use(cors());               // open CORS; tighten to your domain later
app.use(express.json());

/** Health check */
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

/** ===== Supabase (server-side) ===== */
export const supa =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

/** ===== Keyless DWD: delegated Calendar client ===== */
async function getDelegatedCalendar() {
  if (!SERVICE_ACCOUNT_EMAIL || !IMPERSONATE_USER) {
    throw new Error('Keyless DWD not configured (SERVICE_ACCOUNT_EMAIL, IMPERSONATE_USER)');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: SERVICE_ACCOUNT_EMAIL,
    sub: IMPERSONATE_USER,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const name = `projects/-/serviceAccounts/${SERVICE_ACCOUNT_EMAIL}`;
  const iam = new IAMCredentialsClient();
  const [resp] = await iam.signJwt({ name, payload: JSON.stringify(payload) });

  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: resp.signedJwt,
    }),
  });
  if (!tokRes.ok) throw new Error(`token exchange failed: ${await tokRes.text()}`);

  const { access_token } = await tokRes.json();
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token });
  return google.calendar({ version: 'v3', auth });
}

/* ============================================================
   Supabase-backed endpoints: profiles & logs
   ============================================================ */

/** Upsert user profile */
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

/** Insert a meditation log */
app.post('/api/logs', async (req, res) => {
  try {
    if (!supa) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
    const { userId, startedAt, durationMin, sessionId, title } = req.body || {};
    if (!userId || !startedAt || !durationMin) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const { data, error } = await supa
      .from('meditation_logs')
      .insert({
        user_id: String(userId),
        started_at: new Date(startedAt).toISOString(),
        duration_min: Number(durationMin),
        session_id: sessionId ?? null,
        title: title ?? null,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) throw error;
    res.json({ ok: true, id: data?.id });
  } catch (e) {
    console.error('log_insert_failed', e);
    res.status(500).json({ ok: false, error: 'log_insert_failed' });
  }
});

/** Return recent logs for a user */
app.get('/api/me/logs', async (req, res) => {
  try {
    if (!supa) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });

    const userId = String(req.headers['x-user-id'] || req.query.userId || '');
    if (!userId) return res.status(400).json({ ok: false, error: 'missing_user' });

    const since = req.query.since
      ? new Date(String(req.query.since))
      : new Date(Date.now() - 30 * 86400000); // last 30 days

    const { data, error } = await supa
      .from('meditation_logs')
      .select('id, started_at, duration_min, session_id, title')
      .eq('user_id', userId)
      .gte('started_at', since.toISOString())
      .order('started_at', { ascending: false });

    if (error) throw error;

    res.json({
      ok: true,
      logs: (data || []).map((r) => ({
        id: r.id?.toString() || String(r.started_at),
        startedAt: r.started_at,
        durationMin: r.duration_min,
        sessionId: r.session_id,
        title: r.title,
      })),
    });
  } catch (e) {
    console.error('me_logs_failed', e);
    res.status(500).json({ ok: false, error: 'me_logs_failed' });
  }
});

/** Weekly + monthly summary for user */
app.get('/api/me/summary', async (req, res) => {
  try {
    if (!supa) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });

    const userId = String(req.headers['x-user-id'] || req.query.userId || '');
    if (!userId) return res.status(400).json({ ok: false, error: 'missing_user' });

    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6); weekStart.setHours(0,0,0,0);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);

    const { data: weekData, error: e1 } = await supa
      .from('meditation_logs')
      .select('duration_min, started_at')
      .eq('user_id', userId)
      .gte('started_at', weekStart.toISOString());
    if (e1) throw e1;

    const weekMinutes = (weekData || []).reduce((a, r) => a + (r.duration_min || 0), 0);
    const daysThisWeek = new Set((weekData || []).map(r => new Date(r.started_at).toDateString())).size;

    const { data: monthData, error: e2 } = await supa
      .from('meditation_logs')
      .select('duration_min, started_at')
      .eq('user_id', userId)
      .gte('started_at', monthStart.toISOString());
    if (e2) throw e2;

    const monthMinutes = (monthData || []).reduce((a, r) => a + (r.duration_min || 0), 0);
    const sessionCount = (monthData || []).length;
    const avgLength = sessionCount ? Math.round(monthMinutes / sessionCount) : 0;

    res.json({
      ok: true,
      weekMinutes,
      daysThisWeek,
      month: { minutes: monthMinutes, count: sessionCount, avg: avgLength },
    });
  } catch (e) {
    console.error('me_summary_failed', e);
    res.status(500).json({ ok: false, error: 'me_summary_failed' });
  }
});

/* ============================================================
   Availability & Bookings (Calendar via keyless DWD)
   ============================================================ */

/** Availability (free/busy) */
app.get('/api/availability', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end (ISO) are required' });

    const calendar = await getDelegatedCalendar();
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(String(start)).toISOString(),
        timeMax: new Date(String(end)).toISOString(),
        items: [{ id: CALENDAR_ID }],
      },
    });

    const busy = fb.data.calendars?.[CALENDAR_ID]?.busy || [];
    res.json({ busy });
  } catch (e) {
    console.error('freebusy_failed:', e?.response?.data || e);
    res.status(500).json({ error: 'freebusy_failed' });
  }
});

/** Create a booking */
app.post('/api/book', async (req, res) => {
  try {
    const calendar = await getDelegatedCalendar();

    const { start, end, email, name } = req.body || {};
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const mode = String(req.body?.mode || 'virtual').toLowerCase() === 'inperson' ? 'inperson' : 'virtual';
    const locationInput = (req.body?.location || '').trim();
    const defaultLocation = 'David Llyod Leeds';
    const finalLocation = mode === 'inperson' ? (locationInput || defaultLocation) : undefined;

    const displayName =
      (name && String(name).trim()) ||
      (email && String(email).split('@')[0]) ||
      'Client';

    const summary = `${displayName}/Simon: ${mode === 'virtual' ? 'Virtual Session' : 'In Person Session'}`;
    const requestId = uuid();

    const baseBody = {
      summary,
      description: name
        ? `Booked by ${name}${email ? ` (${email})` : ''}`
        : `Booked via app${email ? ` (${email})` : ''}`,
      start: { dateTime: new Date(start).toISOString() },
      end:   { dateTime: new Date(end).toISOString() },
      ...(finalLocation ? { location: finalLocation } : {}),
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: false,
      ...(!USE_DWD_BOOL ? {
        extendedProperties: {
          private: {
            userEmail: email || '',
            userName: name || '',
            bookingMode: mode,
            bookingLocation: finalLocation || '',
          },
        },
      } : {}),
      attendees: USE_DWD_BOOL && email ? [{ email, displayName: name || undefined }] : undefined,
    };

    const sendUpdates = baseBody.attendees ? 'all' : 'none';
    const wantMeet = mode === 'virtual' && USE_MEET_MODE !== 'never';

    const insert = (body) => calendar.events.insert({
      calendarId: CALENDAR_ID,        // 'primary' unless you set a specific calendar
      conferenceDataVersion: wantMeet ? 1 : 0,
      sendUpdates,
      requestBody: body,
    });

    const patchWithMeet = (eventId) => calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      conferenceDataVersion: 1,
      sendUpdates,
      requestBody: {
        conferenceData: {
          createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
        },
      },
    });

    let event, usedMeet = false;

    if (wantMeet) {
      try {
        const r = await insert({
          ...baseBody,
          conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
        });
        event = r.data; usedMeet = true;
      } catch (e) {
        const r1 = await insert(baseBody);
        event = r1.data;
        try {
          const r2 = await patchWithMeet(event.id);
          event = r2.data; usedMeet = true;
        } catch (e2) {
          if (USE_MEET_MODE === 'force') {
            const msg = e2?.response?.data?.error?.message || e2?.message || 'meet_creation_failed';
            return res.status(500).json({ error: 'booking_failed', details: msg });
          }
        }
      }
    } else {
      const r = await insert(baseBody);
      event = r.data;
    }

    const pickMeet = (ev) =>
      ev.hangoutLink ||
      (ev.conferenceData?.entryPoints || []).find((x) => x?.entryPointType === 'video')?.uri ||
      null;

    res.json({
      ok: true,
      eventId: event.id,
      start: event.start?.dateTime || event.start?.date || start,
      end: event.end?.dateTime || event.end?.date || end,
      summary: event.summary,
      location: event.location || null,
      usedMeet,
      hangoutLink: pickMeet(event),
    });
  } catch (e) {
    console.error('booking_failed:', e?.response?.data || e);
    res.status(500).json({ error: 'booking_failed', details: e?.message });
  }
});

/** List bookings */
app.get('/api/bookings', async (req, res) => {
  try {
    const calendar = await getDelegatedCalendar();

    const { email, maxResults = 50, timeMin, timeMax } = req.query;

    const now = new Date();
    const defaultMax = new Date(now.getTime() + 90 * 86400000); // 90 days

    const r = await calendar.events.list({
      calendarId: CALENDAR_ID,
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: timeMin ? new Date(String(timeMin)).toISOString() : now.toISOString(),
      timeMax: timeMax ? new Date(String(timeMax)).toISOString() : defaultMax.toISOString(),
      maxResults: Number(maxResults),
    });

    let items = r.data.items || [];
    items = items.filter(ev => ev.status !== 'cancelled');

    if (email) {
      const want = String(email).toLowerCase();
      items = items.filter((ev) => {
        const attOk = (ev.attendees || []).some(a => (a.email || '').toLowerCase() === want);
        const extOk = String(ev.extendedProperties?.private?.userEmail || '').toLowerCase() === want;
        return attOk || extOk;
      });
    }

    const pickMeet = (ev) =>
      ev.hangoutLink ||
      (ev.conferenceData?.entryPoints || []).find((x) => x?.entryPointType === 'video')?.uri ||
      null;

    res.json({
      ok: true,
      events: items.map((ev) => ({
        id: ev.id,
        start: ev.start?.dateTime || ev.start?.date,
        end: ev.end?.dateTime || ev.end?.date,
        status: ev.status,
        summary: ev.summary,
        location: ev.location || null,
        hangoutLink: pickMeet(ev),
        attendees: ev.attendees || [],
        userEmail: ev.extendedProperties?.private?.userEmail || null,
        userName: ev.extendedProperties?.private?.userName || null,
        bookingMode: ev.extendedProperties?.private?.bookingMode || (pickMeet(ev) ? 'virtual' : 'inperson'),
      })),
    });
  } catch (e) {
    console.error('list_bookings_failed:', e?.response?.data || e);
    res.status(500).json({ ok: false, error: 'list_bookings_failed' });
  }
});

/** Cancel booking */
app.delete('/api/book/:id', async (req, res) => {
  try {
    const calendar = await getDelegatedCalendar();
    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId: req.params.id,
      sendUpdates: USE_DWD_BOOL ? 'all' : 'none',
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('cancel_failed:', e?.response?.data || e);
    res.status(500).json({ ok: false, error: 'cancel_failed' });
  }
});

/** Amend booking */
app.patch('/api/book/:id', async (req, res) => {
  try {
    const calendar = await getDelegatedCalendar();

    const { start, end, location } = req.body || {};
    if (!start || !end) return res.status(400).json({ ok: false, error: 'start and end required' });

    const updated = await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: req.params.id,
      sendUpdates: USE_DWD_BOOL ? 'all' : 'none',
      requestBody: {
        start: { dateTime: new Date(start).toISOString() },
        end:   { dateTime: new Date(end).toISOString() },
        ...(typeof location === 'string' ? { location } : {}),
      },
    });

    res.json({
      ok: true,
      eventId: updated.data.id,
      start: updated.data.start?.dateTime || updated.data.start?.date,
      end: updated.data.end?.dateTime || updated.data.end?.date,
      location: updated.data.location || null,
    });
  } catch (e) {
    console.error('amend_failed:', e?.response?.data || e);
    res.status(500).json({ ok: false, error: 'amend_failed' });
  }
});

/* ============================================================
   Extra endpoints
   ============================================================ */

/** Keyless DWD event creator on impersonated user's primary calendar */
app.post('/events', async (req, res) => {
  try {
    const { summary, description, startISO, endISO, attendees = [] } = req.body || {};
    if (!summary || !startISO || !endISO) {
      return res.status(400).json({ error: 'summary, startISO and endISO are required' });
    }

    const calendar = await getDelegatedCalendar();

    const event = {
      summary,
      description,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees,
      conferenceData: {
        createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    };

    const { data } = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all',
    });

    res.json({
      eventId: data.id,
      htmlLink: data.htmlLink,
      meetLink:
        data.hangoutLink ||
        data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri,
    });
  } catch (e) {
    console.error('events_create_failed', e?.response?.data || e);
    res.status(500).json({ error: 'events_create_failed', details: e?.message });
  }
});

/** YouTube → JSON (channel feed via RSS) */
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
      : parsed.feed.entry ? [parsed.feed.entry] : [];

    const videos = entries.map((e) => ({
      id: e['yt:videoId'],
      title: e.title,
      link: e.link?.href || `https://www.youtube.com/watch?v=${e['yt:videoId']}`,
      published: e.published,
      thumb: e['media:group']?.['media:thumbnail']?.url || `https://i.ytimg.com/vi/${e['yt:videoId']}/hqdefault.jpg`,
    }));

    res.json({ videos });
  } catch (e) {
    console.error('youtube_parse_failed', e);
    res.status(500).json({ error: 'youtube_parse_failed' });
  }
});

/** YouTube search via Data API v3 (optional) */
app.get('/youtube/search', async (req, res) => {
  try {
    if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YOUTUBE_API_KEY not configured' });
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.status(400).json({ error: 'q query param is required' });

    const maxResults = Math.min(25, Math.max(1, Number(req.query.maxResults ?? 10) || 10));
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('q', q);
    url.searchParams.set('maxResults', String(maxResults));
    url.searchParams.set('key', YOUTUBE_API_KEY);

    const r = await fetch(url.toString());
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();

    const items = (data.items || []).map((it) => ({
      videoId: it.id?.videoId,
      title: it.snippet?.title,
      description: it.snippet?.description,
      channelTitle: it.snippet?.channelTitle,
      publishedAt: it.snippet?.publishedAt,
      thumbnails: it.snippet?.thumbnails,
    }));

    res.json({ q, items });
  } catch (e) {
    console.error('youtube_search_failed', e);
    res.status(500).json({ error: 'youtube_search_failed' });
  }
});

/** ===== Start server (Cloud Run uses $PORT) ===== */
app.listen(Number(process.env.PORT || PORT), () =>
  console.log(`API listening on :${process.env.PORT || PORT} (calendar=${CALENDAR_ID}, dwd=${USE_DWD_BOOL}, meet=${USE_MEET_MODE})`)
);
