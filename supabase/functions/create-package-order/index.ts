import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const PAYPAL_CLIENT_ID = Deno.env.get('PAYPAL_CLIENT_ID');
const PAYPAL_CLIENT_SECRET = Deno.env.get('PAYPAL_CLIENT_SECRET');
const PAYPAL_BASE = Deno.env.get('PAYPAL_BASE') || 'https://api-m.sandbox.paypal.com';

async function getPayPalToken() {
  const auth = btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`);
  const response = await fetch(`${PAYPAL_BASE}/v2/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${auth}`
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    throw new Error('Unable to authenticate with PayPal');
  }

  const json = await response.json();
  return json.access_token;
}

Deno.serve(async (req: Request) => {
  try {
    if (!supabaseUrl || !supabaseServiceRole || !PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      return new Response(JSON.stringify({ error: 'Server configuration is incomplete.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { packageId, paymentMethod } = await req.json();
    if (!packageId || !paymentMethod) {
      return new Response(JSON.stringify({ error: 'Package and payment method are required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRole);
    const { data: pkg, error: packageError } = await supabase
      .from('packages')
      .select('*')
      .eq('id', packageId)
      .eq('is_active', true)
      .single();

    if (packageError || !pkg) {
      return new Response(JSON.stringify({ error: 'Package not found or inactive.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const token = await getPayPalToken();
    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: `pkg-${packageId}`,
          amount: {
            currency_code: 'USD',
            value: Number(pkg.amount_usd).toFixed(2)
          }
        }],
        application_context: {
          brand_name: 'SPLATT WXRLDWIDE',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW'
        }
      })
    });

    const json = await response.json();
    if (!response.ok) {
      return new Response(JSON.stringify({ error: json.error || 'Could not create PayPal order.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const approveLink = json.links?.find((link: any) => link.rel === 'approve')?.href;
    if (!approveLink) {
      return new Response(JSON.stringify({ error: 'Approve URL missing from PayPal order response.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { error: orderInsertError } = await supabase.from('paypal_orders').insert({
      paypal_order_id: json.id,
      package_id: packageId,
      order_type: 'package',
      amount_usd: pkg.amount_usd,
      currency: 'USD',
      status: 'created',
      idempotency_key: json.id
    });

    if (orderInsertError) {
      return new Response(JSON.stringify({ error: orderInsertError.message || 'Failed to store PayPal order record.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ ok: true, orderId: json.id, approveLink }), {
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
