-- ============================================================================
-- Supabase — Bolão Brasileirão 2026: EXECUÇÃO 14
-- Permissões finais por liga, admin global/admin de liga e relatórios filtrados.
--
-- Rode no SQL Editor depois das Execuções 12 e 13.
-- Idempotente. Não apaga participantes, ligas, palpites, hashes nem auditorias.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- --------------------------------------------------------------------------
-- Helpers de permissão
-- --------------------------------------------------------------------------
create or replace function public.br_e_admin_global(p_participante_id uuid, p_token text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select public.br_validar_sessao(p_participante_id, p_token, true);
$$;

grant execute on function public.br_e_admin_global(uuid,text) to anon;

create or replace function public.br_e_admin_liga(p_participante_id uuid, p_token text, p_liga_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select public.br_validar_sessao(p_participante_id, p_token, false)
  and exists (
    select 1
    from public.br_liga_participantes lp
    join public.br_ligas l on l.id = lp.liga_id
    join public.br_participantes p on p.id = lp.participante_id
    where lp.participante_id = p_participante_id
      and lp.liga_id = p_liga_id
      and lp.ativo = true
      and lp.papel = 'admin_liga'
      and l.ativa = true
      and p.ativo = true
  );
$$;

grant execute on function public.br_e_admin_liga(uuid,text,uuid) to anon;

create or replace function public.br_pode_admin_liga(p_participante_id uuid, p_token text, p_liga_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select public.br_e_admin_global(p_participante_id, p_token)
      or public.br_e_admin_liga(p_participante_id, p_token, p_liga_id);
$$;

grant execute on function public.br_pode_admin_liga(uuid,text,uuid) to anon;

-- --------------------------------------------------------------------------
-- Minhas ligas: participante vê só as ligas em que está ativo.
-- --------------------------------------------------------------------------
drop function if exists public.br_listar_minhas_ligas(uuid,text);
create function public.br_listar_minhas_ligas(p_participante_id uuid, p_token text)
returns table (
  liga_id uuid,
  nome text,
  slug text,
  descricao text,
  ativa boolean,
  papel text,
  pode_gerir boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_liga_geral uuid;
begin
  if not public.br_validar_sessao(p_participante_id, p_token, false) then
    raise exception 'Sessão inválida.';
  end if;

  select l.id into v_liga_geral from public.br_ligas l where l.slug = 'liga-geral' limit 1;
  if v_liga_geral is not null and not exists (
    select 1 from public.br_liga_participantes lp
    where lp.liga_id = v_liga_geral and lp.participante_id = p_participante_id
  ) then
    insert into public.br_liga_participantes (liga_id, participante_id, papel, ativo)
    values (v_liga_geral, p_participante_id, 'participante', true)
    on conflict (liga_id, participante_id) do nothing;
  end if;

  return query
  select l.id, l.nome, l.slug, l.descricao, l.ativa, lp.papel,
         (p.admin = true or lp.papel = 'admin_liga') as pode_gerir
  from public.br_ligas l
  join public.br_liga_participantes lp on lp.liga_id = l.id
  join public.br_participantes p on p.id = lp.participante_id
  where lp.participante_id = p_participante_id
    and lp.ativo = true
    and l.ativa = true
    and p.ativo = true
  order by case when l.slug = 'liga-geral' then 0 else 1 end, l.nome;
end;
$$;

grant execute on function public.br_listar_minhas_ligas(uuid,text) to anon;

-- --------------------------------------------------------------------------
-- Admin: listar ligas permitidas.
-- Admin global vê todas; admin de liga vê somente as ligas que gerencia.
-- --------------------------------------------------------------------------
drop function if exists public.br_admin_listar_ligas(uuid,text);
create function public.br_admin_listar_ligas(p_admin_id uuid, p_token text)
returns table (
  liga_id uuid,
  nome text,
  slug text,
  descricao text,
  ativa boolean,
  total_participantes int,
  participantes_ativos int,
  criado_em timestamptz,
  atualizado_em timestamptz,
  papel text,
  pode_gerir boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_global boolean;
begin
  if not public.br_validar_sessao(p_admin_id, p_token, false) then
    raise exception 'Sessão inválida.';
  end if;
  v_global := public.br_e_admin_global(p_admin_id, p_token);
  if not v_global and not exists (
    select 1 from public.br_liga_participantes lp
    join public.br_ligas l on l.id = lp.liga_id
    where lp.participante_id = p_admin_id and lp.ativo = true and lp.papel = 'admin_liga' and l.ativa = true
  ) then
    raise exception 'Acesso admin inválido.';
  end if;

  return query
  select
    l.id,
    l.nome,
    l.slug,
    l.descricao,
    l.ativa,
    count(lp_all.id)::int as total_participantes,
    count(lp_all.id) filter (where lp_all.ativo = true)::int as participantes_ativos,
    l.criado_em,
    l.atualizado_em,
    coalesce(lp_admin.papel, case when v_global then 'admin_global' else null end) as papel,
    (v_global or lp_admin.papel = 'admin_liga') as pode_gerir
  from public.br_ligas l
  left join public.br_liga_participantes lp_all on lp_all.liga_id = l.id
  left join public.br_liga_participantes lp_admin
    on lp_admin.liga_id = l.id
   and lp_admin.participante_id = p_admin_id
   and lp_admin.ativo = true
   and lp_admin.papel = 'admin_liga'
  where v_global or lp_admin.id is not null
  group by l.id, l.nome, l.slug, l.descricao, l.ativa, l.criado_em, l.atualizado_em, lp_admin.papel
  order by case when l.slug = 'liga-geral' then 0 else 1 end, l.nome;
end;
$$;

grant execute on function public.br_admin_listar_ligas(uuid,text) to anon;

-- Admin global vê todos os participantes; admin de liga vê participantes para poder vincular/remover em suas ligas.
drop function if exists public.br_admin_listar_participantes(uuid,text);
create function public.br_admin_listar_participantes(p_admin_id uuid, p_token text)
returns table (participante_id uuid, nome text, login text, ativo boolean, admin boolean, criado_em timestamptz, ultimo_login_em timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.br_validar_sessao(p_admin_id, p_token, false) then
    raise exception 'Sessão inválida.';
  end if;
  if not public.br_e_admin_global(p_admin_id, p_token) and not exists (
    select 1 from public.br_liga_participantes lp
    join public.br_ligas l on l.id = lp.liga_id
    where lp.participante_id = p_admin_id and lp.ativo = true and lp.papel = 'admin_liga' and l.ativa = true
  ) then
    raise exception 'Acesso admin inválido.';
  end if;

  return query select p.id, p.nome, p.login, p.ativo, p.admin, p.criado_em, p.ultimo_login_em
  from public.br_participantes p
  order by p.nome;
end;
$$;

grant execute on function public.br_admin_listar_participantes(uuid,text) to anon;

-- Membros de liga permitida.
drop function if exists public.br_admin_listar_liga_participantes(uuid,text,uuid);
create function public.br_admin_listar_liga_participantes(
  p_admin_id uuid,
  p_token text,
  p_liga_id uuid default null
)
returns table (
  liga_id uuid,
  nome_liga text,
  slug text,
  participante_id uuid,
  nome text,
  login text,
  participante_ativo boolean,
  membro_ativo boolean,
  papel text,
  entrou_em timestamptz,
  saiu_em timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_global boolean;
begin
  if not public.br_validar_sessao(p_admin_id, p_token, false) then
    raise exception 'Sessão inválida.';
  end if;
  v_global := public.br_e_admin_global(p_admin_id, p_token);

  return query
  select l.id, l.nome, l.slug, p.id, p.nome, p.login, p.ativo, lp.ativo, lp.papel, lp.entrou_em, lp.saiu_em
  from public.br_liga_participantes lp
  join public.br_ligas l on l.id = lp.liga_id
  join public.br_participantes p on p.id = lp.participante_id
  left join public.br_liga_participantes adm
    on adm.liga_id = l.id and adm.participante_id = p_admin_id and adm.ativo = true and adm.papel = 'admin_liga'
  where (p_liga_id is null or lp.liga_id = p_liga_id)
    and (v_global or adm.id is not null)
  order by l.nome, p.nome;
end;
$$;

grant execute on function public.br_admin_listar_liga_participantes(uuid,text,uuid) to anon;

-- Vincular/remover participante. Admin de liga pode mexer só nas ligas que gerencia.
drop function if exists public.br_admin_vincular_participante_liga(uuid,text,uuid,uuid,text,boolean);
create function public.br_admin_vincular_participante_liga(
  p_admin_id uuid,
  p_token text,
  p_liga_id uuid,
  p_participante_id uuid,
  p_papel text default 'participante',
  p_ativo boolean default true
)
returns table (liga_id uuid, participante_id uuid, papel text, ativo boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_global boolean;
  v_papel text;
begin
  if p_liga_id is null or p_participante_id is null then
    raise exception 'Liga e participante são obrigatórios.';
  end if;
  if not public.br_pode_admin_liga(p_admin_id, p_token, p_liga_id) then
    raise exception 'Você não tem permissão para administrar esta liga.';
  end if;
  v_global := public.br_e_admin_global(p_admin_id, p_token);
  v_papel := coalesce(p_papel, 'participante');
  if v_papel not in ('participante','admin_liga','observador') then
    raise exception 'Papel inválido.';
  end if;
  if not v_global and v_papel = 'admin_liga' then
    raise exception 'Somente o admin global pode nomear outro admin de liga.';
  end if;

  insert into public.br_liga_participantes (liga_id, participante_id, papel, ativo, entrou_em, saiu_em)
  values (p_liga_id, p_participante_id, v_papel, coalesce(p_ativo,true), now(), case when coalesce(p_ativo,true) then null else now() end)
  on conflict (liga_id, participante_id)
  do update set papel = excluded.papel,
                ativo = excluded.ativo,
                saiu_em = case when excluded.ativo then null else now() end,
                atualizado_em = now();

  return query
  select lp.liga_id, lp.participante_id, lp.papel, lp.ativo
  from public.br_liga_participantes lp
  where lp.liga_id = p_liga_id and lp.participante_id = p_participante_id;
end;
$$;

grant execute on function public.br_admin_vincular_participante_liga(uuid,text,uuid,uuid,text,boolean) to anon;

-- Progresso por liga: global = todas/selecionada; admin de liga = apenas suas ligas.
drop function if exists public.br_admin_progresso_rodada_liga(uuid,text,int,int,int,uuid);
create function public.br_admin_progresso_rodada_liga(
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
declare
  v_global boolean;
begin
  if not public.br_validar_sessao(p_admin_id, p_token, false) then
    raise exception 'Sessão inválida.';
  end if;
  v_global := public.br_e_admin_global(p_admin_id, p_token);

  return query
  with ligas_permitidas as (
    select l.id
    from public.br_ligas l
    left join public.br_liga_participantes adm
      on adm.liga_id = l.id and adm.participante_id = p_admin_id and adm.ativo = true and adm.papel = 'admin_liga'
    where (v_global or adm.id is not null)
      and (p_liga_id is null or l.id = p_liga_id)
  ), participantes_base as (
    select distinct bp.id, bp.nome, bp.login, bp.ativo, bp.admin
    from public.br_participantes bp
    join public.br_liga_participantes lp on lp.participante_id = bp.id and lp.ativo = true
    join ligas_permitidas al on al.id = lp.liga_id
    where bp.ativo = true
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

-- Relatório de auditoria por liga permitido.
drop function if exists public.br_admin_relatorio_auditoria_liga(uuid,text,int,int,int,uuid);
create function public.br_admin_relatorio_auditoria_liga(
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
declare
  v_global boolean;
begin
  if not public.br_validar_sessao(p_admin_id, p_token, false) then
    raise exception 'Sessão inválida.';
  end if;
  v_global := public.br_e_admin_global(p_admin_id, p_token);

  return query
  with ligas_permitidas as (
    select l.id
    from public.br_ligas l
    left join public.br_liga_participantes adm
      on adm.liga_id = l.id and adm.participante_id = p_admin_id and adm.ativo = true and adm.papel = 'admin_liga'
    where (v_global or adm.id is not null)
      and (p_liga_id is null or l.id = p_liga_id)
  ), participantes_base as (
    select distinct bp.id, bp.nome, bp.login, bp.ativo, bp.admin
    from public.br_participantes bp
    join public.br_liga_participantes lp on lp.participante_id = bp.id and lp.ativo = true
    join ligas_permitidas al on al.id = lp.liga_id
    where bp.ativo = true
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

-- Eventos de auditoria por liga permitido.
drop function if exists public.br_admin_auditoria_eventos_liga(uuid,text,int,int,uuid);
create function public.br_admin_auditoria_eventos_liga(
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
declare
  v_global boolean;
begin
  if not public.br_validar_sessao(p_admin_id, p_token, false) then
    raise exception 'Sessão inválida.';
  end if;
  v_global := public.br_e_admin_global(p_admin_id, p_token);

  return query
  with ligas_permitidas as (
    select l.id
    from public.br_ligas l
    left join public.br_liga_participantes adm
      on adm.liga_id = l.id and adm.participante_id = p_admin_id and adm.ativo = true and adm.papel = 'admin_liga'
    where (v_global or adm.id is not null)
      and (p_liga_id is null or l.id = p_liga_id)
  )
  select a.criado_em, a.membro, a.event_id, a.acao, a.hash_fechamento
  from public.br_palpites_auditoria a
  join public.br_liga_participantes lp on lp.participante_id = a.participante_id and lp.ativo = true
  join ligas_permitidas al on al.id = lp.liga_id
  where a.temporada = p_temporada and a.rodada = p_rodada
  order by a.criado_em desc
  limit 500;
end;
$$;

grant execute on function public.br_admin_auditoria_eventos_liga(uuid,text,int,int,uuid) to anon;

select 'EXECUCAO_14_PERMISSOES_LIGAS_OK' as status;
