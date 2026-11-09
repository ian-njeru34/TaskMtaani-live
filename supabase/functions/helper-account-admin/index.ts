import { createClient } from "npm:@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "https://taskmtaani-live.vercel.app",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
function normalizeKenyanPhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return "254" + digits.slice(1);
  if (digits.startsWith("7") && digits.length === 9) return "254" + digits;
  if (digits.startsWith("1") && digits.length === 9) return "254" + digits;
  throw new Error("Enter a valid Kenyan mobile number, e.g. 0712345678.");
}
function temporaryPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
}
async function sendSms(phone: string, message: string) {
  const apiKey = Deno.env.get("HASHBACK_API_KEY");
  if (!apiKey) throw new Error("SMS_NOT_CONFIGURED");
  const response = await fetch("https://api.hashback.co.ke/sms/send", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    // Omit sender_id to use the shared sender until a custom sender is registered.
    body: JSON.stringify({ to: phone, message }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success !== true || !data.id) {
    const code = String(data.code || data.error || response.status);
    const detail = String(data.message || data.error_description || "SMS request was not accepted.");
    throw new Error("HashSMS rejected the message (" + code + "): " + detail);
  }
  return { id: data.id, status: data.status, units: data.units, cost: data.cost };
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const payload = await req.json();
    const action = String(payload.action || "create");
    const url = Deno.env.get("SUPABASE_URL")!;
    const publishable = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}").default;
    const secret = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default;
    if (!url || !publishable || !secret) return json({ error: "Supabase function keys are not configured." }, 500);
    const userClient = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

    if (action === "send-registration-otp") {
      const phone = normalizeKenyanPhone(String(payload.phone || ""));
      const role = String(payload.account_role || "");
      if (!["customer", "provider"].includes(role)) return json({ error: "Choose customer or helper registration." }, 400);
      const pepper = Deno.env.get("HASHBACK_API_KEY");
      if (!pepper) return json({ error: "SMS service is not configured." }, 503);
      const { data: existing, error: existingError } = await admin.from("profiles").select("id").eq("phone", phone).limit(1);
      if (existingError) throw existingError;
      if (existing?.length) return json({ error: "This mobile number already has a TaskMtaani account. Please sign in instead." }, 409);
      const { data: pending, error: pendingError } = await admin.from("registration_otps").select("*").eq("phone", phone).maybeSingle();
      if (pendingError) throw pendingError;
      const rawIp = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
      const ipDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawIp + ":" + pepper));
      const ipHash = Array.from(new Uint8Array(ipDigest), b => b.toString(16).padStart(2, "0")).join("");
      const { data: ipLimit, error: ipReadError } = await admin.from("registration_otp_ip_limits").select("*").eq("ip_hash", ipHash).maybeSingle();
      if (ipReadError) throw ipReadError;
      const ipNow = Date.now();
      const ipWindowActive = ipLimit && ipNow - new Date(ipLimit.window_started_at).getTime() < 3600000;
      if (ipWindowActive && Number(ipLimit.sends || 0) >= 15) return json({ error: "Too many verification requests from this connection. Please try again later." }, 429);
      const ipSave = await admin.from("registration_otp_ip_limits").upsert({
        ip_hash: ipHash, window_started_at: ipWindowActive ? ipLimit.window_started_at : new Date(ipNow).toISOString(),
        sends: (ipWindowActive ? Number(ipLimit.sends || 0) : 0) + 1, updated_at: new Date(ipNow).toISOString(),
      }, { onConflict: "ip_hash" });
      if (ipSave.error) throw ipSave.error;
      const now = Date.now();
      if (pending && now - new Date(pending.sent_at).getTime() < 60000) return json({ error: "Please wait one minute before requesting another code." }, 429);
      const sameWindow = pending && now - new Date(pending.window_started_at).getTime() < 3600000;
      const sends = sameWindow ? Number(pending.sends_in_window || 0) : 0;
      if (sends >= 5) return json({ error: "Too many codes requested. Please try again in one hour." }, 429);
      const bytes = crypto.getRandomValues(new Uint32Array(1));
      const otp = String(bytes[0] % 1000000).padStart(6, "0");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(phone + ":" + otp + ":" + pepper));
      const otpHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      await sendSms(phone, "Your TaskMtaani verification code is " + otp + ". It expires in 5 minutes. Do not share this code.");
      const { error: saveError } = await admin.from("registration_otps").upsert({
        phone, account_role: role, otp_hash: otpHash, expires_at: new Date(now + 300000).toISOString(),
        sent_at: new Date(now).toISOString(), attempts: 0,
        window_started_at: sameWindow ? pending.window_started_at : new Date(now).toISOString(),
        sends_in_window: sends + 1, updated_at: new Date(now).toISOString(),
      }, { onConflict: "phone" });
      if (saveError) throw saveError;
      return json({ success: true, phone, expires_in_seconds: 300, resend_after_seconds: 60 });
    }

    if (action === "verify-registration-otp") {
      const phone = normalizeKenyanPhone(String(payload.phone || ""));
      const role = String(payload.account_role || "");
      const otp = String(payload.otp || "").trim();
      const fullName = String(payload.full_name || "").trim();
      const password = String(payload.password || "");
      const contactEmail = String(payload.email || "").trim().toLowerCase();
      if (!["customer", "provider"].includes(role) || !new RegExp("^[0-9]{6}$").test(otp)) return json({ error: "Enter the six-digit code sent to your phone." }, 400);
      if (fullName.length < 2 || password.length < 8) return json({ error: "Enter your full name and a password of at least 8 characters." }, 400);
      if (role === "provider" && (!String(payload.profession || "").trim() || !String(payload.service_area || "").trim())) return json({ error: "Helpers must provide their profession and service area." }, 400);
      const pepper = Deno.env.get("HASHBACK_API_KEY");
      if (!pepper) return json({ error: "SMS service is not configured." }, 503);
      const { data: record, error: recordError } = await admin.from("registration_otps").select("*").eq("phone", phone).maybeSingle();
      if (recordError) throw recordError;
      if (!record || record.account_role !== role || new Date(record.expires_at).getTime() < Date.now() || record.attempts >= 5) {
        if (record && new Date(record.expires_at).getTime() < Date.now()) await admin.from("registration_otps").delete().eq("phone", phone);
        return json({ error: "That code has expired or is no longer valid. Request a new code." }, 400);
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(phone + ":" + otp + ":" + pepper));
      const suppliedHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      if (suppliedHash !== record.otp_hash) {
        const attempts = Number(record.attempts || 0) + 1;
        await admin.from("registration_otps").update({ attempts }).eq("phone", phone);
        return json({ error: attempts >= 5 ? "Too many incorrect codes. Request a new code." : "Incorrect verification code. Please try again." }, 400);
      }
      const userMetadata = {
        full_name: fullName, phone, whatsapp: phone, contact_email: contactEmail || null,
        profession: String(payload.profession || "").trim(),
        experience_years: Math.max(0, Number(payload.experience_years) || 0),
        service_area: String(payload.service_area || "").trim(),
        availability: String(payload.availability || "").trim(),
        bio: String(payload.bio || "").trim(),
      };
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        phone: "+" + phone, phone_confirm: true, password,
        user_metadata: userMetadata, app_metadata: { taskmtaani_role: role },
      });
      if (createError || !created.user) return json({ error: createError?.message || "Could not create your account." }, 400);
      let providerId: string | null = null;
      try {
        if (role === "provider") {
          const { data: provider, error: providerError } = await admin.from("providers").insert({
            user_id: created.user.id, full_name: fullName, phone, whatsapp: phone,
            profession: userMetadata.profession, experience_years: userMetadata.experience_years,
            service_area: userMetadata.service_area, availability: userMetadata.availability,
            bio: userMetadata.bio || null, verification_status: "pending", reference_status: "pending", active: false,
          }).select("id").single();
          if (providerError) throw providerError;
          providerId = provider.id;
        }
        await admin.from("registration_otps").delete().eq("phone", phone);
      } catch (e) {
        if (providerId) await admin.from("providers").delete().eq("id", providerId);
        await admin.auth.admin.deleteUser(created.user.id);
        throw e;
      }
      return json({ success: true, account_role: role, user_id: created.user.id, helper_status: role === "provider" ? "pending_review" : null });
    }

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Sign-in required." }, 401);
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Your session is invalid. Please sign in again." }, 401);

    // A helper may clear their own first-login flag only after successfully changing their password.
    if (action === "complete-password-change") {
      const { data: target, error: targetError } = await admin.auth.admin.getUserById(authData.user.id);
      if (targetError || !target.user || target.user.app_metadata?.taskmtaani_role !== "provider") {
        return json({ error: "This account is not a managed helper account." }, 403);
      }
      const { error } = await admin.auth.admin.updateUserById(authData.user.id, {
        app_metadata: { ...target.user.app_metadata, must_change_password: false },
      });
      if (error) throw error;
      return json({ success: true });
    }

    const { data: adminProfile, error: profileError } = await admin.from("profiles").select("role").eq("id", authData.user.id).maybeSingle();
    if (profileError || adminProfile?.role !== "admin") return json({ error: "Administrator access required." }, 403);

    if (action === "create") {
      const fullName = String(payload.full_name || "").trim();
      const phone = normalizeKenyanPhone(String(payload.phone || ""));
      const profession = String(payload.profession || "").trim();
      const whatsapp = payload.whatsapp ? normalizeKenyanPhone(String(payload.whatsapp)) : phone;
      const area = String(payload.service_area || "").trim();
      const availability = String(payload.availability || "").trim();
      const experience = Math.max(0, Number(payload.experience_years) || 0);
      if (fullName.length < 2 || !profession || !area) return json({ error: "Name, profession and service area are required." }, 400);
      const password = temporaryPassword();
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        phone, phone_confirm: true, password,
        user_metadata: { full_name: fullName, phone, whatsapp },
        app_metadata: { taskmtaani_role: "provider", must_change_password: true },
      });
      if (createError || !created.user) return json({ error: createError?.message || "Could not create helper account." }, 400);
      let providerId: string | null = null;
      try {
        const { data: provider, error: providerError } = await admin.from("providers").insert({
          user_id: created.user.id, full_name: fullName, phone, whatsapp, profession,
          experience_years: experience, service_area: area, availability,
          verification_status: "pending", reference_status: "pending", active: false,
        }).select("id").single();
        if (providerError) throw providerError;
        providerId = provider.id;
        await sendSms(phone, "Task Mtaani helper account created. Login with phone number " + phone +
          " and temporary password: " + password + ". Change this password immediately after first login. Do not share it.");
      } catch (e) {
        if (providerId) await admin.from("providers").delete().eq("id", providerId);
        await admin.auth.admin.deleteUser(created.user.id);
        throw e;
      }
      return json({ success: true, helper: { id: providerId, full_name: fullName, phone, profession, verification_status: "pending", active: false }, sms_sent: true });
    }

    if (action === "reset-password") {
      const providerId = String(payload.provider_id || "");
      const { data: provider, error: providerError } = await admin.from("providers")
        .select("id,user_id,full_name,phone").eq("id", providerId).maybeSingle();
      if (providerError || !provider?.user_id || !provider.phone) return json({ error: "Helper not found or phone missing." }, 404);
      const { data: target, error: targetError } = await admin.auth.admin.getUserById(provider.user_id);
      if (targetError || !target.user) return json({ error: "Helper login account not found." }, 404);
      if (target.user.app_metadata?.taskmtaani_role && target.user.app_metadata.taskmtaani_role !== "provider") return json({ error: "This account is not a helper account." }, 403);
      const password = temporaryPassword();
      const { error: updateError } = await admin.auth.admin.updateUserById(provider.user_id, {
        password, app_metadata: { ...target.user.app_metadata, taskmtaani_role: "provider", must_change_password: true },
      });
      if (updateError) throw updateError;
      try {
        await sendSms(normalizeKenyanPhone(provider.phone), "Task Mtaani: Your helper password has been reset. Login with " +
          normalizeKenyanPhone(provider.phone) + " and temporary password: " + password + ". Change it immediately after login. Do not share it.");
      } catch (e) {
        return json({ error: "Password was reset, but SMS delivery failed. Check HashSMS configuration and reset again. " + String(e) }, 502);
      }
      return json({ success: true, sms_sent: true });
    }
    return json({ error: "Unsupported action." }, 400);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message === "SMS_NOT_CONFIGURED") return json({ error: "HashSMS is not configured yet. Add HASHBACK_API_KEY in Supabase Edge Function Secrets." }, 503);
    return json({ error: message }, 500);
  }
});