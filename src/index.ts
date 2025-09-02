import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import { IAMCredentialsClient } from "@google-cloud/iam-credentials";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL!;
const IMPERSONATE_USER = process.env.IMPERSONATE_USER!;
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

async function getUserAccessToken() {
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
  const { access_token } = await res.json();
  return access_token as string;
}

app.post("/events", async (req, res) => {
  try {
    const { summary, description, startISO, endISO, attendees = [] } = req.body;

    const accessToken = await getUserAccessToken();
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

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
      calendarId: "primary",
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: "all",
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
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 8080, () => console.log("meeting-broker up"));
