# Deploy the corrected TaskMtaani helper-account-admin function

Target Supabase project: `syebcyshsscthrqvprjc`  
Function name: `helper-account-admin`  
Function URL: `https://syebcyshsscthrqvprjc.supabase.co/functions/v1/helper-account-admin`

## What is corrected

- Registration OTP validation now accepts exactly six numeric digits. The previous escaped regular expression incorrectly looked for a literal backslash followed by d characters, so valid numeric OTPs were rejected.
- Bearer-token parsing now correctly strips the `Bearer ` prefix. This protects the function's authenticated administrative actions from a similarly over-escaped regular expression.

No secrets or API keys are stored in this repository. The function continues to read its existing Supabase secrets at runtime.

## Dashboard deployment (no CLI required)

1. Sign in to [Supabase Dashboard](https://supabase.com/dashboard).
2. Open project `syebcyshsscthrqvprjc`.
3. In the left navigation, open **Edge Functions**.
4. Select the existing function **helper-account-admin**. Do not create a second function.
5. Open its code editor (Edit).
6. In GitHub, open this file:
   `supabase/functions/helper-account-admin/index.ts`
   Copy the entire file contents.
7. Return to the Supabase editor. Select all existing code in the function's `index.ts` entrypoint and replace it with the complete GitHub file contents.
8. Keep the function name as `helper-account-admin`. Keep **Verify JWT** disabled, as it is currently configured; this function handles its own request authentication for its protected actions.
9. Click **Deploy updates** / **Deploy function** and wait for the success confirmation.
10. Reopen the function details and confirm the deployment version has incremented.

## Preserve these existing secrets

Before testing, confirm these secrets remain configured under **Edge Functions → Secrets**:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `HASHBACK_API_KEY`

Do not paste secret values into GitHub or this README. If the project currently uses the built-in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` runtime variables, leave them as they are; only ensure `HASHBACK_API_KEY` remains configured.

## Test after deployment

Use the TaskMtaani website registration flow rather than testing by sending an OTP to an unknown number:

1. Start registration with a mobile number that is not already attached to an account.
2. Request the SMS code and enter the six digits.
3. Click **Verify and create account** once.
4. A successful result should create the account and sign the user in. Ordinary later logins should continue to use mobile number + password, with no OTP.
5. Check Supabase **Authentication → Users** for the newly created user and confirm the phone is marked confirmed.
6. Test an existing account's normal login separately. Do not repeatedly submit OTPs: codes expire after five minutes and wrong attempts are limited.

If deployment or testing fails, copy the exact dashboard error and the function log entry (redact phone numbers, tokens, and personal data) before making further changes.
