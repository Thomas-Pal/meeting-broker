// server/index.ts
import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { v4 as uuid } from 'uuid';

// Uses your existing helper (typo kept intentionally)
import { getCalendarClient, type AuthMode } from './auth/calendarClient';

const app = express();
app.use(cors());
app.use(express.json());

// ---- Env ----
const {
  PORT = '8080',
  CALENDAR_ID,                 // calendar email/id to manage (user or resource)
  USE_MEET = 'auto',           // 'auto' | 'never' | 'force'
} = process.env;

// AUTH_MODE is whatever your helper expects; coerce the env to its type
//const AUTH_MODE = (process.env.AUTH_MODE || 'workload') as unknown as AuthMode;

const AUTH_MODE: AuthMode = ((): AuthMode => {
  const raw = String(process.env.AUTH_MODE || 'workload').toLowerCase();
  // adjust this list if your calendarCleint defines different modes
  const allowed = new Set<AuthMode>(['workload', 'adc', 'key', 'impersonate'] as unknown as AuthMode[]);
  return (allowed.has(raw as AuthMode) ? (raw as AuthMode) : ('workload' as AuthMode));
})();

if (!CALENDAR_ID) {
  console.error('❗ Missing env: CALENDAR_ID');
}

const WANT_MEET = String(USE_MEET || 'auto').toLowerCase(); // 'auto' | 'never' | 'force'

// ---- Health ----
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: process.uptime(), mode: 'CloudRun' });
});

// ---- Availability: busy blocks between start & end (ISO strings) ----
app.get('/api/availability', async (req: Request, res: Response) => {
  try {
    const start = String(req.query.start || '');
    const end   = String(req.query.end || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end (ISO) are required' });
    }

    const calendar = await getCalendarClient(AUTH_MODE);
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(start).toISOString(),
        timeMax: new Date(end).toISOString(),
        items: [{ id: CALENDAR_ID! }]
      }
    });

    const busy = (fb.data.calendars?.[String(CALENDAR_ID)]?.busy ?? []) as any[];
    res.json({ busy });
  } catch (e: any) {
    console.error('freebusy_failed:', e?.response?.data || e);
    res.status(500).json({ error: 'freebusy_failed' });
  }
});

// ---- Create booking (+ optional Google Meet) ----
// body: { start, end, email?, name?, mode?: 'virtual'|'inperson', location?: string }
app.post('/api/book', async (req: Request, res: Response) => {
  try {
    const { start, end, email, name } = (req.body || {}) as {
      start?: string; end?: string; email?: string; name?: string; mode?: string; location?: string;
    };

    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const calendar = await getCalendarClient(AUTH_MODE);

    const mode = String(req.body?.mode || 'virtual').toLowerCase() === 'inperson' ? 'inperson' : 'virtual';
    const locationInput = (req.body?.location || '').trim();
    const defaultLocation = 'Office / Gym';
    const finalLocation = mode === 'inperson' ? (locationInput || defaultLocation) : undefined;

    const displayName =
      (name && String(name).trim()) ||
      (email && String(email).split('@')[0]) ||
      'Client';

    const summary = `${displayName}: ${mode === 'virtual' ? 'Virtual Session' : 'In-Person Session'}`;
    const requestId = uuid();

    const baseBody: any = {
      summary,
      description: name
        ? `Booked by ${name}${email ? ` (${email})` : ''}`
        : `Booked via app${email ? ` (${email})` : ''}`,
      start: { dateTime: new Date(start).toISOString() },
      end:   { dateTime: new Date(end).toISOString() },
      ...(finalLocation ? { location: finalLocation } : {}),
      attendees: email ? [{ email, displayName: name || undefined }] : undefined,
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: false
    };

    const wantMeet = mode === 'virtual' && WANT_MEET !== 'never';
    const sendUpdates = baseBody.attendees ? 'all' : 'none';

    const insert = (body: any) => calendar.events.insert({
      calendarId: String(CALENDAR_ID),
      conferenceDataVersion: wantMeet ? 1 : 0,
      sendUpdates,
      requestBody: body
    });

    const patchWithMeet = (eventId: string) => calendar.events.patch({
      calendarId: String(CALENDAR_ID),
      eventId,
      conferenceDataVersion: 1,
      sendUpdates,
      requestBody: {
        conferenceData: {
          createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } }
        }
      }
    });

    let event: any, usedMeet = false;

    if (wantMeet) {
      try {
        // Try creating with Meet in one shot
        const r = await insert({
          ...baseBody,
          conferenceData: {
            createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } }
          }
        });
        event = r.data;
        usedMeet = true;
      } catch {
        // Fallback: create then patch Meet
        const r1 = await insert(baseBody);
        event = r1.data;
        try {
          const r2 = await patchWithMeet(event.id);
          event = r2.data;
          usedMeet = true;
        } catch (e2: any) {
          if (WANT_MEET === 'force') {
            const msg = e2?.response?.data?.error?.message || e2?.message || 'meet_creation_failed';
            return res.status(500).json({ error: 'booking_failed', details: msg });
          }
        }
      }
    } else {
      const r = await insert(baseBody);
      event = r.data;
    }

    const hangoutLink =
      event.hangoutLink ||
      (event.conferenceData?.entryPoints || []).find((x: any) => x?.entryPointType === 'video')?.uri ||
      null;

    res.json({
      ok: true,
      eventId: event.id,
      start: event.start?.dateTime || event.start?.date || start,
      end: event.end?.dateTime || event.end?.date || end,
      summary: event.summary,
      location: event.location || null,
      usedMeet,
      hangoutLink
    });
  } catch (e: any) {
    console.error('booking_failed:', e?.response?.data || e);
    res.status(500).json({ error: 'booking_failed', details: e?.message });
  }
});

