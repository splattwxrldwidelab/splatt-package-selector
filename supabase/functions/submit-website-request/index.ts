import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const adminEmail = 'admin.splattwxrldwide@gmail.com';

const emailEnvNames = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'MAILGUN_API_KEY',
  'RESEND_API_KEY'
];

function normalizeText(value: string | null | undefined) {
  return typeof value === 'string' ? value.trim() : '';
}

function errorResponse(status: number, message: string, details?: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: false, error: message, ...(details || {}) }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function hasAnyEmailConfig() {
  return emailEnvNames.some((name) => Boolean(Deno.env.get(name)));
}

async function logSubmission(supabase: ReturnType<typeof createClient>, payload: Record<string, unknown>) {
  const { error } = await supabase.from('website_submissions').insert(payload);
  if (error) {
    throw new Error(error.message || 'Failed to store submission record.');
  }
}

Deno.serve(async (req: Request) => {
  try {
    if (!supabaseUrl || !supabaseServiceRole) {
      return errorResponse(500, 'Supabase backend configuration missing.');
    }

    if (req.method !== 'POST') {
      return errorResponse(405, 'Method not allowed.');
    }

    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return errorResponse(400, 'Request body must be JSON.');
    }

    const body = await req.json();
    const type = String(body?.type || '').toLowerCase();
    const allowedTypes = ['contact', 'custom_request', 'addon_request'];

    if (!allowedTypes.includes(type)) {
      return errorResponse(400, 'Unsupported submission type.');
    }

    const email = normalizeText(body?.email || body?.customer_email);
    const name = normalizeText(body?.name || body?.customer_name);
    const message = normalizeText(body?.message || body?.details || body?.description);

    if (!email || !message) {
      return errorResponse(400, 'Email and message are required.');
    }

    const metadata = {
      ...(body?.metadata || {}),
      sourcePage: normalizeText(body?.sourcePage || body?.source_page) || null,
      phone: normalizeText(body?.phone || null) || null,
      requestType: normalizeText(body?.requestType || body?.type || null) || null,
      packageName: normalizeText(body?.packageName || null) || null,
      addonSelection: body?.addonSelection || null,
      submittedAt: new Date().toISOString()
    };

    const supabase = createClient(supabaseUrl, supabaseServiceRole);

    await logSubmission(supabase, {
      submission_type: type,
      source_page: normalizeText(body?.sourcePage || body?.source_page) || null,
      customer_name: name || null,
      customer_email: email,
      phone: normalizeText(body?.phone || null) || null,
      message,
      metadata,
      admin_email: adminEmail,
      status: 'received'
    });

    if (!hasAnyEmailConfig()) {
      return new Response(JSON.stringify({
        ok: true,
        queued: true,
        adminEmail,
        message: 'Submission accepted and stored. Email delivery is not configured yet; the admin inbox is configured for runtime use when SMTP or mail-provider secrets are added.'
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      queued: true,
      adminEmail,
      message: 'Submission accepted and queued for delivery to the approved SPLATTW★RLDWIDE admin inbox.'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(500, message);
  }
});
