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

create table if not exists public.facturapro_sessions (
    token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

create table if not exists public.facturapro_login_attempts (
    attempt_key text primary key check (attempt_key ~ '^[0-9a-f]{64}$'),
    failures integer not null default 0,
    window_started_at timestamptz not null,
    blocked_until timestamptz
);

create index if not exists facturapro_invoices_updated_at_idx
    on public.facturapro_invoices (updated_at desc);
create index if not exists facturapro_sessions_expires_at_idx
    on public.facturapro_sessions (expires_at);

alter table public.facturapro_admin enable row level security;
alter table public.facturapro_settings enable row level security;
alter table public.facturapro_invoices enable row level security;
alter table public.facturapro_sessions enable row level security;
alter table public.facturapro_login_attempts enable row level security;

revoke all on public.facturapro_admin, public.facturapro_settings, public.facturapro_invoices,
    public.facturapro_sessions, public.facturapro_login_attempts
    from public, anon, authenticated;
grant all on public.facturapro_admin, public.facturapro_settings, public.facturapro_invoices,
    public.facturapro_sessions, public.facturapro_login_attempts
    to service_role;

create or replace function public.facturapro_login_is_blocked(p_attempt_key text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
    select coalesce((
        select blocked_until > now()
        from public.facturapro_login_attempts
        where attempt_key = p_attempt_key
    ), false);
$$;

create or replace function public.facturapro_login_failure(p_attempt_key text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    current_attempt public.facturapro_login_attempts%rowtype;
begin
    insert into public.facturapro_login_attempts (attempt_key, failures, window_started_at)
    values (p_attempt_key, 0, now())
    on conflict (attempt_key) do nothing;

    select * into current_attempt
    from public.facturapro_login_attempts
    where attempt_key = p_attempt_key
    for update;

    if current_attempt.window_started_at <= now() - interval '15 minutes' then
        update public.facturapro_login_attempts
        set failures = 1, window_started_at = now(), blocked_until = null
        where attempt_key = p_attempt_key;
    else
        update public.facturapro_login_attempts
        set failures = current_attempt.failures + 1,
            blocked_until = case
                when current_attempt.failures + 1 >= 5 then now() + interval '15 minutes'
                else current_attempt.blocked_until
            end
        where attempt_key = p_attempt_key;
    end if;
end;
$$;

create or replace function public.facturapro_login_success(p_attempt_key text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
    delete from public.facturapro_login_attempts where attempt_key = p_attempt_key;
$$;

revoke all on function public.facturapro_login_is_blocked(text) from public, anon, authenticated;
revoke all on function public.facturapro_login_failure(text) from public, anon, authenticated;
revoke all on function public.facturapro_login_success(text) from public, anon, authenticated;
grant execute on function public.facturapro_login_is_blocked(text) to service_role;
grant execute on function public.facturapro_login_failure(text) to service_role;
grant execute on function public.facturapro_login_success(text) to service_role;

notify pgrst, 'reload schema';
