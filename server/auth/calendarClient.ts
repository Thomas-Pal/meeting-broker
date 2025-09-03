// server/auth/calendarClient.ts
import { google, calendar_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';

export type AuthMode = 'workload' | 'adc' | 'key' | 'impersonate';

/**
 * Returns an authenticated Google Calendar client.
 *
 * Modes:
 *  - 'key' | 'impersonate': use SA key (env or file). If GOOGLE_DELEGATED_USER is set, do DWD.
 *  - 'workload' | 'adc':    use Application Default Credentials (Cloud Run SA). No DWD here.
 *
 * Env it can read:
 *  GOOGLE_CREDENTIALS            raw JSON of SA key
 *  GOOGLE_CREDENTIALS_B64        base64-encoded JSON of SA key
 *  GOOGLE_APPLICATION_CREDENTIALS path to SA key file (JSON)
 *  GOOGLE_DELEGATED_USER         user@domain for DWD (only with SA key)
 */
export async function getCalendarClient(
  mode: AuthMode = 'workload'
): Promise<calendar_v3.Calendar> {
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const delegatedUser = process.env.GOOGLE_DELEGATED_USER || undefined;

  // Prefer explicit key when requested or present
  const rawJson =
    process.env.GOOGLE_CREDENTIALS ||
    (process.env.GOOGLE_CREDENTIALS_B64
      ? Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')
      : undefined);

  const wantKey =
    mode === 'key' || mode === 'impersonate' || !!rawJson || !!process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (wantKey) {
    if (rawJson) {
      const key = JSON.parse(rawJson);
      let privateKey: string = key.private_key;
      if (privateKey?.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');

      const jwt = new JWT({
        email: key.client_email,
        key: privateKey,
        scopes,
        subject: delegatedUser, // DWD if provided
      });

      return google.calendar({ version: 'v3', auth: jwt });
    }

    // Key via file path (still SA creds). Use GoogleAuth but pass the *GoogleAuth* instance to google.calendar.
    const auth = new google.auth.GoogleAuth({
      scopes,
      clientOptions: delegatedUser ? { subject: delegatedUser } : undefined,
    });

    // Important: pass `auth` (GoogleAuth), not the raw client.
    return google.calendar({ version: 'v3', auth });
  }

  // Default: ADC / workload identity (Cloud Run SA). No DWD.
  if (delegatedUser) {
    console.warn(
      'GOOGLE_DELEGATED_USER is set but no SA key provided; ADC/workload cannot impersonate a user. Proceeding without DWD.'
    );
  }

  // Important: again, pass the GoogleAuth instance itself.
  const auth = new google.auth.GoogleAuth({ scopes });
  return google.calendar({ version: 'v3', auth });
}

export default getCalendarClient;
