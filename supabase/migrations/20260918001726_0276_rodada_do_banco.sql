-- 0276 — a rodada de atualização conta o que aconteceu com o banco.
--
-- O achado do PR #997: o baseline reaplicado sobrevive a uma disputa com o
-- sistema no ar; o kit tenta de novo e fecha. Até aqui esse pedaço da história
-- morria no log do servidor. Quem clicou em atualizar via "terminou" e não
-- ficava sabendo que o banco estava ocupado, que a primeira passada não
-- fechou, nem em qual passada a coisa terminou — justo o caso em que a pessoa
-- mais olha para a tela.
--
-- Estas três colunas são onde a rodada guarda isso:
--   disputa_de_banco      — houve disputa de lock com o sistema no ar?
--   retentativas_do_banco — quantas retentativas ela gastou (0 = de primeira)?
--   passada_do_banco      — em qual passada ela fechou (1 = primeira)?
--
-- As três são NULAS quando o caminho não passou pelo banco (atualização só de
-- código, `--to` sem reaplicar baseline, ou kit antigo que ainda não reporta).
-- Nulo é "não medido", e a tela não inventa texto para isso.
--
-- Sem backfill de propósito: preencher as rodadas antigas com zeros seria
-- afirmar que nelas não houve disputa — afirmação que ninguém mediu.

alter table public.system_update_runs
  add column if not exists disputa_de_banco boolean,
  add column if not exists retentativas_do_banco integer,
  add column if not exists passada_do_banco integer;

comment on column public.system_update_runs.disputa_de_banco is
  'Se a rodada do banco enfrentou disputa de lock com o sistema no ar. Nulo = o caminho não passou pelo banco.';
comment on column public.system_update_runs.retentativas_do_banco is
  'Quantas retentativas a rodada do banco gastou antes de fechar (0 = fechou na primeira passada). Nulo = o caminho não passou pelo banco.';
comment on column public.system_update_runs.passada_do_banco is
  'Em qual passada a rodada do banco fechou (1 = primeira). Nulo = o caminho não passou pelo banco.';

-- A régua do que é um número coerente: uma passada por tentativa, nunca menos.
-- A constraint é derrubada antes de ser criada porque `db push` aplica as
-- migrations em ordem, mas um banco de desenvolvimento onde a versão anterior
-- desta migration já rodou se corrige ao reaplicar o arquivo.
alter table public.system_update_runs
  drop constraint if exists system_update_runs_rodada_do_banco_coerente;
alter table public.system_update_runs
  add constraint system_update_runs_rodada_do_banco_coerente check (
    (
      disputa_de_banco is null
      and retentativas_do_banco is null
      and passada_do_banco is null
    )
    or (
      disputa_de_banco is not null
      and retentativas_do_banco is not null
      and retentativas_do_banco >= 0
      and passada_do_banco is not null
      and passada_do_banco >= 1
      and passada_do_banco >= retentativas_do_banco + 1
    )
  );
