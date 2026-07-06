-- ============================================================================
-- Supabase — Bolão Brasileirão 2026: Apostas Logadas V2
-- EXECUÇÃO 10
--
-- O que este script cria/corrige:
-- 1) participantes com usuário/PIN hashado;
-- 2) sessões temporárias por token;
-- 3) janelas por rodada controladas pelo admin;
-- 4) salvamento de palpites por RPC, sem expor placares dos outros;
-- 5) admin vê percentual preenchido, não os placares;
-- 6) comprovante/hash por envio;
-- 7) base de auditoria para a Execução 11.
--
-- Depois de rodar este SQL, crie o primeiro administrador no SQL Editor:
-- select public.br_criar_admin_inicial('Laércio', 'laercio', 'ESCOLHA_UM_PIN_DE_6_NUMEROS');
-- Não coloque o PIN real dentro do repositório.
-- ============================================================================

create extension if not exists pgcrypto;

-- Participantes / acessos
create table if not exists public.br_participantes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  login text not null unique,
  pin_hash text not null,
  ativo boolean not null default true,
  admin boolean not null default false,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  ultimo_login_em timestamptz
);

create table if not exists public.br_sessoes (
  id uuid primary key default gen_random_uuid(),
  participante_id uuid not null references public.br_participantes(id) on delete cascade,
  token_hash text not null,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default (now() + interval '45 days'),
  revogada boolean not null default false
);

create index if not exists br_sessoes_participante_idx on public.br_sessoes(participante_id);
create index if not exists br_sessoes_token_hash_idx on public.br_sessoes(token_hash);

-- Configuração de rodadas. Aproveita tabela antiga e adiciona campos.
create table if not exists public.br_config_rodadas (
  temporada int not null default 2026,
  rodada int not null check (rodada between 1 and 38),
  abre_em timestamptz not null,
  fecha_em timestamptz not null,
  observacao text,
  atualizado_em timestamptz not null default now(),
  primary key (temporada, rodada)
);

alter table public.br_config_rodadas add column if not exists publica_em timestamptz;
alter table public.br_config_rodadas add column if not exists status text not null default 'programada';
alter table public.br_config_rodadas add column if not exists total_jogos int not null default 0;

alter table public.br_config_rodadas
  drop constraint if exists br_config_rodadas_status_chk;
alter table public.br_config_rodadas
  add constraint br_config_rodadas_status_chk check (status in ('futura','programada','aberta','fechada','apurada','publicada','bloqueada'));

-- Palpites. Mantém a tabela antiga, mas adiciona colunas de segurança/auditoria.
create table if not exists public.br_palpites (
  id uuid primary key default gen_random_uuid(),
  temporada int not null default 2026,
  rodada int not null check (rodada between 1 and 38),
  event_id text not null,
  jogo_chave text,
  membro text not null,
  mandante text not null,
  visitante text not null,
  placar_mandante int not null check (placar_mandante between 0 and 30),
  placar_visitante int not null check (placar_visitante between 0 and 30),
  kickoff timestamptz,
  fecha_em timestamptz not null,
  origem text default 'site',
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint br_palpites_unico unique (temporada, rodada, event_id, membro)
);

alter table public.br_palpites add column if not exists participante_id uuid references public.br_participantes(id) on delete set null;
alter table public.br_palpites add column if not exists hash_fechamento text;
alter table public.br_palpites add column if not exists versao int not null default 2;

-- A execução 3 criou uma constraint por membro. Para a versão logada,
-- a chave correta é participante_id. Mantemos legado apenas para linhas antigas
-- sem participante_id, evitando conflito ao migrar para login/PIN.
alter table public.br_palpites drop constraint if exists br_palpites_unico;

create unique index if not exists br_palpites_unico_participante_idx
on public.br_palpites (temporada, rodada, event_id, participante_id)
where participante_id is not null;

create unique index if not exists br_palpites_unico_legado_membro_idx
on public.br_palpites (temporada, rodada, event_id, membro)
where participante_id is null;

create index if not exists br_palpites_rodada_idx on public.br_palpites (temporada, rodada);
create index if not exists br_palpites_participante_idx on public.br_palpites (participante_id);
create index if not exists br_palpites_evento_idx on public.br_palpites (event_id);

create table if not exists public.br_palpites_auditoria (
  id uuid primary key default gen_random_uuid(),
  temporada int not null,
  rodada int not null,
  event_id text not null,
  participante_id uuid,
  membro text,
  acao text not null,
  antes jsonb,
  depois jsonb,
  hash_fechamento text,
  criado_em timestamptz not null default now()
);

