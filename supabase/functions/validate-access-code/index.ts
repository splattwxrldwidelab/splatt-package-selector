import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

Deno.serve(async (req: Request) => {
  try {
    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(JSON.stringify({ error: 'Supabase configuration missing.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { code } = await req.json();
    if (!code || typeof code !== 'string' || !code.trim()) {
      return new Response(JSON.stringify({ ok: false, valid: false, error: 'Access code required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') || '' } }
    });

    const normalized = code.trim();
    const { data, error } = await supabase
      .from('access_codes')
      .select('id, code, status, expires_at, reserved_at, used_at, revoked_at')
      .eq('code', normalized)
      .maybeSingle();

    if (error) {
      return new Response(JSON.stringify({ ok: false, valid: false, error: error.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!data) {
      return new Response(JSON.stringify({ ok: true, valid: false, reason: 'not_found' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const now = new Date();
    const expired = data.expires_at && new Date(data.expires_at) < now;
    const used = data.status === 'used';
    const revoked = data.status === 'revoked';
    const valid = data.status === 'unused' || data.status === 'reserved';

    return new Response(JSON.stringify({
      ok: true,
      valid: !expired && !used && !revoked && valid,
      status: data.status,
      expired,
      reserved: data.status === 'reserved',
      reason: expired ? 'expired' : used ? 'used' : revoked ? 'revoked' : valid ? 'valid' : 'invalid'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ ok: false, valid: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
