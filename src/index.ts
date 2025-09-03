// // src/index.ts

// // import 'dotenv/config';
// import express from 'express';
// import cors from 'cors';
// import { google } from 'googleapis';
// import { IAMCredentialsClient } from '@google-cloud/iam-credentials';
// import { randomUUID } from 'crypto';
// import { createClient } from '@supabase/supabase-js';
// import { v4 as uuid } from 'uuid';
// import { parseStringPromise } from 'xml2js';

// // ──────────────────────────────────────────────────────────────────────────────
// // App setup
// // ──────────────────────────────────────────────────────────────────────────────
// const app = express();
// app.use(cors());
// app.use(express.json());

// // ──────────────────────────────────────────────────────────────────────────────
// /**
//  * Environment
//  *
//  * PORT                          – default 8080 for Cloud Run
//  * CALENDAR_ID                   – target Google Calendar (email or calendar id)
//  * GOOGLE_SERVICE_ACCOUNT_EMAIL  – SA email (e.g., bookings-bot@PROJECT.iam.gserviceaccount.com)
//  * GOOGLE_DELEGATED_USER         – primary user to impersonate for DWD (e.g., you@domain.com)
//  * USE_DWD                       – "true"/"false" (if true, invite attendee; requires DWD)
//  * USE_MEET                      – 'auto' | 'never' | 'force'
//  * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY – (optional) DB access for server
//  */
// // ──────────────────────────────────────────────────────────────────────────────
// const {
//   PORT = 8080,
//   CALENDAR_ID,
//   GOOGLE_SERVICE_ACCOUNT_EMAIL,
//   GOOGLE_DELEGATED_USER,
//   USE_DWD = 'false',
//   USE_MEET = 'auto',
//   SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY,
// } = process.env as Record<string, string | undefined>;

// const USE_DWD_BOOL = String(USE_DWD || 'false').toLowerCase() === 'true';
// const USE_MEET_MODE = String(USE_MEET || 'auto').toLowerCase(); // 'auto' | 'never' | 'force'

// // Supabase (server-side, no persisted auth)
// export const supa =
//   SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
//     ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
//     : null;

// // ──────────────────────────────────────────────────────────────────────────────
// // Keyless Domain-Wide Delegation helpers
// // (No GOOGLE_PRIVATE_KEY at boot; we sign a JWT via IAMCredentials per-request.)
// // ──────────────────────────────────────────────────────────────────────────────
// type TokenResp = { access_token: string };

// async function getUserAccessToken(): Promise<string> {
//   if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_DELEGATED_USER) {
//     throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_DELEGATED_USER');
//   }

//   const now = Math.floor(Date.now() / 1000);
//   const payload = {
//     iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
//     sub: GOOGLE_DELEGATED_USER,
//     scope: 'https://www.googleapis.com/auth/calendar',
//     aud: 'https://oauth2.googleapis.com/token',
//     iat: now,
//     exp: now + 3600,
//   };

//   const name = `projects/-/serviceAccounts/${GOOGLE_SERVICE_ACCOUNT_EMAIL}`;
//   const iam = new IAMCredentialsClient();
//   const [resp] = await iam.signJwt({ name, payload: JSON.stringify(payload) });
//   if (!resp.signedJwt) throw new Error('signJwt returned empty token');

//   const res = await fetch('https://oauth2.googleapis.com/token', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
//     body: new URLSearchParams({
//       grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
//       assertion: resp.signedJwt,
//     }),
//   });

//   if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
//   const tokenJson = (await res.json()) as TokenResp;
//   return tokenJson.access_token;
// }

// async function calendarClientForUser() {
//   const accessToken = await getUserAccessToken();
//   const auth = new google.auth.OAuth2();
//   auth.setCredentials({ access_token: accessToken });
//   return google.calendar({ version: 'v3', auth });
// }

// // ──────────────────────────────────────────────────────────────────────────────
// // Health
// // ──────────────────────────────────────────────────────────────────────────────
// app.get('/health', (_req, res) => {
//   res.json({ ok: true, uptime: process.uptime() });
// });

// // ──────────────────────────────────────────────────────────────────────────────
// // Supabase: profile + logs
// // ──────────────────────────────────────────────────────────────────────────────
// app.post('/api/profile', async (req, res) => {
//   try {
//     if (!supa) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
//     const { id, email, name, avatarUrl, provider } = req.body || {};
//     if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });

