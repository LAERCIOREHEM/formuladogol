-- ============================================================================
-- Supabase — Bolão Brasileirão 2026: Execução 11
-- Apuração, auditoria e correções definitivas de login/PIN
--
-- Rode este arquivo no SQL Editor do Supabase após a Execução 10/hotfix.
-- Ele é idempotente e não apaga palpites.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- --------------------------------------------------------------------------
-- Correções de pgcrypto/search_path e ambiguidade de login
-- --------------------------------------------------------------------------
create or replace function public.br_token_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;

create or replace function public.br_validar_sessao(p_participante_id uuid, p_token text, p_exige_admin boolean default false)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return exists (
    select 1
    from public.br_sessoes s
    join public.br_participantes bp on bp.id = s.participante_id
    where s.participante_id = p_participante_id
      and s.token_hash = public.br_token_hash(p_token)
      and s.revogada = false
      and s.expira_em > now()
      and bp.ativo = true
      and (p_exige_admin = false or bp.admin = true)
  );
end;
$$;

grant execute on function public.br_validar_sessao(uuid,text,boolean) to anon;

create or replace function public.br_criar_admin_inicial(p_nome text, p_login text, p_pin text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.br_participantes bp where bp.admin = true) then
    raise exception 'Já existe administrador cadastrado.';
  end if;
  if length(coalesce(p_pin, '')) < 4 then
    raise exception 'PIN muito curto.';
  end if;

  insert into public.br_participantes (nome, login, pin_hash, ativo, admin)
  values (trim(p_nome), lower(trim(p_login)), extensions.crypt(p_pin, extensions.gen_salt('bf')), true, true)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.br_criar_admin_inicial(text,text,text) from public;

