-- Histórico de acessos e alterações SEM dados confidenciais (apenas tipo de evento e id do registro).
-- Append-only para o cliente: sem UPDATE/DELETE. Observação: como o cliente grava os próprios eventos,
-- este histórico serve ao usuário; NÃO é uma trilha forense à prova de adulteração.
create table public.audit_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  event_type  text not null check (event_type in (
    'vault_unlock','vault_unlock_failed','vault_lock','record_create','record_update','record_delete',
    'record_copy','master_password_change','recovery_key_rotate','export','integrity_check')),
  record_id   uuid,                       -- sem FK: o histórico sobrevive à exclusão do registro
  created_at  timestamptz not null default now()
);
create index audit_events_user_created_idx on public.audit_events (user_id, created_at desc);

revoke all on public.audit_events from public, anon, authenticated;
grant select, insert on public.audit_events to authenticated;

alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;

create policy audit_select_own on public.audit_events for select to authenticated
  using (user_id = (select auth.uid()));
create policy audit_insert_own on public.audit_events for insert to authenticated
  with check (user_id = (select auth.uid()));
