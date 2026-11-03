-- ELO — backend Supabase (modo nuvem). Tabelas em schema privado; acesso apenas via RPC (security definer).
create extension if not exists pgcrypto with schema extensions;
create schema if not exists elo;
alter default privileges in schema elo revoke execute on functions from public;
create sequence if not exists elo.rev;

create table elo.users (
  id text primary key, device_id text not null unique, name text not null,
  role text not null default 'user' check (role in ('user','admin')),
  status text not null default 'unknown', token_hash text, banned boolean not null default false,
  created_at bigint not null, last_seen bigint not null default 0, loc jsonb,
  rev bigint not null default nextval('elo.rev')
);
create index on elo.users (rev);
create table elo.messages (
  seq bigint generated always as identity primary key, id text not null unique, ch text not null,
  from_id text not null references elo.users(id), kind text not null, text text not null default '',
  img text, loc jsonb, cts bigint not null, sts bigint not null, deleted boolean not null default false, del_rev bigint
);
create index on elo.messages (ch, seq);
create index on elo.messages (del_rev) where del_rev is not null;
create table elo.trails (user_id text not null references elo.users(id), ts bigint not null, lat double precision not null, lng double precision not null, acc int not null default 0, primary key (user_id, ts));
create table elo.reads (ch text not null, user_id text not null, seq bigint not null, primary key (ch, user_id));
create table elo.settings (key text primary key, value jsonb not null);
create table elo.locate_req (user_id text primary key, ts bigint not null);
create table elo.attempts (key text not null, ts bigint not null);
create index on elo.attempts (key, ts);
alter table elo.users enable row level security; alter table elo.messages enable row level security;
alter table elo.trails enable row level security; alter table elo.reads enable row level security;
alter table elo.settings enable row level security; alter table elo.locate_req enable row level security;
alter table elo.attempts enable row level security;

-- ---------- helpers (schema privado) ----------
create function elo.ms() returns bigint language sql set search_path='' as $$ select (extract(epoch from clock_timestamp())*1000)::bigint $$;
create function elo.num(t text) returns double precision language plpgsql immutable set search_path='' as $$ begin return t::double precision; exception when others then return null; end $$;
create function elo.cfg() returns jsonb language sql set search_path='' as $$ select coalesce((select value from elo.settings where key='cfg'),'{}'::jsonb) $$;
create function elo.share() returns boolean language sql set search_path='' as $$ select coalesce((elo.cfg()->>'shareMap')::boolean,false) $$;

create function elo.ratelimit(p_key text, p_max int, p_window bigint) returns boolean language plpgsql set search_path='' as $$
declare n int; t bigint := elo.ms();
begin
  select count(*) into n from elo.attempts where key = p_key and ts > t - p_window;
  if n >= p_max then return false; end if;
  insert into elo.attempts values (p_key, t);
  if random() < 0.05 then delete from elo.attempts where ts < t - 3600000; end if;
  return true;
end $$;

create function elo.client_ip() returns text language sql set search_path='' as $$
  select coalesce(nullif(btrim(split_part(coalesce(nullif(current_setting('request.headers', true),''),'{}')::jsonb->>'x-forwarded-for', ',', 1)),''),'unknown') $$;

create function elo.auth(p_token text) returns elo.users language plpgsql security definer set search_path='' as $$
declare u elo.users;
begin
  if p_token is null or length(p_token) < 20 then raise exception 'auth'; end if;
  select * into u from elo.users where token_hash = encode(extensions.digest(p_token,'sha256'),'hex');
  if not found then raise exception 'auth'; end if;
  if u.banned then raise exception 'banned'; end if;
  return u;
end $$;

create function elo.pub_user(u elo.users, v elo.users, p_now bigint) returns jsonb language sql set search_path='' as $$
  select jsonb_build_object('id',u.id,'name',u.name,'role',u.role,'status',u.status,'online',(p_now - u.last_seen) < 30000,'lastSeen',u.last_seen,'rev',u.rev)
   || case when v.role='admin' then jsonb_build_object('banned',u.banned) else '{}'::jsonb end
   || case when u.loc is not null and (v.role='admin' or elo.share()) then jsonb_build_object('loc',u.loc) else '{}'::jsonb end $$;

