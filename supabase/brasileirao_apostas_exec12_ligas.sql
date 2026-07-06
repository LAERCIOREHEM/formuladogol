-- ============================================================================
-- Supabase — Bolão Brasileirão 2026: EXECUÇÃO 12
-- Ligas, remoção/inativação de participantes e gestão por grupos.
--
-- Rode no SQL Editor depois da Execução 10/11.
-- Este script é idempotente e NÃO apaga palpites, comprovantes ou auditorias.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- --------------------------------------------------------------------------
-- Tabelas de ligas
-- --------------------------------------------------------------------------
create table if not exists public.br_ligas (
  id uuid primary key default extensions.gen_random_uuid(),
  nome text not null,
  slug text not null unique,
  descricao text,
  ativa boolean not null default true,
  criada_por uuid references public.br_participantes(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists public.br_liga_participantes (
  id uuid primary key default extensions.gen_random_uuid(),
  liga_id uuid not null references public.br_ligas(id) on delete cascade,
  participante_id uuid not null references public.br_participantes(id) on delete cascade,
  papel text not null default 'participante',
  ativo boolean not null default true,
  entrou_em timestamptz not null default now(),
  saiu_em timestamptz,
  atualizado_em timestamptz not null default now(),
  unique (liga_id, participante_id)
);

alter table public.br_liga_participantes
  drop constraint if exists br_liga_participantes_papel_chk;
alter table public.br_liga_participantes
  add constraint br_liga_participantes_papel_chk check (papel in ('participante','admin_liga','observador'));

create index if not exists br_liga_participantes_liga_idx on public.br_liga_participantes(liga_id);
create index if not exists br_liga_participantes_participante_idx on public.br_liga_participantes(participante_id);

alter table public.br_ligas enable row level security;
alter table public.br_liga_participantes enable row level security;

-- Mantém updated_at das tabelas novas usando a trigger já existente da Execução 10.
drop trigger if exists br_ligas_set_atualizado_em on public.br_ligas;
create trigger br_ligas_set_atualizado_em
before update on public.br_ligas
for each row execute function public.br_set_atualizado_em();

drop trigger if exists br_liga_participantes_set_atualizado_em on public.br_liga_participantes;
create trigger br_liga_participantes_set_atualizado_em
before update on public.br_liga_participantes
for each row execute function public.br_set_atualizado_em();

-- Liga Geral padrão.
insert into public.br_ligas (nome, slug, descricao, ativa)
values ('Liga Geral', 'liga-geral', 'Liga padrão com todos os participantes ativos.', true)
on conflict (slug) do nothing;

-- Primeiro seed: participantes existentes entram na Liga Geral, sem sobrescrever remoções futuras em reexecuções.
insert into public.br_liga_participantes (liga_id, participante_id, papel, ativo)
select l.id, p.id, case when p.admin then 'admin_liga' else 'participante' end, true
from public.br_ligas l
join public.br_participantes p on p.ativo = true
where l.slug = 'liga-geral'
on conflict (liga_id, participante_id) do nothing;

-- --------------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------------
create or replace function public.br_slug_liga(p_nome text)
returns text
language sql
immutable
as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p_nome,'')), '[^a-z0-9]+', '-', 'g'));
$$;

-- --------------------------------------------------------------------------
-- Ligas do usuário logado
-- --------------------------------------------------------------------------
create or replace function public.br_listar_minhas_ligas(p_participante_id uuid, p_token text)
returns table (
  liga_id uuid,
  nome text,
  slug text,
  descricao text,
  ativa boolean,
  papel text
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
  select l.id, l.nome, l.slug, l.descricao, l.ativa, lp.papel
  from public.br_ligas l
  join public.br_liga_participantes lp on lp.liga_id = l.id
  where lp.participante_id = p_participante_id
    and lp.ativo = true
    and l.ativa = true
  order by case when l.slug = 'liga-geral' then 0 else 1 end, l.nome;
end;
$$;

grant execute on function public.br_listar_minhas_ligas(uuid,text) to anon;

-- --------------------------------------------------------------------------
-- Admin: listar/salvar ligas e membros
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
  atualizado_em timestamptz
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
  select
    l.id,
    l.nome,
    l.slug,
    l.descricao,
    l.ativa,
    count(lp.id)::int as total_participantes,
    count(lp.id) filter (where lp.ativo = true)::int as participantes_ativos,
    l.criado_em,
    l.atualizado_em
  from public.br_ligas l
  left join public.br_liga_participantes lp on lp.liga_id = l.id
  group by l.id, l.nome, l.slug, l.descricao, l.ativa, l.criado_em, l.atualizado_em
  order by case when l.slug = 'liga-geral' then 0 else 1 end, l.nome;
end;
$$;

grant execute on function public.br_admin_listar_ligas(uuid,text) to anon;

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
  if v_slug = '' then v_slug := 'liga-' || substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 8); end if;

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

  return query select l.id, l.nome, l.slug, l.descricao, l.ativa from public.br_ligas l where l.id = v_id;