create or replace function public.br_login_participante(p_login text, p_pin text)
returns table (id uuid, nome text, login text, admin boolean, token text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_part public.br_participantes%rowtype;
  v_token text;
begin
  select bp.* into v_part
  from public.br_participantes bp
  where lower(bp.login) = lower(trim(p_login))
    and bp.ativo = true
  limit 1;

  if v_part.id is null or v_part.pin_hash <> extensions.crypt(p_pin, v_part.pin_hash) then
    raise exception 'Usuário ou PIN inválido.';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.br_sessoes (participante_id, token_hash)
  values (v_part.id, public.br_token_hash(v_token));

  update public.br_participantes bp
  set ultimo_login_em = now()
  where bp.id = v_part.id;

  return query select v_part.id, v_part.nome, v_part.login, v_part.admin, v_token;
end;
$$;

grant execute on function public.br_login_participante(text,text) to anon;

create or replace function public.br_salvar_palpites(p_participante_id uuid, p_token text, p_temporada int, p_rodada int, p_palpites jsonb)
returns table (hash_fechamento text, total_palpites int, atualizado_em timestamptz)
language plpgsql
security definer
set search_path = public, extensions
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

  select bp.* into v_part from public.br_participantes bp where bp.id = p_participante_id and bp.ativo = true;
  if v_part.id is null then raise exception 'Participante inválido.'; end if;

  select c.* into v_cfg from public.br_config_rodadas c where c.temporada = p_temporada and c.rodada = p_rodada;
  if v_cfg.rodada is null then
    raise exception 'Rodada % ainda não foi configurada pelo administrador.', p_rodada;
  end if;
  if v_cfg.status in ('fechada','apurada','publicada','bloqueada') or now() < v_cfg.abre_em or now() >= v_cfg.fecha_em then
    raise exception 'Rodada fora da janela de apostas.';
  end if;
  if jsonb_typeof(p_palpites) <> 'array' then raise exception 'Payload inválido.'; end if;

  v_total := jsonb_array_length(p_palpites);
  if v_total <= 0 then raise exception 'Nenhum palpite recebido.'; end if;

  v_payload_hash := encode(extensions.digest((p_temporada::text || '|' || p_rodada::text || '|' || p_participante_id::text || '|' || p_palpites::text), 'sha256'), 'hex');
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

  update public.br_config_rodadas c
  set total_jogos = greatest(coalesce(c.total_jogos,0), v_total), atualizado_em = now()
  where c.temporada = p_temporada and c.rodada = p_rodada;

  return query select v_hash, v_total, now();
end;
$$;

grant execute on function public.br_salvar_palpites(uuid,text,int,int,jsonb) to anon;

create or replace function public.br_admin_salvar_participante(
  p_admin_id uuid, p_token text, p_participante_id uuid, p_nome text, p_login text, p_pin text, p_admin boolean, p_ativo boolean
)
returns table (participante_id uuid, nome text, login text, ativo boolean, admin boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then raise exception 'Acesso admin inválido.'; end if;
  if coalesce(trim(p_nome),'') = '' or coalesce(trim(p_login),'') = '' then raise exception 'Nome e login são obrigatórios.'; end if;

  if p_participante_id is null then
    if length(coalesce(p_pin,'')) < 4 then raise exception 'PIN obrigatório para novo participante.'; end if;
    insert into public.br_participantes (nome, login, pin_hash, admin, ativo)
    values (trim(p_nome), lower(trim(p_login)), extensions.crypt(p_pin, extensions.gen_salt('bf')), coalesce(p_admin,false), coalesce(p_ativo,true))
    returning id into v_id;
  else
    v_id := p_participante_id;
    update public.br_participantes bp
    set nome = trim(p_nome), login = lower(trim(p_login)), admin = coalesce(p_admin,false), ativo = coalesce(p_ativo,true)
    where bp.id = v_id;
    if p_pin is not null and length(p_pin) >= 4 then
      update public.br_participantes bp set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')) where bp.id = v_id;
      update public.br_sessoes s set revogada = true where s.participante_id = v_id;
    end if;
  end if;

  return query select bp.id, bp.nome, bp.login, bp.ativo, bp.admin from public.br_participantes bp where bp.id = v_id;
end;
$$;

grant execute on function public.br_admin_salvar_participante(uuid,text,uuid,text,text,text,boolean,boolean) to anon;

-- --------------------------------------------------------------------------
-- Relatório de auditoria administrativa da rodada
-- --------------------------------------------------------------------------
create or replace function public.br_admin_relatorio_auditoria(
  p_admin_id uuid,
  p_token text,
  p_temporada int,
  p_rodada int,
  p_total_jogos int default 0
)
returns table (
  participante_id uuid,
  nome text,
  login text,
  ativo boolean,
  admin boolean,
  total_jogos int,
  total_palpites int,
  percentual numeric,
  hash_fechamento text,
  primeiro_envio timestamptz,
  ultimo_envio timestamptz,
  alteracoes int
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then
    raise exception 'Acesso admin inválido.';
  end if;

  return query
  with pbase as (
    select
      bp.id,
      bp.nome,
      bp.login,
      bp.ativo,
      bp.admin,
      count(distinct pp.event_id)::int as total_palpites,
      min(pp.criado_em) as primeiro_envio,
      max(pp.atualizado_em) as ultimo_envio
    from public.br_participantes bp
    left join public.br_palpites pp
      on pp.participante_id = bp.id
     and pp.temporada = p_temporada
     and pp.rodada = p_rodada
    where bp.ativo = true
    group by bp.id, bp.nome, bp.login, bp.ativo, bp.admin
  ), comp as (
    select distinct on (c.participante_id)
      c.participante_id,
      c.hash_fechamento
    from public.br_comprovantes c
    where c.temporada = p_temporada and c.rodada = p_rodada
    order by c.participante_id, c.atualizado_em desc
  ), aud as (
    select a.participante_id, count(*)::int as alteracoes
    from public.br_palpites_auditoria a
    where a.temporada = p_temporada and a.rodada = p_rodada
    group by a.participante_id
  )
  select
    pb.id as participante_id,
    pb.nome,
    pb.login,
    pb.ativo,
    pb.admin,
    greatest(coalesce(p_total_jogos, 0), coalesce(cfg.total_jogos, 0), pb.total_palpites)::int as total_jogos,
    pb.total_palpites,
    case when greatest(coalesce(p_total_jogos, 0), coalesce(cfg.total_jogos, 0), pb.total_palpites) > 0
      then round((pb.total_palpites::numeric / greatest(coalesce(p_total_jogos, 0), coalesce(cfg.total_jogos, 0), pb.total_palpites)::numeric) * 100, 1)
      else 0 end as percentual,
    comp.hash_fechamento,
    pb.primeiro_envio,
    pb.ultimo_envio,
    coalesce(aud.alteracoes, 0)::int as alteracoes
  from pbase pb
  left join comp on comp.participante_id = pb.id
  left join aud on aud.participante_id = pb.id
  left join public.br_config_rodadas cfg on cfg.temporada = p_temporada and cfg.rodada = p_rodada
  order by pb.nome;
end;
$$;

grant execute on function public.br_admin_relatorio_auditoria(uuid,text,int,int,int) to anon;

create or replace function public.br_admin_auditoria_eventos(
  p_admin_id uuid,
  p_token text,
  p_temporada int,
  p_rodada int
)
returns table (
  criado_em timestamptz,
  membro text,
  event_id text,
  acao text,
  hash_fechamento text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then
    raise exception 'Acesso admin inválido.';
  end if;

  return query
  select a.criado_em, a.membro, a.event_id, a.acao, a.hash_fechamento
  from public.br_palpites_auditoria a
  where a.temporada = p_temporada and a.rodada = p_rodada
  order by a.criado_em desc
  limit 500;
end;
$$;

grant execute on function public.br_admin_auditoria_eventos(uuid,text,int,int) to anon;

select 'EXECUCAO_11_APURACAO_AUDITORIA_OK' as status;
