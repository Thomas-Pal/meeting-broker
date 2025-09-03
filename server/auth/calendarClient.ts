// server/auth/calendarClient.ts
import { google, calendar_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';

export async function makeCalendarClient(): Promise<calendar_v3.Calendar> {
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const delegatedUser = process.env.GOOGLE_DELEGATED_USER || undefined;

  // A) Explicit SA key in env (raw JSON or base64) → JWT (works with DWD)
  const rawJson =
    process.env.GOOGLE_CREDENTIALS ||
    (process.env.GOOGLE_CREDENTIALS_B64
      ? Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')
      : undefined);

  if (rawJson) {
    const key = JSON.parse(rawJson);
    let privateKey: string = key.private_key;
    if (privateKey?.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');

    const jwt = new JWT({
      email: key.client_email,
      key: privateKey,
      scopes,
      subject: delegatedUser, // DWD impersonation if provided
    });

    return google.calendar({ version: 'v3', auth: jwt });
  }

  // B) ADC / key file path (Cloud Run SA or SA key file). Pass GoogleAuth itself.
  const auth = new google.auth.GoogleAuth({
    scopes,
    clientOptions: delegatedUser ? { subject: delegatedUser } : undefined,
  });

  // Passing GoogleAuth satisfies the googleapis types (no AnyAuthClient mismatch)
  return google.calendar({ version: 'v3', auth });
}

export default makeCalendarClient;
