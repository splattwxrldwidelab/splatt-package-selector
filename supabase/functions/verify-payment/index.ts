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

    const { orderId, packageId, customer_id } = await req.json();
    if (!orderId || !packageId) {
      return new Response(JSON.stringify({ success: false, paymentVerified: false, error: 'orderId and packageId are required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRole);
    const { data: existing } = await supabase
      .from('paypal_orders')
      .select('*')
      .eq('paypal_order_id', orderId)
      .maybeSingle();

    if (!existing) {
      return new Response(JSON.stringify({ success: false, paymentVerified: false, error: 'Order not found for verification.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (existing.payment_verified) {
      return new Response(JSON.stringify({ success: true, paymentVerified: true, packageName: existing.package_id, amount: existing.amount_usd, currency: existing.currency }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const payPalToken = await getPayPalToken();
    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${payPalToken}`
      }
    });

    const captureJson = await response.json();
    if (!response.ok) {
      return new Response(JSON.stringify({ success: false, paymentVerified: false, error: captureJson.error || 'PayPal capture failed.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const status = captureJson.status;
    const captureId = captureJson.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;
    const verified = status === 'COMPLETED';

    if (!verified) {
      return new Response(JSON.stringify({ success: false, paymentVerified: false, error: 'Capture not completed.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { data: pkg } = await supabase.from('packages').select('*').eq('id', packageId).single();
    const customerId = customer_id || existing.customer_id;

    if (!customerId) {
      const { data: customerData, error: customerError } = await supabase.from('customers').insert({ status: 'active' }).select().single();
      if (customerError || !customerData) {
        return new Response(JSON.stringify({ success: false, paymentVerified: false, error: 'Customer record required for verification.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      customer_id = customerData.id;
    }

    const { data: packagePurchase } = await supabase.from('package_purchases').insert({
      customer_id: customerId,
      paypal_order_id: orderId,
      package_id: packageId,
      amount_usd: pkg?.amount_usd || existing.amount_usd,
      currency: pkg?.currency || 'USD',
      payment_verified: true,
      verified_at: new Date().toISOString(),
      questionnaire_access_granted: true
    }).select().single();

    await supabase.from('paypal_orders').update({
      status: 'captured',
      capture_id: captureId,
      captured_at: new Date().toISOString(),
      verified_at: new Date().toISOString(),
      payment_verified: true,
      verification_error: null
    }).eq('paypal_order_id', orderId);

    await supabase.from('questionnaire_access').insert({
      customer_id: customerId,
      package_purchase_id: packagePurchase.id,
      payment_verified: true,
      granted_at: new Date().toISOString(),
      source: 'verified_capture'
    });

    await supabase.from('customers').upsert({
      id: customerId,
      first_package_purchase_at: new Date().toISOString(),
      first_order_discount_eligible: true,
      status: 'active'
    }, { onConflict: 'id' });

    return new Response(JSON.stringify({
      success: true,
      paymentVerified: true,
      paymentId: captureId,
      packageName: pkg?.name || packageId,
      amount: pkg?.amount_usd || existing.amount_usd,
      currency: pkg?.currency || 'USD'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ success: false, paymentVerified: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
