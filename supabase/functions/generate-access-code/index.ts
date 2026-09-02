import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const parts = Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(''));
  return `SPLATT-${parts.join('')}`;
}

Deno.serve(async (req: Request) => {
  try {
    if (!supabaseUrl || !supabaseServiceRole) {
      return new Response(JSON.stringify({ error: 'Supabase backend configuration missing.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRole);
    let code = makeCode();
    let tries = 0;

    while (tries < 10) {
      const { data: existing } = await supabase.from('access_codes').select('id').eq('code', code).maybeSingle();
      if (!existing) break;
      code = makeCode();
      tries += 1;
    }

    const { data, error } = await supabase.from('access_codes').insert({
      code,
      status: 'unused',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString()
    }).select().single();

    if (error || !data) {
      return new Response(JSON.stringify({ ok: false, error: error?.message || 'Unable to generate access code.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ ok: true, code: data.code, id: data.id }), {
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
