-- ============================================================================
-- Supabase — Bolão Brasileirão 2026: HOTFIX/EXECUÇÃO 15
-- Liga padrão "Almoço de Sexta" + criação/gestão de outras ligas.
--
-- Rode no SQL Editor depois das Execuções 12, 13 e 14.
-- Idempotente: NÃO apaga participantes, palpites, hashes, auditoria ou ligas.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- --------------------------------------------------------------------------
-- 1) Garante a liga padrão do grupo: Almoço de Sexta.
-- --------------------------------------------------------------------------
insert into public.br_ligas (nome, slug, descricao, ativa)
values ('Almoço de Sexta', 'almoco-de-sexta', 'Liga principal/padrão do grupo Almoço de Sexta.', true)
on conflict (slug) do update
set nome = excluded.nome,
    descricao = excluded.descricao,
    ativa = true;

-- Mantém a Liga Geral como visão consolidada de todos.
insert into public.br_ligas (nome, slug, descricao, ativa)
values ('Liga Geral', 'liga-geral', 'Visão consolidada com todos os participantes ativos.', true)
on conflict (slug) do update
set nome = excluded.nome,
    descricao = excluded.descricao,
    ativa = true;

-- Participantes ativos entram nas duas ligas-base.
insert into public.br_liga_participantes (liga_id, participante_id, papel, ativo)
select l.id, p.id, case when p.admin then 'admin_liga' else 'participante' end, true
from public.br_ligas l
join public.br_participantes p on p.ativo = true
where l.slug in ('almoco-de-sexta', 'liga-geral')
on conflict (liga_id, participante_id) do update
set ativo = true,
    saiu_em = null,
    papel = case when excluded.papel = 'admin_liga' then 'admin_liga' else public.br_liga_participantes.papel end;

-- --------------------------------------------------------------------------
-- 2) Minhas ligas: admin global vê todas; participante vê somente suas ligas.
--    A ordem passa a ser: Almoço de Sexta, outras ligas, Liga Geral.
-- --------------------------------------------------------------------------
create or replace function public.br_listar_minhas_ligas(p_participante_id uuid, p_token text)
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
  v_liga_almoco uuid;
  v_global boolean;
begin
  if not public.br_validar_sessao(p_participante_id, p_token, false) then
    raise exception 'Sessão inválida.';
  end if;

  v_global := public.br_e_admin_global(p_participante_id, p_token);

  select l.id into v_liga_geral from public.br_ligas l where l.slug = 'liga-geral' limit 1;
  select l.id into v_liga_almoco from public.br_ligas l where l.slug = 'almoco-de-sexta' limit 1;

  -- Garante participação nas ligas-base sem sobrescrever outras ligas.
  if v_liga_geral is not null and not exists (
    select 1 from public.br_liga_participantes lp
    where lp.liga_id = v_liga_geral and lp.participante_id = p_participante_id
  ) then
    insert into public.br_liga_participantes (liga_id, participante_id, papel, ativo)
    values (v_liga_geral, p_participante_id, case when v_global then 'admin_liga' else 'participante' end, true)
    on conflict (liga_id, participante_id) do nothing;
  end if;

  if v_liga_almoco is not null and not exists (
    select 1 from public.br_liga_participantes lp
    where lp.liga_id = v_liga_almoco and lp.participante_id = p_participante_id
  ) then
    insert into public.br_liga_participantes (liga_id, participante_id, papel, ativo)
    values (v_liga_almoco, p_participante_id, case when v_global then 'admin_liga' else 'participante' end, true)
    on conflict (liga_id, participante_id) do nothing;
  end if;

  return query
  select
    l.id,
    l.nome,
    l.slug,
    l.descricao,
    l.ativa,
    coalesce(lp.papel, case when v_global then 'admin_liga' else 'participante' end) as papel,
    (v_global or lp.papel = 'admin_liga') as pode_gerir
  from public.br_ligas l
  join public.br_participantes p on p.id = p_participante_id
  left join public.br_liga_participantes lp
    on lp.liga_id = l.id
   and lp.participante_id = p_participante_id
   and lp.ativo = true
  where l.ativa = true
    and p.ativo = true
    and (v_global or lp.id is not null)
  order by
    case
      when l.slug = 'almoco-de-sexta' then 0
      when l.slug = 'liga-geral' then 99
      else 1
    end,
    l.nome;
end;
$$;

grant execute on function public.br_listar_minhas_ligas(uuid,text) to anon;

-- --------------------------------------------------------------------------
-- 3) Admin: listar ligas permitidas, com Almoço de Sexta no topo.
-- --------------------------------------------------------------------------
create or replace function public.br_admin_listar_ligas(p_admin_id uuid, p_token text)
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
    select 1
    from public.br_liga_participantes lp
    join public.br_ligas l on l.id = lp.liga_id
    where lp.participante_id = p_admin_id
      and lp.ativo = true
      and lp.papel = 'admin_liga'
      and l.ativa = true
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
  order by
    case
      when l.slug = 'almoco-de-sexta' then 0
      when l.slug = 'liga-geral' then 99
      else 1
    end,
    l.nome;
