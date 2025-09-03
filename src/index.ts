import express from "express";
import { getCalendarClient } from "./googleCalendar";

const app = express();

// Basic health endpoints so Cloud Run sees a live service immediately.
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/ready", (_req, res) => res.status(200).send("ready"));

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "meeting-broker",
    status: "alive",
    timestamp: new Date().toISOString(),
  });
});

// Optional: quick list endpoint to prove Calendar auth works.
app.get("/cal/upcoming", async (req, res) => {
  try {
    const mode = (process.env.AUTH_MODE as any) || "workload";
    const calendarId = process.env.CALENDAR_ID || "primary";
    const calendar = await getCalendarClient(mode);

    const now = new Date();
    const result = await calendar.events.list({
      calendarId,
      timeMin: now.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 5,
    });

    res.status(200).json({
      calendarId,
      items: result.data.items ?? [],
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`meeting-broker listening on :${port}`);
});
