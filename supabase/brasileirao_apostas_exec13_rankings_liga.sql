-- ============================================================================
-- Supabase — Bolão Brasileirão 2026: EXECUÇÃO 13
-- Ranking, palpites públicos, progresso e auditoria filtrados por liga.
--
-- Rode no SQL Editor depois da Execução 12.
-- Script idempotente. Não apaga participantes, palpites, ligas ou auditorias.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- --------------------------------------------------------------------------
-- Helper: membro de liga / admin global
-- --------------------------------------------------------------------------
create or replace function public.br_pode_ver_liga(p_participante_id uuid, p_liga_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.br_participantes p
    where p.id = p_participante_id and p.ativo = true and p.admin = true
  )
  or exists (
    select 1
    from public.br_liga_participantes lp
    join public.br_ligas l on l.id = lp.liga_id
    join public.br_participantes p on p.id = lp.participante_id
    where lp.participante_id = p_participante_id
      and lp.liga_id = p_liga_id
      and lp.ativo = true
      and l.ativa = true
      and p.ativo = true
  );
$$;

grant execute on function public.br_pode_ver_liga(uuid,uuid) to anon;

-- --------------------------------------------------------------------------
-- Palpites públicos por liga: só retorna após publicação/apuração.
-- O participante precisa estar na liga ou ser admin global.
-- --------------------------------------------------------------------------
create or replace function public.br_listar_palpites_publicos_liga(
  p_participante_id uuid,
  p_token text,
  p_liga_id uuid,
  p_rodada int,
  p_temporada int default 2026
)
returns table (
  membro text,
  event_id text,
  mandante text,
  visitante text,
  placar_mandante int,
  placar_visitante int,
  hash_fechamento text,
  criado_em timestamptz,
  atualizado_em timestamptz,
  participante_id uuid
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.br_validar_sessao(p_participante_id, p_token, false) then
    raise exception 'Sessão inválida.';
  end if;
  if p_liga_id is null or not public.br_pode_ver_liga(p_participante_id, p_liga_id) then
    raise exception 'Você não tem acesso a esta liga.';
  end if;

  if not exists (
    select 1 from public.br_config_rodadas c
    where c.temporada = p_temporada and c.rodada = p_rodada
      and (c.status in ('publicada','apurada') or (c.publica_em is not null and now() >= c.publica_em))
  ) then
    return;
  end if;

  return query
  select p.membro, p.event_id, p.mandante, p.visitante, p.placar_mandante, p.placar_visitante,
         p.hash_fechamento, p.criado_em, p.atualizado_em, p.participante_id
  from public.br_palpites p
  join public.br_liga_participantes lp
    on lp.participante_id = p.participante_id
   and lp.liga_id = p_liga_id
   and lp.ativo = true
  join public.br_participantes bp on bp.id = p.participante_id and bp.ativo = true
  where p.temporada = p_temporada and p.rodada = p_rodada
  order by p.membro, p.kickoff nulls last, p.mandante;
end;
$$;

grant execute on function public.br_listar_palpites_publicos_liga(uuid,text,uuid,int,int) to anon;

-- --------------------------------------------------------------------------
-- Admin: percentual preenchido por liga.
-- --------------------------------------------------------------------------
create or replace function public.br_admin_progresso_rodada_liga(
  p_admin_id uuid,
  p_token text,
  p_temporada int,
  p_rodada int,
  p_total_jogos int,
  p_liga_id uuid default null
)
returns table (
  participante_id uuid,
  nome text,
  login text,
  ativo boolean,
  admin boolean,
  total_palpites int,
  total_jogos int,
  percentual numeric
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
  with participantes_base as (
    select distinct bp.id, bp.nome, bp.login, bp.ativo, bp.admin
    from public.br_participantes bp
    left join public.br_liga_participantes lp on lp.participante_id = bp.id
    where bp.ativo = true
      and (p_liga_id is null or (lp.liga_id = p_liga_id and lp.ativo = true))
  )
  select pb.id,
         pb.nome,
         pb.login,
         pb.ativo,
         pb.admin,
         coalesce(count(pl.id)::int, 0) as total_palpites,
         greatest(coalesce(p_total_jogos, 0), 0) as total_jogos,
         case when coalesce(p_total_jogos, 0) <= 0 then 0
              else round((count(pl.id)::numeric / p_total_jogos::numeric) * 100, 1) end as percentual
  from participantes_base pb
  left join public.br_palpites pl
    on pl.participante_id = pb.id
   and pl.temporada = p_temporada
   and pl.rodada = p_rodada
  group by pb.id, pb.nome, pb.login, pb.ativo, pb.admin
  order by pb.nome;
end;
$$;

grant execute on function public.br_admin_progresso_rodada_liga(uuid,text,int,int,int,uuid) to anon;

-- --------------------------------------------------------------------------
-- Admin: relatório de auditoria por liga.
-- --------------------------------------------------------------------------
create or replace function public.br_admin_relatorio_auditoria_liga(
  p_admin_id uuid,
  p_token text,
  p_temporada int,
  p_rodada int,
  p_total_jogos int default 0,
  p_liga_id uuid default null
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
  with participantes_base as (
    select distinct bp.id, bp.nome, bp.login, bp.ativo, bp.admin
    from public.br_participantes bp
    left join public.br_liga_participantes lp on lp.participante_id = bp.id
    where bp.ativo = true
      and (p_liga_id is null or (lp.liga_id = p_liga_id and lp.ativo = true))
  ), pbase as (
    select
      pb.id,
      pb.nome,
      pb.login,
      pb.ativo,
      pb.admin,
      count(distinct pp.event_id)::int as total_palpites,
      min(pp.criado_em) as primeiro_envio,
      max(pp.atualizado_em) as ultimo_envio
    from participantes_base pb
    left join public.br_palpites pp
      on pp.participante_id = pb.id
     and pp.temporada = p_temporada
     and pp.rodada = p_rodada
    group by pb.id, pb.nome, pb.login, pb.ativo, pb.admin
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

grant execute on function public.br_admin_relatorio_auditoria_liga(uuid,text,int,int,int,uuid) to anon;

-- Eventos de auditoria por liga.
create or replace function public.br_admin_auditoria_eventos_liga(
  p_admin_id uuid,
  p_token text,
  p_temporada int,
  p_rodada int,
  p_liga_id uuid default null
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
  left join public.br_liga_participantes lp on lp.participante_id = a.participante_id
  where a.temporada = p_temporada and a.rodada = p_rodada
    and (p_liga_id is null or (lp.liga_id = p_liga_id and lp.ativo = true))
  order by a.criado_em desc
  limit 500;
end;
$$;

grant execute on function public.br_admin_auditoria_eventos_liga(uuid,text,int,int,uuid) to anon;

select 'EXECUCAO_13_RANKINGS_POR_LIGA_OK' as status;