end;
$$;

grant execute on function public.br_admin_listar_ligas(uuid,text) to anon;

-- --------------------------------------------------------------------------
-- 4) Salvar liga: ao criar uma nova liga, o admin criador entra como admin_liga.
-- --------------------------------------------------------------------------
create or replace function public.br_admin_salvar_liga(
  p_admin_id uuid,
  p_token text,
  p_liga_id uuid,
  p_nome text,
  p_slug text,
  p_descricao text,
  p_ativa boolean
)
returns table (liga_id uuid, nome text, slug text, descricao text, ativa boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_slug text;
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then
    raise exception 'Acesso admin inválido.';
  end if;

  if coalesce(trim(p_nome),'') = '' then
    raise exception 'Nome da liga é obrigatório.';
  end if;

  v_slug := public.br_slug_liga(coalesce(nullif(trim(p_slug), ''), trim(p_nome)));
  if v_slug = '' then
    v_slug := 'liga-' || substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 8);
  end if;

  if p_liga_id is null then
    insert into public.br_ligas (nome, slug, descricao, ativa, criada_por)
    values (trim(p_nome), v_slug, nullif(trim(coalesce(p_descricao,'')), ''), coalesce(p_ativa,true), p_admin_id)
    returning id into v_id;
  else
    v_id := p_liga_id;
    update public.br_ligas l
    set nome = trim(p_nome),
        slug = v_slug,
        descricao = nullif(trim(coalesce(p_descricao,'')), ''),
        ativa = coalesce(p_ativa,true)
    where l.id = v_id;
  end if;

  insert into public.br_liga_participantes (liga_id, participante_id, papel, ativo, saiu_em)
  values (v_id, p_admin_id, 'admin_liga', true, null)
  on conflict (liga_id, participante_id) do update
  set papel = 'admin_liga',
      ativo = true,
      saiu_em = null;

  return query select l.id, l.nome, l.slug, l.descricao, l.ativa from public.br_ligas l where l.id = v_id;
end;
$$;

grant execute on function public.br_admin_salvar_liga(uuid,text,uuid,text,text,text,boolean) to anon;

-- --------------------------------------------------------------------------
-- 5) Salvar participante: novos usuários entram automaticamente na Liga Geral
--    e também na liga padrão Almoço de Sexta.
-- --------------------------------------------------------------------------
create or replace function public.br_admin_salvar_participante(
  p_admin_id uuid,
  p_token text,
  p_participante_id uuid,
  p_nome text,
  p_login text,
  p_pin text,
  p_admin boolean,
  p_ativo boolean
)
returns table (participante_id uuid, nome text, login text, ativo boolean, admin boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_liga record;
  v_papel text;
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then
    raise exception 'Acesso admin inválido.';
  end if;

  if coalesce(trim(p_nome),'') = '' or coalesce(trim(p_login),'') = '' then
    raise exception 'Nome e login são obrigatórios.';
  end if;

  if p_participante_id is null then
    if length(coalesce(p_pin,'')) < 4 then
      raise exception 'PIN obrigatório para novo participante.';
    end if;

    insert into public.br_participantes (nome, login, pin_hash, admin, ativo)
    values (trim(p_nome), lower(trim(p_login)), extensions.crypt(p_pin, extensions.gen_salt('bf')), coalesce(p_admin,false), coalesce(p_ativo,true))
    returning id into v_id;
  else
    v_id := p_participante_id;

    update public.br_participantes bp
    set nome = trim(p_nome),
        login = lower(trim(p_login)),
        admin = coalesce(p_admin,false),
        ativo = coalesce(p_ativo,true)
    where bp.id = v_id;

    if p_pin is not null and length(p_pin) >= 4 then
      update public.br_participantes bp
      set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf'))
      where bp.id = v_id;

      update public.br_sessoes s
      set revogada = true
      where s.participante_id = v_id;
    end if;
  end if;

  v_papel := case when coalesce(p_admin,false) then 'admin_liga' else 'participante' end;

  for v_liga in
    select l.id from public.br_ligas l where l.slug in ('almoco-de-sexta', 'liga-geral')
  loop
    insert into public.br_liga_participantes (liga_id, participante_id, papel, ativo, saiu_em)
    values (v_liga.id, v_id, v_papel, coalesce(p_ativo,true), null)
    on conflict (liga_id, participante_id) do update
    set ativo = excluded.ativo,
        saiu_em = case when excluded.ativo then null else public.br_liga_participantes.saiu_em end,
        papel = case when v_papel = 'admin_liga' then 'admin_liga' else public.br_liga_participantes.papel end;
  end loop;

  return query select bp.id, bp.nome, bp.login, bp.ativo, bp.admin from public.br_participantes bp where bp.id = v_id;
end;
$$;

grant execute on function public.br_admin_salvar_participante(uuid,text,uuid,text,text,text,boolean,boolean) to anon;

select 'HOTFIX_15_LIGAS_ADMIN_OK' as status;
