// server/auth/calendarClient.ts
import { google, calendar_v3 } from 'googleapis';

export type AuthMode = 'keyless-dwd' | 'adc' | 'key';

export async function getCalendarClient(mode: AuthMode = 'keyless-dwd'): Promise<calendar_v3.Calendar> {
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const delegatedUser = process.env.GOOGLE_DELEGATED_USER || '';
  const dwdSaEmail = process.env.DWD_SA_EMAIL || '';

  // If a legacy key was ever provided, honor it (not used in your setup).
  const rawJson =
    process.env.GOOGLE_CREDENTIALS ||
    (process.env.GOOGLE_CREDENTIALS_B64
      ? Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')
      : undefined);

  if (rawJson) {
    const creds = JSON.parse(rawJson);
    const { JWT } = await import('google-auth-library');
    let key = String(creds.private_key || '');
    if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
    const jwt = new JWT({
      email: creds.client_email,
      key,
      scopes,
      subject: delegatedUser || undefined,
    });
    return google.calendar({ version: 'v3', auth: jwt });
  }

  // --- Keyless DWD path (recommended) ---
  if (dwdSaEmail && delegatedUser) {
    // Ensure the IAMCredentials API client uses ADC (Cloud Run SA).
    const iam = google.iamcredentials('v1');
    const name = `projects/-/serviceAccounts/${dwdSaEmail}`;

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: dwdSaEmail,
      scope: scopes.join(' '),
      aud: 'https://oauth2.googleapis.com/token',
      sub: delegatedUser,
      iat: now,
      exp: now + 3600,
    };

    // Ask IAM to sign the JWT on behalf of the DWD SA (no private key in app).
    const { data } = await iam.projects.serviceAccounts.signJwt({
      name,
      requestBody: { payload: JSON.stringify(payload) },
    });

    const assertion = data.signedJwt;
    if (!assertion) throw new Error('signJwt did not return signedJwt');

    // Exchange for an access_token
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`token_exchange_failed: ${resp.status} ${text}`);
    }

    const tok = await resp.json() as { access_token: string };
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: tok.access_token });
    return google.calendar({ version: 'v3', auth });
  }

  // Fallback: plain ADC (works only if the calendar is *shared* to the SA)
  const auth = new google.auth.GoogleAuth({ scopes });
  return google.calendar({ version: 'v3', auth });
}

export default getCalendarClient;