//     const { error } = await supa.from('users').upsert({
//       id: String(id),
//       email: email ?? null,
//       name: name ?? null,
//       avatar_url: avatarUrl ?? null,
//       provider: provider ?? null,
//       updated_at: new Date().toISOString(),
//     });
//     if (error) throw error;

//     res.json({ ok: true });
//   } catch (e) {
//     console.error('profile_upsert_failed', e);
//     res.status(500).json({ ok: false, error: 'profile_upsert_failed' });
//   }
// });

// app.post('/api/logs', async (req, res) => {
//   try {
//     if (!supa) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
//     const { userId, startedAt, durationMin, sessionId, title } = req.body || {};
//     if (!userId || !startedAt || !durationMin) {
//       return res.status(400).json({ ok: false, error: 'missing_fields' });
//     }

//     const { data, error } = await supa
//       .from('meditation_logs')
//       .insert({
//         user_id: String(userId),
//         started_at: new Date(startedAt).toISOString(),
//         duration_min: Number(durationMin),
//         session_id: sessionId ?? null,
//         title: title ?? null,
//         created_at: new Date().toISOString(),
//       })
//       .select('id')
//       .single();

//     if (error) throw error;
//     res.json({ ok: true, id: data?.id });
//   } catch (e) {
//     console.error('log_insert_failed', e);
//     res.status(500).json({ ok: false, error: 'log_insert_failed' });
//   }
// });

// app.get('/api/me/logs', async (req, res) => {
//   try {
//     if (!supa) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });

//     const userId = String(req.headers['x-user-id'] || req.query.userId || '');
//     if (!userId) return res.status(400).json({ ok: false, error: 'missing_user' });

//     const since = req.query.since
//       ? new Date(String(req.query.since))
//       : new Date(Date.now() - 30 * 86400000);

//     const { data, error } = await supa
//       .from('meditation_logs')
//       .select('id, started_at, duration_min, session_id, title')
//       .eq('user_id', userId)
//       .gte('started_at', since.toISOString())
//       .order('started_at', { ascending: false });

//     if (error) throw error;

//     res.json({
//       ok: true,
//       logs: (data || []).map((r: any) => ({
//         id: r.id?.toString() || String(r.started_at),
//         startedAt: r.started_at,
//         durationMin: r.duration_min,
//         sessionId: r.session_id,
//         title: r.title,
//       })),
//     });
//   } catch (e) {
//     console.error('me_logs_failed', e);
//     res.status(500).json({ ok: false, error: 'me_logs_failed' });
//   }
// });

// app.get('/api/me/summary', async (req, res) => {
//   try {
//     if (!supa) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });

//     const userId = String(req.headers['x-user-id'] || req.query.userId || '');
//     if (!userId) return res.status(400).json({ ok: false, error: 'missing_user' });

//     const weekStart = new Date();
//     weekStart.setDate(weekStart.getDate() - 6);
//     weekStart.setHours(0, 0, 0, 0);

//     const monthStart = new Date();
//     monthStart.setDate(1);
//     monthStart.setHours(0, 0, 0, 0);

//     const { data: weekData, error: e1 } = await supa
//       .from('meditation_logs')
//       .select('duration_min, started_at')
//       .eq('user_id', userId)
//       .gte('started_at', weekStart.toISOString());
//     if (e1) throw e1;

//     const weekMinutes = (weekData || []).reduce((a: number, r: any) => a + (r.duration_min || 0), 0);
//     const daysThisWeek = new Set((weekData || []).map((r: any) => new Date(r.started_at).toDateString())).size;

//     const { data: monthData, error: e2 } = await supa
//       .from('meditation_logs')
//       .select('duration_min, started_at')
//       .eq('user_id', userId)
//       .gte('started_at', monthStart.toISOString());
//     if (e2) throw e2;

//     const monthMinutes = (monthData || []).reduce((a: number, r: any) => a + (r.duration_min || 0), 0);
//     const sessionCount = (monthData || []).length;
//     const avgLength = sessionCount ? Math.round(monthMinutes / sessionCount) : 0;

//     res.json({
//       ok: true,
//       weekMinutes,
//       daysThisWeek,
//       month: { minutes: monthMinutes, count: sessionCount, avg: avgLength },
//     });
//   } catch (e) {
//     console.error('me_summary_failed', e);
//     res.status(500).json({ ok: false, error: 'me_summary_failed' });
//   }
// });

// // ──────────────────────────────────────────────────────────────────────────────
// // Availability (Google Calendar)
// // ──────────────────────────────────────────────────────────────────────────────
// app.get('/api/availability', async (req, res) => {
//   try {
//     if (!CALENDAR_ID) return res.status(500).json({ error: 'missing CALENDAR_ID' });