create function elo.pub_settings(v elo.users) returns jsonb language sql set search_path='' as $$
  select jsonb_build_object('shareMap',elo.share(),'groupName',coalesce(elo.cfg()->>'groupName','Geral'),'motd',coalesce(elo.cfg()->>'motd',''))
   || case when v.role='admin' then jsonb_build_object('accessCode',coalesce(elo.cfg()->>'accessCode','')) else '{}'::jsonb end $$;

create function elo.apply_loc(u elo.users, p jsonb) returns void language plpgsql set search_path='' as $$
declare v_lat double precision := elo.num(p->>'lat'); v_lng double precision := elo.num(p->>'lng');
        v_now bigint := elo.ms(); v_ts bigint; v_acc int; v_loc jsonb;
begin
  if v_lat is null or v_lng is null or abs(v_lat) > 90 or abs(v_lng) > 180 then return; end if;
  v_ts := coalesce(elo.num(p->>'ts')::bigint, v_now);
  if v_ts > v_now + 3600000 then v_ts := v_now; end if;
  v_acc := greatest(0, coalesce(round(elo.num(p->>'acc')),0))::int;
  v_loc := jsonb_build_object('lat',v_lat,'lng',v_lng,'acc',v_acc,'ts',v_ts);
  if elo.num(p->>'spd') is not null then v_loc := v_loc || jsonb_build_object('spd', round((elo.num(p->>'spd'))::numeric,1)); end if;
  if elo.num(p->>'hdg') is not null then v_loc := v_loc || jsonb_build_object('hdg', round(elo.num(p->>'hdg'))); end if;
  if elo.num(p->>'alt') is not null then v_loc := v_loc || jsonb_build_object('alt', round(elo.num(p->>'alt'))); end if;
  if elo.num(p->>'bat') is not null then v_loc := v_loc || jsonb_build_object('bat', least(100, greatest(0, round(elo.num(p->>'bat'))))); end if;
  if p->>'chg' in ('true','false') then v_loc := v_loc || jsonb_build_object('chg', (p->>'chg')::boolean); end if;
  insert into elo.trails(user_id, ts, lat, lng, acc) values (u.id, v_ts, v_lat, v_lng, v_acc) on conflict do nothing;
  update elo.users x set loc = v_loc, rev = nextval('elo.rev') where x.id = u.id and (x.loc is null or (x.loc->>'ts')::bigint <= v_ts);
  if random() < 0.02 then
    delete from elo.trails t where t.user_id = u.id and t.ts < (select t2.ts from elo.trails t2 where t2.user_id = u.id order by t2.ts desc offset 500 limit 1);
  end if;
end $$;

-- ---------- API pública (RPC) ----------
create function public.elo_info() returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('app','elo','version','1.0.0','backend','supabase','needsCode',coalesce(elo.cfg()->>'accessCode','') <> '','secure',true,'tls',false,
    'tiles',jsonb_build_array('https://tile.openstreetmap.org/{z}/{x}/{y}.png'),'time',elo.ms()) $$;

create function public.elo_join(p_name text, p_device text, p_code text default '', p_admin_pw text default '') returns jsonb language plpgsql security definer set search_path='' as $$
declare v_ip text := elo.client_ip(); v_name text; u elo.users; v_token text; v_hash text; v_exists boolean;
        v_admin boolean := coalesce(p_admin_pw,'') <> ''; v_now bigint := elo.ms();
