-- SOMENTE PARA TESTES LOCAIS. Imita o mínimo do Supabase (papéis, auth.users, auth.uid()).
-- NUNCA aplicar em um projeto Supabase real: lá esses objetos já existem.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
-- Como no Supabase: privilégios padrão amplos em public (a migration os revoga explicitamente).
alter default privileges in schema public grant all on tables to anon, authenticated;