// ---- List bookings (optionally filter by attendee email) ----
app.get('/api/bookings', async (req: Request, res: Response) => {
  try {
    const { email, maxResults = 50, timeMin, timeMax } = req.query as {
      email?: string; maxResults?: string | number; timeMin?: string; timeMax?: string;
    };

    const calendar = await getCalendarClient(AUTH_MODE);
    const now = new Date();
    const defaultMax = new Date(now.getTime() + 90 * 86400000);

    const r = await calendar.events.list({
      calendarId: String(CALENDAR_ID),
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: timeMin ? new Date(String(timeMin)).toISOString() : now.toISOString(),
      timeMax: timeMax ? new Date(String(timeMax)).toISOString() : defaultMax.toISOString(),
      maxResults: Number(maxResults),
    });

    let items = (r.data.items || []).filter(ev => ev.status !== 'cancelled');

    if (email) {
      const want = email.toLowerCase();
      items = items.filter(ev =>
        (ev.attendees || []).some(a => (a.email || '').toLowerCase() === want)
      );
    }

    const pickMeet = (ev: any) =>
      ev.hangoutLink ||
      (ev.conferenceData?.entryPoints || []).find((x: any) => x?.entryPointType === 'video')?.uri ||
      null;

    res.json({
      ok: true,
      events: items.map(ev => ({
        id: ev.id,
        start: ev.start?.dateTime || ev.start?.date,
        end: ev.end?.dateTime || ev.end?.date,
        status: ev.status,
        summary: ev.summary,
        location: ev.location || null,
        hangoutLink: pickMeet(ev),
        attendees: ev.attendees || [],
      })),
    });
  } catch (e: any) {
    console.error('list_bookings_failed:', e?.response?.data || e);
    res.status(500).json({ ok: false, error: 'list_bookings_failed' });
  }
});

// ---- Delete booking ----
app.delete('/api/book/:id', async (req: Request, res: Response) => {
  try {
    const calendar = await getCalendarClient(AUTH_MODE);
    await calendar.events.delete({
      calendarId: String(CALENDAR_ID),
      eventId: req.params.id,
      sendUpdates: 'all',
    });
    res.json({ ok: true });
  } catch (e: any) {
    console.error('cancel_failed:', e?.response?.data || e);
    res.status(500).json({ ok: false, error: 'cancel_failed' });
  }
});

// ---- Update booking time/location ----
app.patch('/api/book/:id', async (req: Request, res: Response) => {
  try {
    const { start, end, location } = (req.body || {}) as { start?: string; end?: string; location?: string };
    if (!start || !end) return res.status(400).json({ ok: false, error: 'start and end required' });

    const calendar = await getCalendarClient(AUTH_MODE);
    const updated = await calendar.events.patch({
      calendarId: String(CALENDAR_ID),
      eventId: req.params.id,
      sendUpdates: 'all',
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
  } catch (e: any) {
    console.error('amend_failed:', e?.response?.data || e);
    res.status(500).json({ ok: false, error: 'amend_failed' });
  }
});

// ---- Dev-only: list registered routes (remove if you like) ----
if (process.env.NODE_ENV !== 'production') {
  // @ts-ignore
  app.get('/__routes', (_req: Request, res: Response) => {
    // @ts-ignore
    const stack = (app as any)._router?.stack || [];
    const routes = stack
      .filter((l: any) => l.route)
      .map((l: any) => ({ methods: Object.keys(l.route.methods), path: l.route.path }));
    res.json(routes);
  });
}

// ---- Start ----
app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`API listening on :${PORT}`);
});