begin
  if not elo.ratelimit('join:'||v_ip, 60, 600000) then return jsonb_build_object('error','rate'); end if;
  v_name := left(btrim(regexp_replace(regexp_replace(coalesce(p_name,''), '[\x01-\x1f\x7f]', '', 'g'), '\s+', ' ', 'g')), 40);
  if v_name = '' then return jsonb_build_object('error','name'); end if;
  if coalesce(p_device,'') !~ '^[A-Za-z0-9_-]{8,64}$' then return jsonb_build_object('error','device'); end if;
  if v_admin then
    if not (elo.ratelimit('adm:'||v_ip, 8, 600000) and elo.ratelimit('admd:'||p_device, 8, 600000)) then return jsonb_build_object('error','rate'); end if;
    select value #>> '{}' into v_hash from elo.settings where key = 'admin_hash';
    if v_hash is null or extensions.crypt(p_admin_pw, v_hash) <> v_hash then return jsonb_build_object('error','admin_password'); end if;
  elsif coalesce(elo.cfg()->>'accessCode','') <> '' and btrim(coalesce(p_code,'')) <> elo.cfg()->>'accessCode' then
    return jsonb_build_object('error','code');
  end if;
  select * into u from elo.users where device_id = p_device;
  v_exists := found;
  if v_exists then
    if u.banned then return jsonb_build_object('error','banned'); end if;
    if u.role = 'admin' and not v_admin then return jsonb_build_object('error','admin_required'); end if;
  end if;
  v_token := encode(extensions.gen_random_bytes(24),'hex');
  if v_exists then
    update elo.users x set name = v_name, role = case when v_admin then 'admin' else x.role end, token_hash = encode(extensions.digest(v_token,'sha256'),'hex'),
      last_seen = v_now, rev = nextval('elo.rev') where x.id = u.id returning * into u;
  else
    insert into elo.users(id, device_id, name, role, token_hash, created_at, last_seen)
    values (encode(extensions.gen_random_bytes(6),'hex'), p_device, v_name, case when v_admin then 'admin' else 'user' end, encode(extensions.digest(v_token,'sha256'),'hex'), v_now, v_now) returning * into u;
  end if;
  return jsonb_build_object('token', v_token, 'user', elo.pub_user(u, u, v_now));
end $$;

create function public.elo_poll(p_token text, p_since_seq bigint default 0, p_since_users bigint default 0, p_since_del bigint default 0) returns jsonb language plpgsql security definer set search_path='' as $$
declare u elo.users := elo.auth(p_token); v_now bigint := elo.ms(); v_msgs jsonb; v_users jsonb; v_dels jsonb; v_reads jsonb; v_seen jsonb; v_locate boolean;
begin
  update elo.users set last_seen = v_now where id = u.id;
  select coalesce(jsonb_agg(j order by (j->>'seq')::bigint), '[]'::jsonb) into v_msgs from (
    select jsonb_build_object('seq',m.seq,'id',m.id,'ch',m.ch,'from',m.from_id,'kind',m.kind,'text',m.text,'img',m.img,'loc',m.loc,'cts',m.cts,'sts',m.sts)
           || case when m.deleted then jsonb_build_object('deleted',true) else '{}'::jsonb end as j
    from elo.messages m
    where m.seq > greatest(0, p_since_seq - case when p_since_seq > 0 then 20 else 0 end)
      and (m.ch in ('general','alerts') or (m.ch like 'dm:%' and (split_part(m.ch,':',2) = u.id or split_part(m.ch,':',3) = u.id)))
    order by m.seq desc limit 300) q;
  select coalesce(jsonb_agg(elo.pub_user(x, u, v_now)), '[]'::jsonb) into v_users from elo.users x
    where x.rev > greatest(0, p_since_users - 20) and (u.role = 'admin' or not x.banned);
  select coalesce(jsonb_agg(m.id), '[]'::jsonb) into v_dels from elo.messages m
    where m.del_rev is not null and m.del_rev > greatest(0, p_since_del - 20)
      and (m.ch in ('general','alerts') or (m.ch like 'dm:%' and (split_part(m.ch,':',2) = u.id or split_part(m.ch,':',3) = u.id)));
  select coalesce(jsonb_agg(jsonb_build_object('ch',r.ch,'by',r.user_id,'seq',r.seq)), '[]'::jsonb) into v_reads from elo.reads r
    where r.user_id <> u.id and (split_part(r.ch,':',2) = u.id or split_part(r.ch,':',3) = u.id);
  select coalesce(jsonb_object_agg(x.id, x.last_seen), '{}'::jsonb) into v_seen from elo.users x where not x.banned;
  with d as (delete from elo.locate_req where user_id = u.id returning 1) select exists(select 1 from d) into v_locate;
  return jsonb_build_object('now', v_now, 'me', elo.pub_user(u, u, v_now), 'settings', elo.pub_settings(u),
    'seq', coalesce((select max(seq) from elo.messages),0), 'msgs', v_msgs, 'users', v_users,
    'ucur', coalesce((select max(rev) from elo.users),0), 'dels', v_dels,
    'dcur', coalesce((select max(del_rev) from elo.messages),0), 'reads', v_reads, 'seen', v_seen, 'locate', v_locate);
