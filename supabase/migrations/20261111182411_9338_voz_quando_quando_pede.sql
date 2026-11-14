-- manifest: **`voz_quando` ganha o quarto comportamento: falar quando o CLIENTE PEDIR (#4345).** O CHECK fechado de `ai_agent_versions.voz_quando` passa a aceitar `quando_pede` ao lado de `nunca`/`espelhar`/`sempre` — mesma coluna, mesmo tipo, nenhum valor renomeado, e o default segue `espelhar`, então toda versão existente mantém o comportamento de hoje. Só o vocabulário do CHECK muda (`drop` + `add` idempotentes) e o comentário da coluna é reescrito para descrever os quatro comportamentos; quem decide é `lib/agent-engine/agent/voz-do-turno.ts`, com a leitura do turno em `lib/agent-engine/agent/pedido-de-audio.ts`. Sem coluna nova, sem backfill e sem função nova.
--
-- 9338 — O CLIENTE PODE PEDIR VOZ: `voz_quando = 'quando_pede'`.
--
-- ═══ Por quê ═══
--
-- A #4345 é sobre quem ESCREVE pedindo áudio (ou avisa que não consegue ler).
-- Até aqui o comportamento `'espelhar'` olhava só o CANAL — o cliente mandou
-- áudio? falo em áudio — e essa pessoa recebia texto que não consegue consumir.
-- O quarto valor soma UMA leitura do turno (o próprio texto do cliente) ao
-- espelho: fala quando ele mandou áudio OU quando pediu por escrito.
--
-- ═══ Por que migration, e não só o texto livre ═══
--
-- A 9052 fechou o vocabulário de propósito (`check (voz_quando in (...))`):
-- `voz_quando` é lido pelo motor e traduzido em decisão de gasto (síntese por
-- turno), então um valor torto não pode entrar por API nem por `update` à mão.
-- Um valor novo, portanto, exige o CHECK novo — não há como vivê-lo só no
-- código. Nenhum valor é renomeado: `nunca`/`espelhar`/`sempre` continuam com
-- o mesmo significado e o default segue `'espelhar'`, então quem já configurou
-- a voz não percebe diferença.
--
-- ═══ O que NÃO entra aqui ═══
--
--  · Nenhuma coluna nova e nenhum backfill: o comportamento é por versão, e
--    versão que não foi reedita continua exatamente como está.
--  · Nenhuma função nova — a imutabilidade de versão publicada
--    (`fn_ai_agent_version_content_immutable`, 9052) já cobre `voz_quando`
--    desde que nasceu, e a lista de colunas dela não muda.
--  · Nenhuma mudança de grants/RLS: a coluna é a mesma, escrita pelo mesmo
--    caminho (a ação do editor de agente, via service role).
--
-- Idempotente; espelho no apêndice do `supabase/baseline.sql`, antes da
-- VARREDURA anon (0116). Não cria função (poderia ficar depois dela), e fica
-- antes por vizinhança com o bloco da 9052, que é quem criou a coluna.

-- Drop e add num bloco só: o update.sh aplica sem ON_ERROR_STOP, e um add que
-- falhasse depois de um drop solto deixaria a coluna sem guarda.
do $voz_quando$
begin
  alter table public.ai_agent_versions
    drop constraint if exists ai_agent_versions_voz_quando_check;
  alter table public.ai_agent_versions
    add constraint ai_agent_versions_voz_quando_check
    check (voz_quando in ('nunca', 'espelhar', 'sempre', 'quando_pede'));
end
$voz_quando$;

comment on column public.ai_agent_versions.voz_quando is
  'Migration 9338 (a coluna nasceu na 9052). ''nunca'' (nunca fala, mesmo com '
  'voz_enabled=true — existe para desligar sem apagar a config), ''espelhar'' '
  '(fala só quando o CLIENTE mandou áudio nesta mensagem — o default), '
  '''sempre'', ou ''quando_pede'' (fala quando o cliente mandou áudio OU pediu '
  'áudio por escrito / avisou que não consegue ler; quem pede texto continua '
  'recebendo texto). Decidido em lib/agent-engine/agent/voz-do-turno.ts, com a '
  'leitura do turno em lib/agent-engine/agent/pedido-de-audio.ts.';
