import { google } from "googleapis";
import { GoogleAuth, JWT } from "google-auth-library";

export type AuthMode = "workload" | "dwd_json_key";

/**
 * Returns an authenticated Calendar client.
 *
 * Modes:
 * - workload: (default) use Application Default Credentials (no keys).
 *             In Cloud Run, this is the service account attached to the service.
 *             Share a calendar with that service account, or create a calendar it owns.
 * - dwd_json_key: use Domain‑Wide Delegation with a JSON key provided via env vars.
 *                 Requires GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_DELEGATED_USER.
 */
export async function getCalendarClient(mode: AuthMode = "workload") {
  if (mode === "dwd_json_key") {
    const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY;
    const delegatedUser = process.env.GOOGLE_DELEGATED_USER;

    if (!clientEmail || !privateKey || !delegatedUser) {
      throw new Error("Missing env for dwd_json_key: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_DELEGATED_USER");
    }

    const jwt = new JWT({
      email: clientEmail,
      key: privateKey.replace(/\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/calendar"],
      subject: delegatedUser,
    });

    const calendar = google.calendar({ version: "v3", auth: jwt });
    return calendar;
  }

  // workload (default): ADC
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  const client = await auth.getClient();
  const calendar = google.calendar({ version: "v3", auth: client as any });
  return calendar;
}