end;
$$;

grant execute on function public.br_admin_salvar_liga(uuid,text,uuid,text,text,text,boolean) to anon;

create or replace function public.br_admin_listar_liga_participantes(
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
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then
    raise exception 'Acesso admin inválido.';
  end if;

  return query
  select l.id, l.nome, l.slug, p.id, p.nome, p.login, p.ativo, lp.ativo, lp.papel, lp.entrou_em, lp.saiu_em
  from public.br_liga_participantes lp
  join public.br_ligas l on l.id = lp.liga_id
  join public.br_participantes p on p.id = lp.participante_id
  where p_liga_id is null or lp.liga_id = p_liga_id
  order by l.nome, p.nome;
end;
$$;

grant execute on function public.br_admin_listar_liga_participantes(uuid,text,uuid) to anon;

create or replace function public.br_admin_vincular_participante_liga(
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
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then
    raise exception 'Acesso admin inválido.';
  end if;
  if p_liga_id is null or p_participante_id is null then
    raise exception 'Liga e participante são obrigatórios.';
  end if;
  if coalesce(p_papel,'participante') not in ('participante','admin_liga','observador') then
    raise exception 'Papel inválido.';
  end if;

  insert into public.br_liga_participantes (liga_id, participante_id, papel, ativo, entrou_em, saiu_em)
  values (p_liga_id, p_participante_id, coalesce(p_papel,'participante'), coalesce(p_ativo,true), now(), case when coalesce(p_ativo,true) then null else now() end)
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

-- Inativar/reativar participante sem apagar histórico.
create or replace function public.br_admin_alterar_status_participante(
  p_admin_id uuid,
  p_token text,
  p_participante_id uuid,
  p_ativo boolean
)
returns table (participante_id uuid, nome text, login text, ativo boolean, admin boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.br_validar_sessao(p_admin_id, p_token, true) then
    raise exception 'Acesso admin inválido.';
  end if;
  if p_participante_id is null then raise exception 'Participante obrigatório.'; end if;
  if p_participante_id = p_admin_id and coalesce(p_ativo,false) = false then
    raise exception 'Você não pode inativar o próprio usuário logado.';
  end if;

  update public.br_participantes p
  set ativo = coalesce(p_ativo,false)
  where p.id = p_participante_id;

  if coalesce(p_ativo,false) = false then
    update public.br_sessoes s set revogada = true where s.participante_id = p_participante_id;
  end if;

  return query select p.id, p.nome, p.login, p.ativo, p.admin
  from public.br_participantes p where p.id = p_participante_id;
end;
$$;

grant execute on function public.br_admin_alterar_status_participante(uuid,text,uuid,boolean) to anon;

-- Atualiza salvar participante para colocar novos usuários automaticamente na Liga Geral.
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
  v_liga_geral uuid;
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

  select l.id into v_liga_geral from public.br_ligas l where l.slug = 'liga-geral' limit 1;
  if v_liga_geral is not null then
    insert into public.br_liga_participantes (liga_id, participante_id, papel, ativo)
    values (v_liga_geral, v_id, case when coalesce(p_admin,false) then 'admin_liga' else 'participante' end, coalesce(p_ativo,true))
    on conflict (liga_id, participante_id) do nothing;
  end if;

  return query select bp.id, bp.nome, bp.login, bp.ativo, bp.admin from public.br_participantes bp where bp.id = v_id;
end;
$$;

grant execute on function public.br_admin_salvar_participante(uuid,text,uuid,text,text,text,boolean,boolean) to anon;

select 'EXECUCAO_12_LIGAS_OK' as status;
