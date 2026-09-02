create extension if not exists pgcrypto;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  paypal_payer_id text unique,
  created_at timestamptz not null default now(),
  first_package_purchase_at timestamptz,
  first_order_discount_eligible boolean not null default true,
  status text not null default 'active' check (status in ('active','inactive','suspended')),
  last_seen_at timestamptz,
  constraint customers_email_not_blank check (email is null or length(trim(email)) > 0),
  constraint customers_paypal_payer_id_not_blank check (paypal_payer_id is null or length(trim(paypal_payer_id)) > 0)
);

create table if not exists public.packages (
  id text primary key,
  name text not null,
  amount_usd numeric(10,2) not null check (amount_usd >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint packages_name_not_blank check (length(trim(name)) > 0)
);

insert into public.packages (id, name, amount_usd, currency, is_active)
values
  ('entry','Entry Level',150.00,'USD',true),
  ('medium','Medium Influencer',180.00,'USD',true),
  ('creator','Content Creator',220.00,'USD',true),
  ('diamond','Diamond',310.00,'USD',true)
on conflict (id) do update set
  name = excluded.name,
  amount_usd = excluded.amount_usd,
  currency = excluded.currency,
  is_active = excluded.is_active;

create table if not exists public.paypal_orders (
  id uuid primary key default gen_random_uuid(),
  paypal_order_id text not null unique,
  customer_id uuid references public.customers(id),
  package_id text references public.packages(id),
  order_type text not null default 'package' check (order_type in ('package','addon')),
  amount_usd numeric(10,2) not null check (amount_usd >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  status text not null default 'created' check (status in ('created','approved','captured','failed','cancelled','expired')),
  capture_id text,
  payer_email text,
  payer_id text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  captured_at timestamptz,
  verified_at timestamptz,
  payment_verified boolean not null default false,
  verification_error text,
  idempotency_key text unique,
  constraint paypal_orders_amount_not_negative check (amount_usd >= 0),
  constraint paypal_orders_payer_email_blank check (payer_email is null or length(trim(payer_email)) > 0),
  constraint paypal_orders_payer_id_blank check (payer_id is null or length(trim(payer_id)) > 0)
);

create index if not exists idx_paypal_orders_customer on public.paypal_orders(customer_id);
create index if not exists idx_paypal_orders_status on public.paypal_orders(status);

create table if not exists public.package_purchases (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  paypal_order_id text not null unique references public.paypal_orders(paypal_order_id),
  package_id text not null references public.packages(id),
  amount_usd numeric(10,2) not null check (amount_usd >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  payment_verified boolean not null default false,
  verified_at timestamptz,
  questionnaire_access_granted boolean not null default false,
  created_at timestamptz not null default now(),
  constraint package_purchases_amount_not_negative check (amount_usd >= 0)
);

create index if not exists idx_package_purchases_customer on public.package_purchases(customer_id);

create table if not exists public.questionnaire_access (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  package_purchase_id uuid not null references public.package_purchases(id),
  payment_verified boolean not null default false,
  granted_at timestamptz,
  revoked_at timestamptz,
  source text not null default 'verified_capture' check (length(trim(source)) > 0),
  created_at timestamptz not null default now(),
  constraint questionnaire_access_unique_purchase unique (package_purchase_id)
);

create table if not exists public.add_on_catalog (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  category text not null,
  name text not null,
  is_active boolean not null default false,
  default_unit_price_usd numeric(10,2),
  min_qty integer not null default 1 check (min_qty >= 1),
  max_qty integer,
  created_at timestamptz not null default now(),
  constraint add_on_catalog_name_not_blank check (length(trim(name)) > 0),
  constraint add_on_catalog_slug_not_blank check (length(trim(slug)) > 0),
  constraint add_on_catalog_price_valid check (default_unit_price_usd is null or default_unit_price_usd >= 0),
  constraint add_on_catalog_qty_bounds check (max_qty is null or max_qty >= min_qty),
  constraint add_on_catalog_active_check check (is_active in (true,false))
);

create table if not exists public.access_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  code_hash text,
  generated_by_admin_id uuid,
  customer_id uuid references public.customers(id),
  status text not null default 'unused' check (status in ('unused','reserved','used','expired','revoked')),
  reserved_at timestamptz,
  reserved_for_purchase_id uuid,
  used_at timestamptz,
  used_for_purchase_id uuid,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint access_code_code_not_blank check (length(trim(code)) > 0),
  constraint access_code_timestamp_valid check (expires_at is null or expires_at >= created_at)
);

create index if not exists idx_access_codes_status on public.access_codes(status);
create index if not exists idx_access_codes_customer on public.access_codes(customer_id);

create table if not exists public.add_on_orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  access_code_id uuid references public.access_codes(id),
  paypal_order_id text not null unique references public.paypal_orders(paypal_order_id),
  subtotal_usd numeric(10,2) not null check (subtotal_usd >= 0),
  discount_amount_usd numeric(10,2) not null default 0 check (discount_amount_usd >= 0),
  total_usd numeric(10,2) not null check (total_usd >= 0),
  minimum_order_met boolean not null default false,
  status text not null default 'pending' check (status in ('pending','paid','cancelled','failed','refunded')),
  payment_verified boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint add_on_orders_total_not_exceed_subtotal check (total_usd <= subtotal_usd)
);

create table if not exists public.add_on_order_items (
  id uuid primary key default gen_random_uuid(),
  add_on_order_id uuid not null references public.add_on_orders(id) on delete cascade,
  add_on_id uuid not null references public.add_on_catalog(id),
  quantity integer not null check (quantity >= 1),
  unit_price_usd numeric(10,2) not null check (unit_price_usd >= 0),
  line_total_usd numeric(10,2) not null check (line_total_usd >= 0),
  created_at timestamptz not null default now(),
  constraint add_on_order_items_line_total_matches check (line_total_usd = quantity * unit_price_usd)
);

create table if not exists public.return_customer_discount_codes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  code text not null unique,
  status text not null default 'issued' check (status in ('issued','used','expired','revoked')),
  issued_after_purchase_id uuid not null references public.package_purchases(id),
  issued_at timestamptz not null default now(),
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null,
  used_at timestamptz,
  used_for_order_id uuid,
  discount_percent numeric(5,2) not null default 10.00 check (discount_percent >= 0 and discount_percent <= 100),
  created_at timestamptz not null default now(),
  constraint return_discount_code_blank check (length(trim(code)) > 0),
  constraint return_discount_validity check (valid_until >= valid_from)
);