end $$;

create function public.elo_send(p_token text, p_msg jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u elo.users := elo.auth(p_token); v_id text := p_msg->>'id'; v_ch text := coalesce(p_msg->>'ch',''); v_kind text := coalesce(p_msg->>'kind','text');
        v_text text := left(coalesce(p_msg->>'text',''), 4000); v_img text; v_loc jsonb; v_cts bigint; v_a text; v_b text; v_o elo.users;
        v_m elo.messages; v_lat double precision; v_lng double precision;
  ack constant text := 'ack';
begin
  if coalesce(v_id,'') !~ '^[A-Za-z0-9_-]{8,64}$' then return jsonb_build_object('nack', jsonb_build_object('id', v_id, 'reason','id')); end if;
  select * into v_m from elo.messages where id = v_id;
  if found then return jsonb_build_object('ack', jsonb_build_object('id', v_id, 'seq', v_m.seq, 'sts', v_m.sts)); end if;
  if (select count(*) from elo.messages where from_id = u.id and sts > elo.ms() - 10000) >= 20 then return jsonb_build_object('nack', jsonb_build_object('id', v_id, 'reason','rate')); end if;
  if v_kind not in ('text','image','sos','loc') then v_kind := 'text'; end if;
  if v_ch = 'alerts' then
    if u.role <> 'admin' then return jsonb_build_object('nack', jsonb_build_object('id', v_id, 'reason','forbidden')); end if;
  elsif v_ch = 'general' then null;
  elsif v_ch ~ '^dm:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$' then
    v_a := split_part(v_ch,':',2); v_b := split_part(v_ch,':',3);
    if v_a > v_b or (v_a <> u.id and v_b <> u.id) then return jsonb_build_object('nack', jsonb_build_object('id', v_id, 'reason','forbidden')); end if;
    select * into v_o from elo.users where id = case when v_a = u.id then v_b else v_a end;
    if not found or v_o.banned or v_o.id = u.id then return jsonb_build_object('nack', jsonb_build_object('id', v_id, 'reason','forbidden')); end if;
  else return jsonb_build_object('nack', jsonb_build_object('id', v_id, 'reason','channel'));
  end if;
  if v_kind = 'image' then
    v_img := p_msg->>'img';
    if v_img is null or length(v_img) > 180000 or v_img !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' then return jsonb_build_object('nack', jsonb_build_object('id', v_id, 'reason','image')); end if;
  end if;
  if v_kind in ('loc','sos') then
    v_lat := elo.num(p_msg->'loc'->>'lat'); v_lng := elo.num(p_msg->'loc'->>'lng');
    if v_lat is not null and v_lng is not null and abs(v_lat) <= 90 and abs(v_lng) <= 180 then
      v_loc := jsonb_build_object('lat', v_lat, 'lng', v_lng, 'acc', greatest(0, coalesce(elo.num(p_msg->'loc'->>'acc'),0)));
    elsif v_kind = 'loc' then return jsonb_build_object('nack', jsonb_build_object('id', v_id, 'reason','loc'));
    end if;
  end if;
  if v_kind = 'sos' and v_ch <> 'general' then return jsonb_build_object('nack', jsonb_build_object('id', v_id, 'reason','channel')); end if;
  if v_kind = 'text' and btrim(v_text) = '' then return jsonb_build_object('nack', jsonb_build_object('id', v_id, 'reason','empty')); end if;
  v_cts := coalesce(elo.num(p_msg->>'cts')::bigint, elo.ms());
  insert into elo.messages(id, ch, from_id, kind, text, img, loc, cts, sts) values (v_id, v_ch, u.id, v_kind, v_text, v_img, v_loc, v_cts, elo.ms())
    on conflict (id) do nothing returning * into v_m;
  if not found then select * into v_m from elo.messages where id = v_id; end if;
  if v_kind = 'sos' then
    update elo.users x set status = 'sos', rev = nextval('elo.rev') where x.id = u.id;
    if v_loc is not null then perform elo.apply_loc(u, v_loc || jsonb_build_object('ts', elo.ms())); end if;
  end if;
  return jsonb_build_object('ack', jsonb_build_object('id', v_id, 'seq', v_m.seq, 'sts', v_m.sts));
end $$;

create function public.elo_loc(p_token text, p_points jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u elo.users := elo.auth(p_token); p jsonb; n int := 0; v_ts bigint := 0;
begin
  if jsonb_typeof(p_points) <> 'array' then return jsonb_build_object('n',0); end if;
  for p in select e from jsonb_array_elements(p_points) e order by coalesce(elo.num(e->>'ts'),0) limit 120 loop
    perform elo.apply_loc(u, p); n := n + 1; v_ts := greatest(v_ts, coalesce(elo.num(p->>'ts')::bigint, 0));
  end loop;
  return jsonb_build_object('n', n, 'ts', v_ts);
end $$;

create function public.elo_status(p_token text, p_status text) returns void language plpgsql security definer set search_path='' as $$
declare u elo.users := elo.auth(p_token);
begin
  if p_status in ('unknown','safe','help','injured') then update elo.users set status = p_status, rev = nextval('elo.rev') where id = u.id; end if;
end $$;

create function public.elo_rename(p_token text, p_name text) returns void language plpgsql security definer set search_path='' as $$
declare u elo.users := elo.auth(p_token); v_name text := left(btrim(regexp_replace(regexp_replace(coalesce(p_name,''), '[\x01-\x1f\x7f]', '', 'g'), '\s+', ' ', 'g')), 40);
begin
  if v_name <> '' then update elo.users set name = v_name, rev = nextval('elo.rev') where id = u.id; end if;
end $$;

create function public.elo_read(p_token text, p_ch text, p_seq bigint) returns void language plpgsql security definer set search_path='' as $$
declare u elo.users := elo.auth(p_token);
begin
  if p_ch ~ '^dm:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$' and (split_part(p_ch,':',2) = u.id or split_part(p_ch,':',3) = u.id) then
    insert into elo.reads(ch, user_id, seq) values (p_ch, u.id, p_seq) on conflict (ch, user_id) do update set seq = greatest(elo.reads.seq, excluded.seq);
  end if;
end $$;

create function public.elo_trail(p_token text, p_uid text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u elo.users := elo.auth(p_token);
begin
  if u.role <> 'admin' and p_uid <> u.id then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_array(t.ts, t.lat, t.lng, t.acc) order by t.ts) from (select * from elo.trails where user_id = p_uid order by ts desc limit 500) t), '[]'::jsonb);
