import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

Deno.serve(async (req: Request) => {
  try {
    if (!supabaseUrl || !supabaseServiceRole) {
      return new Response(JSON.stringify({ error: 'Supabase backend configuration missing.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { code, customer_id, session_id } = await req.json();
    if (!code || !customer_id || !session_id) {
      return new Response(JSON.stringify({ ok: false, error: 'code, customer_id and session_id are required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRole);
    const { data: access, error: lookupError } = await supabase
      .from('access_codes')
      .select('*')
      .eq('code', code.trim())
      .maybeSingle();

    if (lookupError || !access) {
      return new Response(JSON.stringify({ ok: false, valid: false, error: lookupError?.message || 'Access code not found.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (['used', 'expired', 'revoked'].includes(access.status)) {
      return new Response(JSON.stringify({ ok: false, valid: false, error: 'Access code cannot be used.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (access.expires_at && new Date(access.expires_at) < new Date()) {
      await supabase.from('access_codes').update({ status: 'expired', expires_at: access.expires_at }).eq('id', access.id);
      return new Response(JSON.stringify({ ok: false, valid: false, error: 'Access code expired.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { data, error } = await supabase
      .from('access_codes')
      .update({
        customer_id,
        status: 'reserved',
        reserved_at: new Date().toISOString(),
        reserved_for_purchase_id: session_id
      })
      .eq('id', access.id)
      .eq('status', 'unused')
      .select();

    if (error || !data || data.length === 0) {
      return new Response(JSON.stringify({ ok: false, valid: false, error: 'Code could not be reserved. It may already be in use.' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ ok: true, valid: true, reserved: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
