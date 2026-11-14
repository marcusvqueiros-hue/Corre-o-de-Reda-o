\set ON_ERROR_STOP on
\set A '''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'''
\o /dev/null
\set B '''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'''
\set VA '''a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'''
\set VB '''b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'''
\set RA '''a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'''
\set RB '''b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2'''
\set PAYLOAD '''1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'''

-- Funções de apoio (esquema temporário, só no superusuário)
create schema t;
create function t.expect_fail(sql text, must_match text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlerrm ilike '%' || must_match || '%' then
      raise notice 'ok   falha esperada (%): %', must_match, left(sql, 70);
      return;
    end if;
    raise exception 'FAIL: erro inesperado [%] para: %', sqlerrm, sql;
  end;
  raise exception 'FAIL: deveria ter falhado: %', sql;
end $$;
create function t.expect_count(sql text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  execute 'select count(*) from (' || sql || ') q' into n;
  if n <> expected then raise exception 'FAIL: % (esperado %, obtido %)', label, expected, n; end if;
  raise notice 'ok   % = %', label, n;
end $$;
grant usage on schema t to anon, authenticated;
grant execute on all functions in schema t to anon, authenticated;

insert into auth.users (id, email) values (:A, 'a@teste'), (:B, 'b@teste');

-- 0) o gatilho criou os perfis
select t.expect_count('select 1 from public.profiles', 2, 'perfis criados automaticamente');

-- 1) A cria cofre, registro e evento
set role authenticated;
select set_config('request.jwt.claim.sub', :A, false);
insert into public.vaults (id, user_id, encrypted_vault, salt, kdf_algorithm, kdf_parameters, encryption_algorithm)
values (:VA, :A, '{"wrappedDekMaster":"1.x.y","wrappedDekRecovery":null}', 'AAAAAAAAAAAAAAAAAAAAAA', 'argon2id13',
        '{"opslimit":3,"memlimit":67108864}', 'aes-256-gcm');
insert into public.records (id, vault_id, user_id, encrypted_payload) values (:RA, :VA, :A, :PAYLOAD);
insert into public.audit_events (user_id, event_type, record_id) values (:A, 'record_create', :RA);
select t.expect_count('select 1 from public.vaults', 1, 'A vê seu cofre');
select t.expect_count('select 1 from public.records', 1, 'A vê seu registro');
select t.expect_count('select 1 from public.profiles', 1, 'A vê só seu perfil');

-- 2) B cria os seus
select set_config('request.jwt.claim.sub', :B, false);
insert into public.vaults (id, user_id, encrypted_vault, salt, kdf_algorithm, kdf_parameters, encryption_algorithm)
values (:VB, :B, '{"wrappedDekMaster":"1.x.y"}', 'BBBBBBBBBBBBBBBBBBBBBB', 'argon2id13',
        '{"opslimit":3,"memlimit":67108864}', 'aes-256-gcm');
insert into public.records (id, vault_id, user_id, encrypted_payload) values (:RB, :VB, :B, :PAYLOAD);

-- 3) ISOLAMENTO: B não enxerga nada de A
select t.expect_count('select 1 from public.vaults', 1, 'B vê apenas 1 cofre (o seu)');
select t.expect_count('select 1 from public.vaults where user_id = ' || quote_literal(:A), 0, 'B não vê o cofre de A');
select t.expect_count('select 1 from public.records where id = ' || quote_literal(:RA), 0, 'B não vê registro de A');
select t.expect_count('select 1 from public.records where vault_id = ' || quote_literal(:VA), 0, 'B não lista registros do cofre de A');
select t.expect_count('select 1 from public.profiles where user_id = ' || quote_literal(:A), 0, 'B não vê perfil de A');
select t.expect_count('select 1 from public.audit_events', 0, 'B não vê eventos de A');

-- 4) B não escreve em nome de A
select t.expect_fail(format('insert into public.records (id, vault_id, user_id, encrypted_payload) values (gen_random_uuid(), %L, %L, %L)', :VA, :A, :PAYLOAD), 'row-level security');
select t.expect_fail(format('insert into public.records (id, vault_id, user_id, encrypted_payload) values (gen_random_uuid(), %L, %L, %L)', :VA, :B, :PAYLOAD), 'foreign key');
select t.expect_fail(format('insert into public.audit_events (user_id, event_type) values (%L, %L)', :A, 'vault_unlock'), 'row-level security');
select t.expect_fail(format('insert into public.vaults (id, user_id, encrypted_vault, salt, kdf_algorithm, kdf_parameters, encryption_algorithm) values (gen_random_uuid(), %L, %L, %L, %L, %L, %L)',
  :A, '{"wrappedDekMaster":"1.x.y"}', 'AAAAAAAAAAAAAAAAAAAAAA', 'argon2id13', '{"opslimit":3,"memlimit":67108864}', 'aes-256-gcm'), 'row-level security');

