-- ============================================================================
-- 0142 — AS DUAS CAMADAS DE SEGURANÇA QUE CUSTAM DINHEIRO PASSAM A SER ESCOLHA
-- DA ORGANIZAÇÃO.
--
-- A cadeia que confere a mensagem antes de sair tem dez verificações. Oito são
-- determinísticas, custam zero e não são escolha de ninguém — desligar o que
-- respeita quem pediu para parar, ou o que impede o número do cliente de ser
-- bloqueado, não é preferência.
--
-- Duas consultam um modelo e, por isso, custam por mensagem:
--
--   • `promessa_semantica` — segunda leitura do texto que vai sair, para pegar a
--     promessa escrita de um jeito que a regra fixa não reconhece (+1 consulta
--     por mensagem ENVIADA);
--   • `jailbreak`          — lê a mensagem que chega e reconhece quem tenta
--     fazer o assistente ignorar as instruções (+1 por mensagem RECEBIDA).
--
-- Até aqui as duas eram decididas por variável de ambiente do WORKER
-- (`PROMISE_SEMANTIC_ENABLED` e a presença de `JAILBREAK_CLASSIFIER_MODEL`), ou
-- seja: por PROCESSO, igual para todas as organizações, e alcançável só por quem
-- edita o `.env` da VPS e reinicia o contêiner. Num produto que a pessoa instala
-- sozinha, isso é o mesmo que não existir — e a tela de configuração do agente
-- não tinha como oferecer a escolha sem mentir.
--
-- ═══ POR QUE UMA TABELA, E NÃO `ai_purpose_bindings.is_enabled` ═══
--
-- Lá, `is_enabled = false` significa "ignore esta escolha de modelo e use o
-- padrão" — não "não rode isto". Reaproveitar mudaria o significado da coluna
-- para os 23 pontos que já a usam, para servir 2.
--
-- ═══ VOCABULÁRIO ABERTO: `layer` NÃO tem CHECK, e é deliberado ═══
--
-- Segue a exceção que o CLAUDE.md descreve: um clone pode ter linha com valor
-- que este build não conhece (camada removida, camada de uma versão futura), e
-- um CHECK faria o `update.sh` dele quebrar. O vocabulário vive no TypeScript,
-- com constante compartilhada, e a coluna fica FORA de
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts` — que cobre apenas
-- colunas que JÁ têm CHECK.
--
-- ═══ AUSÊNCIA DE LINHA NÃO É "DESLIGADO" ═══
--
-- Sem linha, vale o ambiente. É o que mantém intacta toda instalação que já
-- decidiu isso no `.env`: ligar a tela não pode mudar, sozinha, o comportamento
-- de quem não pediu nada. O `enabled` só existe quando alguém escolheu, e é por
-- isso que a leitura devolve três estados (ligado, desligado, não escolhido) em
-- vez de um booleano.
-- ============================================================================

create table if not exists public.org_guardrail_layers (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  layer text not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, layer)
);

alter table public.org_guardrail_layers enable row level security;

drop policy if exists tenant_isolation_org_guardrail_layers_all on public.org_guardrail_layers;
create policy tenant_isolation_org_guardrail_layers_all on public.org_guardrail_layers
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));
