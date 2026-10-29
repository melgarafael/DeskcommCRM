-- manifest: Respostas rápidas — coluna `mostrar_na_barra` (boolean not null default true) em `message_templates` (#3282): cada resposta rápida escolhe se aparece na barra do Inbox, sem sair do atalho `/`. O default TRUE não muda quem já usa (ausência = aparece); `add column if not exists`, idempotente; apêndice idempotente no `baseline.sql`.

-- ─── O que isto resolve ─────────────────────────────────────────────────────
-- A barra de recursos do Inbox (#2833) monta um botão por linha de
-- `message_templates` da organização. Numa agência com dezenas de respostas a
-- barra vira uma nuvem de várias linhas acima do compositor, e aparecem ali
-- textos que ninguém escolhe à mão (modelos de um follow-up, mensagens usadas
-- só pelo atalho `/`). Até aqui a única saída era apagar a resposta — e isso a
-- tirava também do `/`.
--
-- Esta coluna é a MARCAÇÃO por resposta rápida: `false` esconde o botão da
-- barra do Inbox; `true` (default) mantém o comportamento de hoje. A barra lê o
-- campo; o atalho `/` ignora-o de propósito e continua listando TODAS.
--
-- ─── A decisão de escopo desta fatia ────────────────────────────────────────
-- A coluna NÃO entra na ordenação por arrastar nem em grupos (#3244 e #3245
-- conversam com a issue e têm PR na região): a barra só ganha a marcação e o
-- recolhimento. O limite de botões definido pelo administrador (item 3 da
-- issue) fica FORA, é opcional.
--
-- ─── Compatibilidade ────────────────────────────────────────────────────────
-- `add column if not exists` + `default true`: linhas que já existem ficam
-- marcadas para aparecer — byte a byte o comportamento atual. Linha anterior a
-- esta migration (e fixture que não traz a chave) é "aparece", nunca "some".

alter table public.message_templates
  add column if not exists mostrar_na_barra boolean not null default true;

comment on column public.message_templates.mostrar_na_barra is
  'Se a resposta rápida aparece na barra do Inbox (#3282). Default true: a ausência da marcação e a marcação ligada mantêm o comportamento de sempre. O atalho / lista TODAS, independente deste campo.';
