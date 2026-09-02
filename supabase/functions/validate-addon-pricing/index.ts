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

    const { items = [], minimum_order = 0 } = await req.json();
    const supabase = createClient(supabaseUrl, supabaseServiceRole);

    const productIds = items.map((item: any) => item.product_id).filter(Boolean);
    if (!productIds.length) {
      return new Response(JSON.stringify({ ok: true, valid: true, subtotal: 0, total: 0, minimum_order }, {
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    const { data: catalog, error } = await supabase
      .from('add_on_catalog')
      .select('*')
      .in('slug', productIds)
      .eq('is_active', true);

    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const map = new Map((catalog || []).map((row: any) => [row.slug, row]));
    let subtotal = 0;
    const lineItems: any[] = [];

    for (const item of items) {
      const product = map.get(item.product_id);
      if (!product) {
        return new Response(JSON.stringify({ ok: false, error: `Unsupported product: ${item.product_id}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const quantity = Number(item.quantity || 0);
      if (!Number.isInteger(quantity) || quantity < product.min_qty || (product.max_qty && quantity > product.max_qty)) {
        return new Response(JSON.stringify({ ok: false, error: `Invalid quantity for ${item.product_id}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const unitPrice = Number(product.default_unit_price_usd || 0);
      const lineTotal = unitPrice * quantity;
      subtotal += lineTotal;
      lineItems.push({ product_id: item.product_id, quantity, unit_price_usd: unitPrice, line_total_usd: lineTotal });
    }

    const total = subtotal;
    const valid = total >= Number(minimum_order || 0);

    return new Response(JSON.stringify({ ok: true, valid, subtotal, total, minimum_order, lineItems }), {
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
