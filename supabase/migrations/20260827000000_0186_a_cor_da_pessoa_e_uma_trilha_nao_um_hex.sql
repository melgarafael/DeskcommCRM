-- ============================================================================
-- 0186 — A COR DA PESSOA É UMA TRILHA, E A DO TIPO NÃO EXISTE
--
-- A 0177 criou duas colunas de cor guardando hex, com CHECK de formato:
-- `user_organizations.calendar_color` e `calendar_event_types.color`. As duas
-- estavam erradas, e o argumento que as derruba não é meu — é o do @VPS, escrito
-- no cabeçalho de `components/agenda/paleta.ts`: hex guardado é "um segundo
-- lugar para a mesma verdade, e o tema escuro fica de fora".
--
-- Medido: as cores vivem em `app/globals.css` como `--agenda-pessoa-1..8`, em
-- TRÊS blocos de tema, e a MESMA trilha tem hex diferente em cada um — a trilha 1
-- é `#ac4d40` num bloco e `#f89080` noutro. Um hex no banco não tem como ser as
-- duas coisas: ele nasce sem tema escuro, e a tela ou ignora o valor do cliente
-- ou perde o tema.
--
-- ─── Por que AGORA, e não depois ─────────────────────────────────────────
-- Zero consumidores das duas colunas, medido com controle positivo (a mesma
-- sonda acha `trilha` em 34 arquivos, então estava viva). Trocar hoje custa esta
-- migration; trocar depois que a rota de marcar gravar custa migração de dado de
-- cliente. A janela fecha quando o POST nascer.
--
-- ─── `calendar_color` VIRA TRILHA, e a escolha manual FICA ───────────────
-- A cor da pessoa é o eixo visual da grade e o item 10 do pedido do dono do
-- produto. `trilhaPadraoDoMembro()` deriva uma trilha estável do `user_id`, mas
-- a derivação COLIDE para alguns pares — oito trilhas e mais de oito pessoas —,
-- e quem administra vai querer desempatar. Por isso a coluna continua existindo:
-- ela guarda a ESCOLHA, e NULL significa "use a derivada".
--
-- ─── `calendar_event_types.color` SAI, e não é só por falta de consumidor ──
-- Há UM pixel por compromisso na grade. Duas colorações competindo pelo mesmo
-- lugar significam que uma delas mente: ou a faixa diz de quem é o compromisso,
-- ou diz que tipo ele é, e o olho não lê as duas. O pedido diz cor POR PESSOA.
--
-- Se um dia alguém quiser colorir por tipo, volta como TRILHA também, com um
-- alternador que torne as duas mutuamente exclusivas — que é o desenho honesto
-- para um recurso que disputa o mesmo pixel.
--
-- ⚠️ DROP COLUMN é destrutivo e eu não o escrevo de leve. O que autoriza aqui:
-- as colunas nasceram na 0177, hoje; o seed da 0185 não preenche nenhuma das
-- duas; e a varredura por consumidor devolveu zero em `lib`, `app`, `components`,
-- `hooks`, `workers` e `tests`, com controle positivo. Não há dado de cliente a
-- perder porque não há caminho que grave.
-- ============================================================================

-- ─── 1 · a cor da pessoa vira trilha ──────────────────────────────────────
alter table public.user_organizations
  add column if not exists calendar_trilha smallint;

alter table public.user_organizations
  drop constraint if exists user_organizations_calendar_trilha_valida;
alter table public.user_organizations
  add constraint user_organizations_calendar_trilha_valida
  check (calendar_trilha is null or calendar_trilha between 1 and 8);

comment on column public.user_organizations.calendar_trilha is
  'A trilha de cor desta pessoa na grade da Agenda, nesta organização (1..8). NULL = use a derivada de trilhaPadraoDoMembro(user_id), que é estável mas colide para alguns pares — esta coluna existe para quem administra desempatar. A COR de cada trilha vive em app/globals.css (--agenda-pessoa-N) e muda com o tema; guardar hex aqui seria um segundo lugar para a mesma verdade, sem tema escuro. ⚠️ A policy de SELECT desta tabela é self-OU-manager+: um `agent` não lê a linha dos colegas pelo PostgREST, então as trilhas chegam à tela pela rota que monta o roster com service role.';

alter table public.user_organizations
  drop constraint if exists user_organizations_calendar_color_format;
alter table public.user_organizations
  drop column if exists calendar_color;

-- ─── 2 · a cor do tipo de agendamento sai ─────────────────────────────────
alter table public.calendar_event_types
  drop constraint if exists calendar_event_types_color_format;
alter table public.calendar_event_types
  drop column if exists color;

notify pgrst, 'reload schema';
