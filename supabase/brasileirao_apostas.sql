-- ==========================================================================
-- Supabase — Bolão Brasileirão 2026: apostas por rodada
-- Execução 3
--
-- Como usar:
-- 1) Supabase Dashboard > SQL Editor > New query
-- 2) Cole este arquivo inteiro
-- 3) Run
-- ===========================================================================

create extension if not exists pgcrypto;

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

create index if not exists br_palpites_rodada_idx on public.br_palpites (temporada, rodada);
create index if not exists br_palpites_membro_idx on public.br_palpites (membro);
create index if not exists br_palpites_evento_idx on public.br_palpites (event_id);

create or replace function public.br_set_atualizado_em()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;

drop trigger if exists br_palpites_set_atualizado_em on public.br_palpites;
create trigger br_palpites_set_atualizado_em
before update on public.br_palpites
for each row execute function public.br_set_atualizado_em();

-- Configuração opcional por rodada. O front também tem fallback por padrão.
create table if not exists public.br_config_rodadas (
  temporada int not null default 2026,
  rodada int not null check (rodada between 1 and 38),
  abre_em timestamptz not null,
  fecha_em timestamptz not null,
  observacao text,
  atualizado_em timestamptz not null default now(),
  primary key (temporada, rodada)
);

insert into public.br_config_rodadas (temporada, rodada, abre_em, fecha_em, observacao)
values (2026, 20, '2026-07-23 00:00:00-03', '2026-07-25 10:00:00-03', 'Primeira rodada do bolão de placares após a Copa')
on conflict (temporada, rodada) do update
set abre_em = excluded.abre_em,
    fecha_em = excluded.fecha_em,
    observacao = excluded.observacao,
    atualizado_em = now();

alter table public.br_palpites enable row level security;
alter table public.br_config_rodadas enable row level security;

-- Leitura pública para o site montar ranking e conferência.
drop policy if exists "br_palpites_select_public" on public.br_palpites;
create policy "br_palpites_select_public"
on public.br_palpites
for select
to anon
using (true);

drop policy if exists "br_config_select_public" on public.br_config_rodadas;
create policy "br_config_select_public"
on public.br_config_rodadas
for select
to anon
using (true);

-- Escrita pública controlada pela janela salva em cada linha.
-- Observação: é um bolão privado entre amigos; não há autenticação individual.
-- A auditoria fica em criado_em/atualizado_em e a apuração descarta registros tardios.
drop policy if exists "br_palpites_insert_dentro_da_janela" on public.br_palpites;
create policy "br_palpites_insert_dentro_da_janela"
on public.br_palpites
for insert
to anon
with check (
  rodada >= 20
  and now() < coalesce((
    select c.fecha_em
    from public.br_config_rodadas c
    where c.temporada = br_palpites.temporada
      and c.rodada = br_palpites.rodada
  ), fecha_em)
);

drop policy if exists "br_palpites_update_dentro_da_janela" on public.br_palpites;
create policy "br_palpites_update_dentro_da_janela"
on public.br_palpites
for update
to anon
using (
  rodada >= 20
  and now() < coalesce((
    select c.fecha_em
    from public.br_config_rodadas c
    where c.temporada = br_palpites.temporada
      and c.rodada = br_palpites.rodada
  ), fecha_em)
)
with check (
  rodada >= 20
  and now() < coalesce((
    select c.fecha_em
    from public.br_config_rodadas c
    where c.temporada = br_palpites.temporada
      and c.rodada = br_palpites.rodada
  ), fecha_em)
);

-- Consulta rápida de validação pós-SQL:
-- select * from public.br_config_rodadas where temporada = 2026 and rodada = 20;
