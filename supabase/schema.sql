create table if not exists public.facturapro_admin (
    id boolean primary key default true check (id = true),
    username text not null unique,
    salt text not null,
    password_hash text not null,
    created_at timestamptz not null default now()
);

create table if not exists public.facturapro_settings (
    key text primary key,
    value jsonb not null
);

create table if not exists public.facturapro_invoices (
    id text primary key,
    number text not null,
    payload jsonb not null,
    updated_at timestamptz not null default now()
);

create index if not exists facturapro_invoices_updated_at_idx
    on public.facturapro_invoices (updated_at desc);

alter table public.facturapro_admin enable row level security;
alter table public.facturapro_settings enable row level security;
alter table public.facturapro_invoices enable row level security;

revoke all on public.facturapro_admin, public.facturapro_settings, public.facturapro_invoices
    from public, anon, authenticated;
grant all on public.facturapro_admin, public.facturapro_settings, public.facturapro_invoices
    to service_role;
