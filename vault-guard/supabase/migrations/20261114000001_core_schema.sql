-- VAULT GUARD — esquema central (Zero Knowledge).
-- O servidor guarda SOMENTE dados cifrados no navegador e metadados mínimos.
-- RLS NÃO substitui a criptografia de ponta a ponta: é uma segunda camada.

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------------ vaults
-- Um cofre por usuário. encrypted_vault = { wrappedDekMaster, wrappedDekRecovery } (DEK embrulhada).
create table public.vaults (
  id                   uuid primary key,                 -- gerado no cliente: entra no AAD da cifragem
  user_id              uuid not null unique references auth.users (id) on delete cascade,
  encrypted_vault      jsonb not null
    check (jsonb_typeof(encrypted_vault) = 'object'
       and jsonb_typeof(encrypted_vault -> 'wrappedDekMaster') = 'string'
       and pg_column_size(encrypted_vault) <= 4096),
  salt                 text not null check (salt ~ '^[A-Za-z0-9_-]{22}$'),   -- 16 bytes em base64url
  kdf_algorithm        text not null check (kdf_algorithm = 'argon2id13'),
  kdf_parameters       jsonb not null
    check (jsonb_typeof(kdf_parameters) = 'object'
       and jsonb_typeof(kdf_parameters -> 'opslimit') = 'number'
       and jsonb_typeof(kdf_parameters -> 'memlimit') = 'number'
       and (kdf_parameters ->> 'opslimit')::numeric between 2 and 10
       and (kdf_parameters ->> 'memlimit')::numeric between 33554432 and 268435456),
  encryption_algorithm text not null check (encryption_algorithm = 'aes-256-gcm'),
  version              integer not null default 1 check (version >= 1),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, user_id)
);

-- ----------------------------------------------------------------- records
-- encrypted_payload carrega TUDO (nome, url, usuário, senha, categoria, notas).
-- O formato "1.<iv>.<ct+tag>" é exigido: texto aberto não passa pela restrição.
create table public.records (
  id                  uuid primary key,                  -- gerado no cliente: entra no AAD
  vault_id            uuid not null,
  user_id             uuid not null,
  encrypted_payload   text not null
    check (char_length(encrypted_payload) <= 65536
       and encrypted_payload ~ '^1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$'),
  encryption_version  integer not null default 1 check (encryption_version = 1),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- o registro só pode pertencer a um cofre DO MESMO usuário, mesmo que a RLS fosse mal configurada
  foreign key (vault_id, user_id) references public.vaults (id, user_id) on delete cascade
);
create index records_user_id_idx  on public.records (user_id);
create index records_vault_id_idx on public.records (vault_id);

create trigger profiles_updated before update on public.profiles for each row execute function public.set_updated_at();
create trigger vaults_updated   before update on public.vaults   for each row execute function public.set_updated_at();
create trigger records_updated  before update on public.records  for each row execute function public.set_updated_at();

-- Perfil criado automaticamente no cadastro (função NÃO executável pela API).
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------- privilégios + RLS
-- O Supabase concede privilégios amplos por padrão: revogamos e concedemos o mínimo.
revoke all on public.profiles, public.vaults, public.records from public, anon, authenticated;
grant select                         on public.profiles to authenticated;
grant select, insert, update, delete on public.vaults   to authenticated;
grant select, insert, update, delete on public.records  to authenticated;

alter table public.profiles enable row level security;
alter table public.vaults   enable row level security;
alter table public.records  enable row level security;
alter table public.profiles force row level security;
alter table public.vaults   force row level security;
alter table public.records  force row level security;

-- (select auth.uid()) é avaliado uma vez por consulta (desempenho recomendado pelo Supabase).
create policy profiles_select_own on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));

create policy vaults_select_own on public.vaults for select to authenticated
  using (user_id = (select auth.uid()));
create policy vaults_insert_own on public.vaults for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy vaults_update_own on public.vaults for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy vaults_delete_own on public.vaults for delete to authenticated
  using (user_id = (select auth.uid()));

create policy records_select_own on public.records for select to authenticated
  using (user_id = (select auth.uid()));
create policy records_insert_own on public.records for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy records_update_own on public.records for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy records_delete_own on public.records for delete to authenticated
  using (user_id = (select auth.uid()));