end $$;

create function public.elo_admin(p_token text, p_op text, p_args jsonb default '{}') returns void language plpgsql security definer set search_path='' as $$
declare u elo.users := elo.auth(p_token); v_cfg jsonb; v_now bigint := elo.ms();
begin
  if u.role <> 'admin' then raise exception 'forbidden'; end if;
  if p_op = 'setting' then
    v_cfg := elo.cfg();
    if p_args ? 'accessCode' then v_cfg := v_cfg || jsonb_build_object('accessCode', left(btrim(p_args->>'accessCode'), 40)); end if;
    if p_args ? 'shareMap' then v_cfg := v_cfg || jsonb_build_object('shareMap', (p_args->>'shareMap')::boolean); end if;
    if p_args ? 'groupName' and btrim(p_args->>'groupName') <> '' then v_cfg := v_cfg || jsonb_build_object('groupName', left(btrim(p_args->>'groupName'), 30)); end if;
    if p_args ? 'motd' then v_cfg := v_cfg || jsonb_build_object('motd', left(p_args->>'motd', 280)); end if;
    insert into elo.settings(key, value) values ('cfg', v_cfg) on conflict (key) do update set value = excluded.value;
    if p_args ? 'shareMap' then update elo.users set rev = nextval('elo.rev'); end if;
  elsif p_op in ('ban','unban') then
    update elo.users set banned = (p_op = 'ban'), rev = nextval('elo.rev') where id = p_args->>'uid' and role <> 'admin';
  elsif p_op = 'clear_sos' then
    update elo.users set status = 'unknown', rev = nextval('elo.rev') where id = p_args->>'uid';
  elsif p_op = 'locate' then
    insert into elo.locate_req(user_id, ts) select x.id, v_now from elo.users x
      where x.id <> u.id and ((p_args->>'uid' = 'all' and x.last_seen > v_now - 30000) or x.id = p_args->>'uid')
      on conflict (user_id) do update set ts = excluded.ts;
  elsif p_op = 'del_msg' then
    update elo.messages set deleted = true, text = '', img = null, loc = null, del_rev = nextval('elo.rev') where id = p_args->>'id';
  end if;
