create table if not exists public.website_submissions (
  id uuid primary key default gen_random_uuid(),
  submission_type text not null check (submission_type in ('contact','custom_request','addon_request')),
  source_page text,
  customer_name text,
  customer_email text,
  phone text,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  admin_email text not null default 'admin.splattwxrldwide@gmail.com',
  status text not null default 'received' check (status in ('received','queued','sent','failed')),
  created_at timestamptz not null default now(),
  constraint website_submissions_name_not_blank check (customer_name is null or length(trim(customer_name)) > 0),
  constraint website_submissions_email_not_blank check (customer_email is null or length(trim(customer_email)) > 0),
  constraint website_submissions_message_not_blank check (message is null or length(trim(message)) > 0)
);

create index if not exists idx_website_submissions_type on public.website_submissions(submission_type);
create index if not exists idx_website_submissions_created_at on public.website_submissions(created_at desc);

alter table if exists public.website_submissions enable row level security;

create policy if not exists "deny_all_public_access" on public.website_submissions
for all using (false) with check (false);