//     const { start, end } = req.query;
//     if (!start || !end) return res.status(400).json({ error: 'start and end (ISO) are required' });

//     const c = await calendarClientForUser();
//     const fb = await c.freebusy.query({
//       requestBody: {
//         timeMin: new Date(String(start)).toISOString(),
//         timeMax: new Date(String(end)).toISOString(),
//         items: [{ id: CALENDAR_ID }],
//       },
//     });

//     const busy = fb.data.calendars?.[CALENDAR_ID]?.busy || [];
//     res.json({ busy });
//   } catch (e: any) {
//     console.error('freebusy_failed:', e?.response?.data || e);
//     res.status(500).json({ error: 'freebusy_failed', details: e?.message });
//   }
// });

// // ──────────────────────────────────────────────────────────────────────────────
// // Create a booking (Calendar)
// // ──────────────────────────────────────────────────────────────────────────────
// app.post('/api/book', async (req, res) => {
//   try {
//     if (!CALENDAR_ID) return res.status(500).json({ error: 'missing CALENDAR_ID' });

//     const { start, end, email, name } = req.body || {};
//     if (!start || !end) return res.status(400).json({ error: 'start and end required' });

//     const mode = String(req.body?.mode || 'virtual').toLowerCase() === 'inperson' ? 'inperson' : 'virtual';
//     const locationInput = (req.body?.location || '').trim();
//     const defaultLocation = 'David Llyod Leeds';
//     const finalLocation = mode === 'inperson' ? (locationInput || defaultLocation) : undefined;

//     const displayName =
//       (name && String(name).trim()) ||
//       (email && String(email).split('@')[0]) ||
//       'Client';

//     const summary = `${displayName}/Simon: ${mode === 'virtual' ? 'Virtual Session' : 'In Person Session'}`;
//     const requestId = uuid();

//     const baseBody: any = {
//       summary,
//       description: name
//         ? `Booked by ${name}${email ? ` (${email})` : ''}`
//         : `Booked via app${email ? ` (${email})` : ''}`,
//       start: { dateTime: new Date(start).toISOString() },
//       end:   { dateTime: new Date(end).toISOString() },
//       ...(finalLocation ? { location: finalLocation } : {}),
//       guestsCanModify: false,
//       guestsCanInviteOthers: false,
//       guestsCanSeeOtherGuests: false,
//       ...(!USE_DWD_BOOL ? {
//         extendedProperties: {
//           private: {
//             userEmail: email || '',
//             userName: name || '',
//             bookingMode: mode,
//             bookingLocation: finalLocation || '',
//           },
//         },
//       } : {}),
//       attendees: USE_DWD_BOOL && email ? [{ email, displayName: name || undefined }] : undefined,
//     };

//     const sendUpdates: 'all' | 'none' = baseBody.attendees ? 'all' : 'none';
//     const wantMeet = mode === 'virtual' && USE_MEET_MODE !== 'never';

//     const c = await calendarClientForUser();

//     let event: any = null;
//     if (wantMeet) {
//       try {
//         const r = await c.events.insert({
//           calendarId: CALENDAR_ID,
//           conferenceDataVersion: 1,
//           sendUpdates,
//           requestBody: {
//             ...baseBody,
//             conferenceData: {
//               createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
//             },
//           },
//         });
//         event = r.data;
//       } catch (_e) {
//         // Insert without Meet, then try to patch Meet
//         const r1 = await c.events.insert({
//           calendarId: CALENDAR_ID,
//           conferenceDataVersion: 0,
//           sendUpdates,
//           requestBody: baseBody,
//         });
//         event = r1.data;

//         try {
//           const r2 = await c.events.patch({
//             calendarId: CALENDAR_ID,
//             eventId: event.id as string,
//             conferenceDataVersion: 1,
//             sendUpdates,
//             requestBody: {
//               conferenceData: {
//                 createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
//               },
//             },
//           });
//           event = r2.data;
//         } catch (e2: any) {
//           if (USE_MEET_MODE === 'force') {
//             const msg = e2?.response?.data?.error?.message || e2?.message || 'meet_creation_failed';
//             return res.status(500).json({ error: 'booking_failed', details: msg });
//           }
//         }
//       }
//     } else {
//       const r = await c.events.insert({
//         calendarId: CALENDAR_ID,
//         conferenceDataVersion: 0,
//         sendUpdates,
//         requestBody: baseBody,
//       });
//       event = r.data;
//     }