-- 5) B não altera nem apaga dados de A (0 linhas afetadas, sem erro)
do $$ declare n int; begin
  update public.records set encrypted_payload = '1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDD' where id = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: B alterou registro de A'; end if;
  delete from public.records where id = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: B apagou registro de A'; end if;
  delete from public.vaults where id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: B apagou cofre de A'; end if;
  raise notice 'ok   B não altera/apaga dados de A (0 linhas)';
end $$;

-- 6) B não consegue "doar" nem sequestrar linhas trocando user_id
select t.expect_fail(format('update public.records set user_id = %L where id = %L', :A, :RB), 'row-level security');

-- 7) restrições de formato: texto aberto e algoritmos fracos são rejeitados
select t.expect_fail(format('insert into public.records (id, vault_id, user_id, encrypted_payload) values (gen_random_uuid(), %L, %L, %L)', :VB, :B, 'minha-senha-em-texto-aberto'), 'check constraint');
select t.expect_fail(format('insert into public.records (id, vault_id, user_id, encrypted_payload) values (gen_random_uuid(), %L, %L, %L)', :VB, :B, '{"password":"123"}'), 'check constraint');
select t.expect_fail(format('update public.vaults set kdf_parameters = %L where id = %L', '{"opslimit":1,"memlimit":8192}', :VB), 'check constraint');
select t.expect_fail(format('update public.vaults set kdf_algorithm = %L where id = %L', 'sha256', :VB), 'check constraint');
select t.expect_fail(format('insert into public.vaults (id, user_id, encrypted_vault, salt, kdf_algorithm, kdf_parameters, encryption_algorithm) values (gen_random_uuid(), %L, %L, %L, %L, %L, %L)',
  :B, '{"wrappedDekMaster":"1.x.y"}', 'BBBBBBBBBBBBBBBBBBBBBB', 'argon2id13', '{"opslimit":3,"memlimit":67108864}', 'aes-256-gcm'), 'duplicate key');  -- 1 cofre por usuário

-- 8) histórico append-only: sem UPDATE/DELETE para o cliente
insert into public.audit_events (user_id, event_type) values (:B, 'vault_unlock');
select t.expect_fail('update public.audit_events set event_type = ''vault_lock''', 'permission denied');
select t.expect_fail('delete from public.audit_events', 'permission denied');
select t.expect_fail(format('insert into public.audit_events (user_id, event_type) values (%L, %L)', :B, 'senha=123'), 'check constraint');

-- 9) sessão sem usuário (auth.uid() nulo) não vê nada
select set_config('request.jwt.claim.sub', '', false);
select t.expect_count('select 1 from public.vaults', 0, 'sem uid: 0 cofres');
select t.expect_count('select 1 from public.records', 0, 'sem uid: 0 registros');

-- 10) papel anônimo: sem acesso algum
reset role; set role anon;
select t.expect_fail('select * from public.vaults', 'permission denied');
select t.expect_fail('select * from public.records', 'permission denied');
select t.expect_fail('select * from public.profiles', 'permission denied');
select t.expect_fail('select * from public.audit_events', 'permission denied');
select t.expect_fail(format('insert into public.records (id, vault_id, user_id, encrypted_payload) values (gen_random_uuid(), %L, %L, %L)', :VA, :A, :PAYLOAD), 'permission denied');
select t.expect_fail('select public.handle_new_user()', 'permission denied');

-- 11) authenticated não pode apagar/alterar perfis, nem chamar a função do gatilho
reset role; set role authenticated;
select set_config('request.jwt.claim.sub', :A, false);
select t.expect_fail('delete from public.profiles', 'permission denied');
select t.expect_fail('update public.profiles set user_id = user_id', 'permission denied');
select t.expect_fail('select public.handle_new_user()', 'permission denied');

-- 12) A atualiza o próprio registro; exclusão do usuário apaga tudo em cascata
update public.records set encrypted_payload = '1.EEEEEEEEEEEEEEEE.FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' where id = :RA;
reset role;
select t.expect_count('select 1 from public.records where updated_at >= created_at', 2, 'updated_at consistente');
delete from auth.users where id = :A;
select t.expect_count('select 1 from public.records where user_id = ' || quote_literal(:A), 0, 'cascata: registros de A apagados');
select t.expect_count('select 1 from public.vaults where user_id = ' || quote_literal(:A), 0, 'cascata: cofre de A apagado');
select t.expect_count('select 1 from public.records where user_id = ' || quote_literal(:B), 1, 'dados de B intactos');

-- 13) guarda geral: TODA tabela de public tem RLS ativa e forçada; anon sem privilégios
do $$ declare r record; begin
  for r in select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' loop
    if not (r.relrowsecurity and r.relforcerowsecurity) then
      raise exception 'FAIL: tabela % sem RLS ativa e forçada', r.relname;
    end if;
    if has_table_privilege('anon', 'public.' || r.relname, 'select,insert,update,delete') then
      raise exception 'FAIL: anon tem privilégio em %', r.relname;
    end if;
    raise notice 'ok   RLS ativa+forçada e anon sem acesso: %', r.relname;
  end loop;
end $$;

\echo 'RLS: TODOS OS TESTES PASSARAM'