end $$;

create function public.elo_export(p_token text, p_kind text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u elo.users := elo.auth(p_token);
begin
  if u.role <> 'admin' then raise exception 'forbidden'; end if;
  if p_kind = 'geojson' then
    return jsonb_build_object('type','FeatureCollection','features', coalesce((
      select jsonb_agg(f) from (
        select jsonb_build_object('type','Feature','geometry',jsonb_build_object('type','Point','coordinates',jsonb_build_array((x.loc->>'lng')::float,(x.loc->>'lat')::float)),
          'properties',jsonb_build_object('id',x.id,'name',x.name,'role',x.role,'status',x.status,'ts',x.loc->'ts','acc',x.loc->'acc','bat',x.loc->'bat')) f
        from elo.users x where x.loc is not null
        union all
        select jsonb_build_object('type','Feature','geometry',jsonb_build_object('type','LineString','coordinates',jsonb_agg(jsonb_build_array(t.lng,t.lat) order by t.ts)),
          'properties',jsonb_build_object('id',x.id,'name',x.name,'kind','trail'))
        from elo.users x join elo.trails t on t.user_id = x.id group by x.id, x.name having count(*) > 1) s), '[]'::jsonb));
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('seq',m.seq,'sts',m.sts,'ch',m.ch,'from',coalesce(x.name,m.from_id),'kind',m.kind,'text',m.text,
    'lat',m.loc->'lat','lng',m.loc->'lng') order by m.seq) from (select * from elo.messages order by seq desc limit 10000) m left join elo.users x on x.id = m.from_id), '[]'::jsonb);
end $$;

create function public.elo_set_admin_password(p_token text, p_new text) returns void language plpgsql security definer set search_path='' as $$
declare u elo.users := elo.auth(p_token);
begin
  if u.role <> 'admin' then raise exception 'forbidden'; end if;
  if length(coalesce(p_new,'')) < 8 then raise exception 'weak'; end if;
  insert into elo.settings(key, value) values ('admin_hash', to_jsonb(extensions.crypt(p_new, extensions.gen_salt('bf')))) on conflict (key) do update set value = excluded.value;
end $$;

-- ---------- permissões: somente as RPCs públicas ficam acessíveis ----------
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'elo' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'elo\_%' loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('grant execute on function %s to anon, authenticated', r.sig);
  end loop;
end $$;