create table if not exists public.br_comprovantes (
  id uuid primary key default gen_random_uuid(),
  temporada int not null,
  rodada int not null,
  participante_id uuid not null references public.br_participantes(id) on delete cascade,
  total_palpites int not null default 0,
  hash_fechamento text not null,
  payload_hash text not null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (temporada, rodada, participante_id)
);

-- Triggers de updated_at
create or replace function public.br_set_atualizado_em()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;

drop trigger if exists br_participantes_set_atualizado_em on public.br_participantes;
create trigger br_participantes_set_atualizado_em
before update on public.br_participantes
for each row execute function public.br_set_atualizado_em();

drop trigger if exists br_palpites_set_atualizado_em on public.br_palpites;
create trigger br_palpites_set_atualizado_em
before update on public.br_palpites
for each row execute function public.br_set_atualizado_em();

-- Segurança básica: não expor tabelas sensíveis diretamente.
alter table public.br_participantes enable row level security;
alter table public.br_sessoes enable row level security;
alter table public.br_config_rodadas enable row level security;
alter table public.br_palpites enable row level security;
alter table public.br_palpites_auditoria enable row level security;
alter table public.br_comprovantes enable row level security;

-- Remove policies antigas permissivas.
drop policy if exists "br_palpites_select_public" on public.br_palpites;
drop policy if exists "br_palpites_insert_dentro_da_janela" on public.br_palpites;
drop policy if exists "br_palpites_update_dentro_da_janela" on public.br_palpites;
drop policy if exists "br_config_select_public" on public.br_config_rodadas;

-- Config da rodada pode ser lida pelo site. Placar dos outros, não.
create policy "br_config_select_public_v2"
on public.br_config_rodadas
for select
to anon
using (true);

-- Palpites só ficam diretamente selecionáveis quando a rodada estiver publicada/apurada.
create policy "br_palpites_select_publicados_v2"
on public.br_palpites
for select
to anon
using (
  exists (
    select 1
    from public.br_config_rodadas c
    where c.temporada = br_palpites.temporada
      and c.rodada = br_palpites.rodada
      and (
        c.status in ('publicada','apurada')
        or (c.publica_em is not null and now() >= c.publica_em)
      )
  )
);

-- Funções auxiliares
create or replace function public.br_token_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;

create or replace function public.br_validar_sessao(p_participante_id uuid, p_token text, p_exige_admin boolean default false)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1
    from public.br_sessoes s
    join public.br_participantes p on p.id = s.participante_id
    where s.participante_id = p_participante_id
      and s.token_hash = public.br_token_hash(p_token)
      and s.revogada = false
      and s.expira_em > now()
      and p.ativo = true
      and (p_exige_admin = false or p.admin = true)
  );
end;
$$;

-- Criação inicial do admin. Não é liberada para anon.
create or replace function public.br_criar_admin_inicial(p_nome text, p_login text, p_pin text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.br_participantes where admin = true) then
    raise exception 'Já existe administrador cadastrado.';
  end if;
  if length(coalesce(p_pin, '')) < 4 then
    raise exception 'PIN muito curto.';
  end if;
  insert into public.br_participantes (nome, login, pin_hash, ativo, admin)
  values (p_nome, lower(trim(p_login)), crypt(p_pin, gen_salt('bf')), true, true)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.br_criar_admin_inicial(text,text,text) from public;