//     const pickMeet = (ev: any) =>
//       ev?.hangoutLink ||
//       (ev?.conferenceData?.entryPoints || []).find((x: any) => x?.entryPointType === 'video')?.uri ||
//       null;

//     res.json({
//       ok: true,
//       eventId: event.id,
//       start: event.start?.dateTime || event.start?.date || start,
//       end: event.end?.dateTime || event.end?.date || end,
//       summary: event.summary,
//       location: event.location || null,
//       usedMeet: Boolean(pickMeet(event)),
//       hangoutLink: pickMeet(event),
//     });
//   } catch (e: any) {
//     console.error('booking_failed:', e?.response?.data || e);
//     res.status(500).json({ error: 'booking_failed', details: e?.message });
//   }
// });

// // List bookings
// app.get('/api/bookings', async (req, res) => {
//   try {
//     if (!CALENDAR_ID) return res.status(500).json({ ok: false, error: 'missing CALENDAR_ID' });

//     const { email, maxResults = 50, timeMin, timeMax } = req.query as Record<string, string>;
//     const now = new Date();
//     const defaultMax = new Date(now.getTime() + 90 * 86400000);

//     const c = await calendarClientForUser();
//     const r = await c.events.list({
//       calendarId: CALENDAR_ID,
//       singleEvents: true,
//       orderBy: 'startTime',
//       timeMin: timeMin ? new Date(String(timeMin)).toISOString() : now.toISOString(),
//       timeMax: timeMax ? new Date(String(timeMax)).toISOString() : defaultMax.toISOString(),
//       maxResults: Number(maxResults),
//     });

//     let items: any[] = r.data.items || [];
//     items = items.filter((ev: any) => ev.status !== 'cancelled');

//     if (email) {
//       const want = String(email).toLowerCase();
//       items = items.filter((ev: any) => {
//         const attOk = (ev.attendees || []).some((a: any) => (a.email || '').toLowerCase() === want);
//         const extOk = String(ev.extendedProperties?.private?.userEmail || '').toLowerCase() === want;
//         return attOk || extOk;
//       });
//     }

//     const pickMeet = (ev: any) =>
//       ev.hangoutLink ||
//       (ev.conferenceData?.entryPoints || []).find((x: any) => x?.entryPointType === 'video')?.uri ||
//       null;

//     res.json({
//       ok: true,
//       events: items.map((ev: any) => ({
//         id: ev.id,
//         start: ev.start?.dateTime || ev.start?.date,
//         end: ev.end?.dateTime || ev.end?.date,
//         status: ev.status,
//         summary: ev.summary,
//         location: ev.location || null,
//         hangoutLink: pickMeet(ev),
//         attendees: ev.attendees || [],
//         userEmail: ev.extendedProperties?.private?.userEmail || null,
//         userName: ev.extendedProperties?.private?.userName || null,
//         bookingMode: ev.extendedProperties?.private?.bookingMode || (pickMeet(ev) ? 'virtual' : 'inperson'),
//       })),
//     });
//   } catch (e) {
//     console.error('list_bookings_failed:', (e as any)?.response?.data || e);
//     res.status(500).json({ ok: false, error: 'list_bookings_failed' });
//   }
// });

// // Cancel booking
// app.delete('/api/book/:id', async (req, res) => {
//   try {
//     if (!CALENDAR_ID) return res.status(500).json({ ok: false, error: 'missing CALENDAR_ID' });
//     const c = await calendarClientForUser();
//     await c.events.delete({
//       calendarId: CALENDAR_ID,
//       eventId: req.params.id,
//       sendUpdates: USE_DWD_BOOL ? 'all' : 'none',
//     });
//     res.json({ ok: true });
//   } catch (e) {
//     console.error('cancel_failed:', (e as any)?.response?.data || e);
//     res.status(500).json({ ok: false, error: 'cancel_failed' });
//   }
// });

// // Amend booking
// app.patch('/api/book/:id', async (req, res) => {
//   try {
//     if (!CALENDAR_ID) return res.status(500).json({ ok: false, error: 'missing CALENDAR_ID' });

//     const { start, end, location } = req.body || {};
//     if (!start || !end) return res.status(400).json({ ok: false, error: 'start and end required' });

//     const c = await calendarClientForUser();
//     const updated = await c.events.patch({
//       calendarId: CALENDAR_ID,
//       eventId: req.params.id,
//       sendUpdates: USE_DWD_BOOL ? 'all' : 'none',
//       requestBody: {
//         start: { dateTime: new Date(start).toISOString() },
//         end: { dateTime: new Date(end).toISOString() },
//         ...(typeof location === 'string' ? { location } : {}),
//       },
//     });