create index if not exists idx_return_discount_customer on public.return_customer_discount_codes(customer_id);

create table if not exists public.customer_promotions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  promotion_type text not null check (length(trim(promotion_type)) > 0),
  status text not null default 'eligible' check (status in ('eligible','used','expired','revoked')),
  eligible_from_order_id uuid,
  used_at timestamptz,
  used_for_order_id uuid,
  created_at timestamptz not null default now(),
  constraint customer_promotions_unique_type unique (customer_id, promotion_type)
);

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null check (length(trim(action)) > 0),
  entity_type text,
  entity_id text,
  details jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.customer_access_grants (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  grant_type text not null check (length(trim(grant_type)) > 0),
  reference_id text,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb,
  constraint customer_access_grants_validity check (expires_at is null or expires_at >= granted_at)
);

create table if not exists public.checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id),
  session_key text not null unique,
  package_id text references public.packages(id),
  access_code_id uuid references public.access_codes(id),
  total_usd numeric(10,2) check (total_usd is null or total_usd >= 0),
  status text not null default 'created' check (status in ('created','pending','completed','expired','cancelled')),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now(),
  constraint checkout_sessions_session_key_not_blank check (length(trim(session_key)) > 0),
  constraint checkout_sessions_valid_expiry check (expires_at >= created_at)
);

create index if not exists idx_checkout_sessions_customer on public.checkout_sessions(customer_id);
create index if not exists idx_access_codes_code_hash on public.access_codes(code_hash);

alter table if exists public.customers enable row level security;
alter table if exists public.packages enable row level security;
alter table if exists public.paypal_orders enable row level security;
alter table if exists public.package_purchases enable row level security;
alter table if exists public.questionnaire_access enable row level security;
alter table if exists public.add_on_catalog enable row level security;
alter table if exists public.access_codes enable row level security;
alter table if exists public.add_on_orders enable row level security;
alter table if exists public.add_on_order_items enable row level security;
alter table if exists public.return_customer_discount_codes enable row level security;
alter table if exists public.customer_promotions enable row level security;
alter table if exists public.admin_audit_log enable row level security;
alter table if exists public.customer_access_grants enable row level security;
alter table if exists public.checkout_sessions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'customers' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.customers for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'packages' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.packages for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'paypal_orders' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.paypal_orders for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'package_purchases' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.package_purchases for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'questionnaire_access' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.questionnaire_access for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'add_on_catalog' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.add_on_catalog for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'access_codes' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.access_codes for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'add_on_orders' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.add_on_orders for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'add_on_order_items' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.add_on_order_items for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'return_customer_discount_codes' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.return_customer_discount_codes for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_promotions' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.customer_promotions for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'admin_audit_log' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.admin_audit_log for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_access_grants' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.customer_access_grants for all using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'checkout_sessions' and policyname = 'deny_all_public_access'
  ) then
    create policy "deny_all_public_access" on public.checkout_sessions for all using (false) with check (false);
  end if;
end $$;