-- Login público por usuário/PIN.
create or replace function public.br_login_participante(p_login text, p_pin text)
returns table (id uuid, nome text, login text, admin boolean, token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_part public.br_participantes%rowtype;
  v_token text;
begin
  select * into v_part
  from public.br_participantes
  where lower(login) = lower(trim(p_login))
    and ativo = true
  limit 1;

  if v_part.id is null or v_part.pin_hash <> crypt(p_pin, v_part.pin_hash) then
    raise exception 'Usuário ou PIN inválido.';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');

  insert into public.br_sessoes (participante_id, token_hash)
  values (v_part.id, public.br_token_hash(v_token));

  update public.br_participantes set ultimo_login_em = now() where id = v_part.id;

  return query select v_part.id, v_part.nome, v_part.login, v_part.admin, v_token;
end;
$$;

grant execute on function public.br_login_participante(text,text) to anon;

create or replace function public.br_listar_config_rodadas(p_temporada int default 2026)
returns table (temporada int, rodada int, abre_em timestamptz, fecha_em timestamptz, publica_em timestamptz, status text, observacao text, total_jogos int, atualizado_em timestamptz)
language sql
security definer
set search_path = public
as $$
  select c.temporada, c.rodada, c.abre_em, c.fecha_em, c.publica_em, c.status, c.observacao, c.total_jogos, c.atualizado_em
  from public.br_config_rodadas c
  where c.temporada = p_temporada
  order by c.rodada;
$$;

grant execute on function public.br_listar_config_rodadas(int) to anon;

-- Meus palpites: só com sessão válida do próprio participante.
create or replace function public.br_listar_meus_palpites(p_participante_id uuid, p_token text, p_rodada int, p_temporada int default 2026)
returns table (
  id uuid, temporada int, rodada int, event_id text, jogo_chave text, membro text, mandante text, visitante text,
  placar_mandante int, placar_visitante int, kickoff timestamptz, fecha_em timestamptz, hash_fechamento text,
  criado_em timestamptz, atualizado_em timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.br_validar_sessao(p_participante_id, p_token, false) then
    raise exception 'Sessão inválida.';
  end if;

  return query
  select p.id, p.temporada, p.rodada, p.event_id, p.jogo_chave, p.membro, p.mandante, p.visitante,
         p.placar_mandante, p.placar_visitante, p.kickoff, p.fecha_em, p.hash_fechamento, p.criado_em, p.atualizado_em
  from public.br_palpites p
  where p.temporada = p_temporada
    and p.rodada = p_rodada
    and p.participante_id = p_participante_id
  order by p.kickoff nulls last, p.mandante;
end;
$$;

grant execute on function public.br_listar_meus_palpites(uuid,text,int,int) to anon;

-- Salvar palpites. Recebe jsonb array do front.
create or replace function public.br_salvar_palpites(p_participante_id uuid, p_token text, p_temporada int, p_rodada int, p_palpites jsonb)
returns table (hash_fechamento text, total_palpites int, atualizado_em timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_part public.br_participantes%rowtype;
  v_cfg public.br_config_rodadas%rowtype;
  v_item jsonb;
  v_hash text;
  v_total int;
  v_payload_hash text;
  v_antigo jsonb;
begin
  if not public.br_validar_sessao(p_participante_id, p_token, false) then
    raise exception 'Sessão inválida.';
  end if;

  select * into v_part from public.br_participantes where id = p_participante_id and ativo = true;
  if v_part.id is null then raise exception 'Participante inválido.'; end if;

  select * into v_cfg from public.br_config_rodadas where temporada = p_temporada and rodada = p_rodada;
  if v_cfg.rodada is null then
    raise exception 'Rodada % ainda não foi configurada pelo administrador.', p_rodada;
  end if;
  if v_cfg.status in ('fechada','apurada','publicada','bloqueada') or now() < v_cfg.abre_em or now() >= v_cfg.fecha_em then
    raise exception 'Rodada fora da janela de apostas.';
  end if;
  if jsonb_typeof(p_palpites) <> 'array' then raise exception 'Payload inválido.'; end if;

  v_total := jsonb_array_length(p_palpites);
  if v_total <= 0 then raise exception 'Nenhum palpite recebido.'; end if;

  v_payload_hash := encode(digest((p_temporada::text || '|' || p_rodada::text || '|' || p_participante_id::text || '|' || p_palpites::text), 'sha256'), 'hex');
  v_hash := v_payload_hash;

  for v_item in select * from jsonb_array_elements(p_palpites)
  loop
    if coalesce((v_item->>'event_id'), '') = '' then raise exception 'Jogo sem event_id.'; end if;
    if (v_item->>'placar_mandante')::int < 0 or (v_item->>'placar_visitante')::int < 0 then raise exception 'Placar inválido.'; end if;
    if (v_item->>'placar_mandante')::int > 30 or (v_item->>'placar_visitante')::int > 30 then raise exception 'Placar muito alto.'; end if;

    select to_jsonb(p.*) into v_antigo
    from public.br_palpites p
    where p.temporada = p_temporada and p.rodada = p_rodada and p.event_id = (v_item->>'event_id') and p.participante_id = p_participante_id;

    insert into public.br_palpites (
      temporada, rodada, event_id, jogo_chave, participante_id, membro, mandante, visitante,
      placar_mandante, placar_visitante, kickoff, fecha_em, origem, hash_fechamento, versao
    ) values (
      p_temporada, p_rodada, v_item->>'event_id', v_item->>'jogo_chave', p_participante_id, v_part.nome,
      v_item->>'mandante', v_item->>'visitante', (v_item->>'placar_mandante')::int, (v_item->>'placar_visitante')::int,
      nullif(v_item->>'kickoff','')::timestamptz, v_cfg.fecha_em, 'site-logado', v_hash, 2
    )
    on conflict (temporada, rodada, event_id, participante_id) where participante_id is not null
    do update set
      jogo_chave = excluded.jogo_chave,
      membro = excluded.membro,
      mandante = excluded.mandante,
      visitante = excluded.visitante,
      placar_mandante = excluded.placar_mandante,
      placar_visitante = excluded.placar_visitante,
      kickoff = excluded.kickoff,
      fecha_em = excluded.fecha_em,
      origem = excluded.origem,
      hash_fechamento = excluded.hash_fechamento,
      versao = excluded.versao;

    insert into public.br_palpites_auditoria (temporada, rodada, event_id, participante_id, membro, acao, antes, depois, hash_fechamento)
    values (p_temporada, p_rodada, v_item->>'event_id', p_participante_id, v_part.nome, case when v_antigo is null then 'insert' else 'update' end, v_antigo, v_item, v_hash);
  end loop;

  insert into public.br_comprovantes (temporada, rodada, participante_id, total_palpites, hash_fechamento, payload_hash)
  values (p_temporada, p_rodada, p_participante_id, v_total, v_hash, v_payload_hash)
  on conflict (temporada, rodada, participante_id)
  do update set total_palpites = excluded.total_palpites,
                hash_fechamento = excluded.hash_fechamento,
                payload_hash = excluded.payload_hash,
                atualizado_em = now();

  update public.br_config_rodadas
  set total_jogos = greatest(coalesce(total_jogos,0), v_total), atualizado_em = now()
  where temporada = p_temporada and rodada = p_rodada;

  return query select v_hash, v_total, now();
end;
$$;

grant execute on function public.br_salvar_palpites(uuid,text,int,int,jsonb) to anon;

-- Palpites públicos: só retorna se a rodada estiver publicada/apurada.
create or replace function public.br_listar_palpites_publicos(p_rodada int, p_temporada int default 2026)
returns table (membro text, event_id text, mandante text, visitante text, placar_mandante int, placar_visitante int, hash_fechamento text, criado_em timestamptz, atualizado_em timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.br_config_rodadas c
    where c.temporada = p_temporada and c.rodada = p_rodada
      and (c.status in ('publicada','apurada') or (c.publica_em is not null and now() >= c.publica_em))
  ) then
    return;
  end if;

  return query
  select p.membro, p.event_id, p.mandante, p.visitante, p.placar_mandante, p.placar_visitante, p.hash_fechamento, p.criado_em, p.atualizado_em
  from public.br_palpites p
  where p.temporada = p_temporada and p.rodada = p_rodada
  order by p.membro, p.kickoff nulls last, p.mandante;
end;
$$;

grant execute on function public.br_listar_palpites_publicos(int,int) to anon;

-- Funções admin
create or replace function public.br_admin_listar_participantes(p_admin_id uuid, p_token text)
returns table (participante_id uuid, nome text, login text, ativo boolean, admin boolean, criado_em timestamptz, ultimo_login_em timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then raise exception 'Acesso admin inválido.'; end if;
  return query select p.id, p.nome, p.login, p.ativo, p.admin, p.criado_em, p.ultimo_login_em
  from public.br_participantes p order by p.nome;
end;
$$;

grant execute on function public.br_admin_listar_participantes(uuid,text) to anon;

create or replace function public.br_admin_salvar_participante(
  p_admin_id uuid, p_token text, p_participante_id uuid, p_nome text, p_login text, p_pin text, p_admin boolean, p_ativo boolean
)
returns table (participante_id uuid, nome text, login text, ativo boolean, admin boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then raise exception 'Acesso admin inválido.'; end if;
  if coalesce(trim(p_nome),'') = '' or coalesce(trim(p_login),'') = '' then raise exception 'Nome e login são obrigatórios.'; end if;

  if p_participante_id is null then
    if length(coalesce(p_pin,'')) < 4 then raise exception 'PIN obrigatório para novo participante.'; end if;
    insert into public.br_participantes (nome, login, pin_hash, admin, ativo)
    values (trim(p_nome), lower(trim(p_login)), crypt(p_pin, gen_salt('bf')), coalesce(p_admin,false), coalesce(p_ativo,true))
    returning id into v_id;
  else
    v_id := p_participante_id;
    update public.br_participantes
    set nome = trim(p_nome), login = lower(trim(p_login)), admin = coalesce(p_admin,false), ativo = coalesce(p_ativo,true)
    where id = v_id;
    if p_pin is not null and length(p_pin) >= 4 then
      update public.br_participantes set pin_hash = crypt(p_pin, gen_salt('bf')) where id = v_id;
      update public.br_sessoes set revogada = true where participante_id = v_id;
    end if;
  end if;

  return query select p.id, p.nome, p.login, p.ativo, p.admin from public.br_participantes p where p.id = v_id;
end;
$$;

grant execute on function public.br_admin_salvar_participante(uuid,text,uuid,text,text,text,boolean,boolean) to anon;

create or replace function public.br_admin_definir_rodada(
  p_admin_id uuid, p_token text, p_temporada int, p_rodada int,
  p_abre_em timestamptz, p_fecha_em timestamptz, p_publica_em timestamptz, p_status text, p_observacao text
)
returns table (temporada int, rodada int, abre_em timestamptz, fecha_em timestamptz, publica_em timestamptz, status text, observacao text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then raise exception 'Acesso admin inválido.'; end if;
  if p_rodada < 20 or p_rodada > 38 then raise exception 'Rodada fora do intervalo do bolão.'; end if;
  if p_abre_em is null or p_fecha_em is null or p_fecha_em <= p_abre_em then raise exception 'Janela inválida.'; end if;
  if coalesce(p_status,'') not in ('futura','programada','aberta','fechada','apurada','publicada','bloqueada') then raise exception 'Status inválido.'; end if;

  insert into public.br_config_rodadas (temporada, rodada, abre_em, fecha_em, publica_em, status, observacao, atualizado_em)
  values (p_temporada, p_rodada, p_abre_em, p_fecha_em, p_publica_em, p_status, p_observacao, now())
  on conflict (temporada, rodada)
  do update set abre_em = excluded.abre_em,
                fecha_em = excluded.fecha_em,
                publica_em = excluded.publica_em,
                status = excluded.status,
                observacao = excluded.observacao,
                atualizado_em = now();

  return query select c.temporada, c.rodada, c.abre_em, c.fecha_em, c.publica_em, c.status, c.observacao
  from public.br_config_rodadas c where c.temporada = p_temporada and c.rodada = p_rodada;
end;
$$;

grant execute on function public.br_admin_definir_rodada(uuid,text,int,int,timestamptz,timestamptz,timestamptz,text,text) to anon;

create or replace function public.br_admin_progresso_rodada(p_admin_id uuid, p_token text, p_temporada int, p_rodada int, p_total_jogos int)
returns table (participante_id uuid, nome text, login text, ativo boolean, admin boolean, total_palpites int, total_jogos int, percentual numeric)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then raise exception 'Acesso admin inválido.'; end if;
  return query
  select p.id, p.nome, p.login, p.ativo, p.admin,
         coalesce(count(pl.id)::int, 0) as total_palpites,
         greatest(coalesce(p_total_jogos, 0), 0) as total_jogos,
         case when coalesce(p_total_jogos, 0) <= 0 then 0 else round((count(pl.id)::numeric / p_total_jogos::numeric) * 100, 1) end as percentual
  from public.br_participantes p
  left join public.br_palpites pl on pl.participante_id = p.id and pl.temporada = p_temporada and pl.rodada = p_rodada
  where p.ativo = true
  group by p.id, p.nome, p.login, p.ativo, p.admin
  order by p.nome;
end;
$$;

grant execute on function public.br_admin_progresso_rodada(uuid,text,int,int,int) to anon;

-- Seed da Rodada 20. Ajustável depois pelo Admin.
insert into public.br_config_rodadas (temporada, rodada, abre_em, fecha_em, publica_em, status, observacao)
values (2026, 20, '2026-07-23 00:00:00-03', '2026-07-25 10:00:00-03', null, 'programada', 'Primeira rodada do bolão de placares após a Copa')
on conflict (temporada, rodada) do update
set abre_em = excluded.abre_em,
    fecha_em = excluded.fecha_em,
    status = excluded.status,
    observacao = excluded.observacao,
    atualizado_em = now();

-- Validações rápidas pós-SQL:
-- select public.br_criar_admin_inicial('Laércio', 'laercio', '123456'); -- troque o PIN antes de executar
-- select * from public.br_config_rodadas where temporada = 2026 and rodada = 20;