//     res.json({
//       ok: true,
//       eventId: updated.data.id,
//       start: updated.data.start?.dateTime || updated.data.start?.date,
//       end: updated.data.end?.dateTime || updated.data.end?.date,
//       location: updated.data.location || null,
//     });
//   } catch (e) {
//     console.error('amend_failed:', (e as any)?.response?.data || e);
//     res.status(500).json({ ok: false, error: 'amend_failed' });
//   }
// });

// // ──────────────────────────────────────────────────────────────────────────────
// // YouTube → JSON (channel feed via RSS/Atom)
// // ──────────────────────────────────────────────────────────────────────────────
// app.get('/api/youtube', async (req, res) => {
//   try {
//     const { channelId } = req.query as Record<string, string>;
//     if (!channelId) return res.status(400).json({ error: 'channelId required' });

//     const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
//     if (!r.ok) return res.status(502).json({ error: 'youtube_fetch_failed' });

//     const xml = await r.text();
//     const parsed: any = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true });
//     const entries = Array.isArray(parsed.feed?.entry)
//       ? parsed.feed.entry
//       : parsed.feed?.entry
//       ? [parsed.feed.entry]
//       : [];

//     const videos = entries.map((e: any) => ({
//       id: e['yt:videoId'],
//       title: e.title,
//       link: e.link?.href || `https://www.youtube.com/watch?v=${e['yt:videoId']}`,
//       published: e.published,
//       thumb:
//         e['media:group']?.['media:thumbnail']?.url ||
//         `https://i.ytimg.com/vi/${e['yt:videoId']}/hqdefault.jpg`,
//     }));

//     res.json({ videos });
//   } catch (e: any) {
//     console.error('youtube_parse_failed', e);
//     res.status(500).json({ error: 'youtube_parse_failed', details: e?.message });
//   }
// });

// // ──────────────────────────────────────────────────────────────────────────────
// // Start server (MUST listen on PORT for Cloud Run)
// // ──────────────────────────────────────────────────────────────────────────────
// const port = Number(process.env.PORT) || 8080;
// app.listen(port, () => {
//   console.log(`meeting-broker up on :${port}`);
// });


import express from "express";
import cors from "cors";
import { google } from "googleapis";
import { IAMCredentialsClient } from "@google-cloud/iam-credentials";
import { randomUUID } from "crypto";

// ---- Express setup ----
const app = express();
app.use(cors());
app.use(express.json());

// ---- Health check (Cloud Run will call this) ----
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ---- Config from env ----
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL!;
const IMPERSONATE_USER = process.env.IMPERSONATE_USER!;
const CALENDAR_ID = process.env.CALENDAR_ID!;
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

// ---- Helper: get user access token via DWD ----
async function getUserAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: SERVICE_ACCOUNT_EMAIL,
    sub: IMPERSONATE_USER,
    scope: SCOPES.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const name = `projects/-/serviceAccounts/${SERVICE_ACCOUNT_EMAIL}`;
  const iam = new IAMCredentialsClient();
  const [resp] = await iam.signJwt({ name, payload: JSON.stringify(payload) });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: resp.signedJwt!,
    }),
  });

  if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ---- Example route: create event ----
app.post("/events", async (req, res) => {
  try {
    const { summary, description, startISO, endISO, attendees = [] } = req.body;

    const token = await getUserAccessToken();
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: token });

    const calendar = google.calendar({ version: "v3", auth });

    const event = {
      summary,
      description,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees,
      conferenceData: {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    };

    const { data } = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      conferenceDataVersion: 1,
      sendUpdates: "all",
      requestBody: event,
    });

    res.json({
      eventId: data.id,
      htmlLink: data.htmlLink,
      meetLink:
        data.hangoutLink ||
        data.conferenceData?.entryPoints?.find(
          (e) => e.entryPointType === "video"
        )?.uri,
    });
  } catch (e: any) {
    console.error("event_create_failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

// ---- Boot the server ----
const port = Number(process.env.PORT) || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`[boot] meeting-broker listening on 0.0.0.0:${port}`);
  console.log("[boot] NODE_ENV =", process.env.NODE_ENV);
  console.log("[boot] SERVICE_ACCOUNT_EMAIL =", SERVICE_ACCOUNT_EMAIL);
  console.log("[boot] IMPERSONATE_USER =", IMPERSONATE_USER);
  console.log("[boot] CALENDAR_ID =", CALENDAR_ID);
});

export default app;
