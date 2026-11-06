-- manifest: llm_calls passa a dizer de que é feita cada chamada (passos, entrada real do 1º passo, caracteres de sistema/ferramentas/mensagens, partes de mídia, hash do prefixo estável); nulo = não medido. Sete colunas nuláveis, sem constraint, sem backfill, sem função nova.
--
-- 9105 — medição da composição do pedido (frente A da economia de tokens).
--
-- `llm_calls` só tinha totais. O "2 passos de ~28,7 mil tokens" do agente
-- medido na investigação de consumo teve de ser inferido; daqui em diante ele
-- é lido direto: `passos`, `entrada_do_primeiro_passo` (a abertura sozinha,
-- como o provedor informou) e o peso de sistema, ferramentas e mensagens em
-- caracteres. É a régua de "antes e depois" de toda economia que vier.
--
-- Escritor único: `runModelCall` (lib/agent-engine/edge/llm/run-model-call.ts),
-- que mede DEPOIS da resposta do provedor, fora de `latency_ms`, e grava nulo
-- quando a medição falha. Os outros escritores de `llm_calls` (mídia,
-- logInvocation, recusas) deixam as colunas nulas, que é honesto: não mediram.
--
-- Nenhuma coluna guarda conteúdo — só tamanhos e um hash do prefixo estável,
-- que por doutrina não carrega dado de lead (stable-prefix.ts). A RLS e os
-- grants são da tabela e cobrem as colunas novas.

alter table public.llm_calls add column if not exists passos smallint;
alter table public.llm_calls add column if not exists entrada_do_primeiro_passo integer;
alter table public.llm_calls add column if not exists chars_sistema integer;
alter table public.llm_calls add column if not exists chars_ferramentas integer;
alter table public.llm_calls add column if not exists chars_mensagens integer;
alter table public.llm_calls add column if not exists partes_de_midia smallint;
alter table public.llm_calls add column if not exists prefixo_hash text;

comment on column public.llm_calls.passos is
  'result.steps.length da chamada (laço de ferramentas). Nulo = escritor fora do seam (mídia, logInvocation, recusas) ou chamada que falhou.';
comment on column public.llm_calls.entrada_do_primeiro_passo is
  'Tokens de entrada do 1º passo, como o provedor informou. input_tokens é a SOMA dos passos; esta é a abertura sozinha.';
comment on column public.llm_calls.chars_sistema is
  'Caracteres do texto do sistema enviado. Só tamanho, nunca conteúdo.';
comment on column public.llm_calls.chars_ferramentas is
  'Caracteres de serializeStablePrefix que não são o texto do sistema: as ferramentas (descrição + schema) com os rótulos === tool:x === e o rótulo do sistema. 0 sem ferramentas.';
comment on column public.llm_calls.chars_mensagens is
  'Caracteres de texto, raciocínio e JSON de chamada e de resultado de ferramenta das mensagens enviadas. Mídia não conta.';
comment on column public.llm_calls.partes_de_midia is
  'Partes file/image das mensagens. Com valor maior que 0, a entrada do 1º passo inclui tokens de mídia que nenhum chars_* explica.';
comment on column public.llm_calls.prefixo_hash is
  'sha256 hex de serializeStablePrefix(system, tools), o mesmo de stablePrefixHash: prefixos distintos por agente e dia medem a quebra de cache.';

notify pgrst, 'reload schema';
