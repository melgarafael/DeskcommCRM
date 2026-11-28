-- manifest: `llm_calls` passa a guardar `cache_write_1h_tokens` — quantos tokens da gravação de cache a Anthropic cobrou com prazo de 1 hora, separado do total em `cache_write_tokens`; coluna nula, sem backfill, e nula significa "não medido".
--
-- 9481 — A GRAVAÇÃO DE CACHE TEM DOIS PRAZOS E DOIS PREÇOS (#5020).
--
-- O seam já separa a gravação de cache da Anthropic em 1 hora e 5 minutos
-- (`gravacaoDeUmaHora`, lib/agent-engine/edge/llm/run-model-call.ts ~1787) e
-- cobra cada parte pela sua tarifa (Sonnet 5.5: 4,00 contra 2,50 por milhão).
-- O banco só guardava o TOTAL (`cache_write_tokens`): numa auditoria, as duas
-- parcelas não eram recontáveis, e a diferença aparecia como "custo errado"
-- sem prova de que estava certo. Medido numa instalação real: 904,86 centavos
-- gravados contra 729,22 recontados com a escrita toda a 5 minutos (26/10 a
-- 15/11, 332 chamadas) — a diferença era 1,17 milhão de tokens de 1 hora, que o
-- código cobrou certo e o banco não guardava.
--
-- Escritor único: `runModelCall`, que já tem a divisão em mãos para o custo e
-- grava a coluna NO MESMO insert do total. Os outros escritores de `llm_calls`
-- (mídia, logInvocation, voz, decisão, sementes) deixam a coluna NULA — a mesma
-- doutrina da 9105: "não mediu" é nulo, nunca 0. Linha antiga também fica nula:
-- não há como saber a divisão retroativamente, e backfill seria invenção.
--
-- Alcance da recontagem: com `cache_write_tokens` e `cache_write_1h_tokens`,
-- o custo volta pela fórmula de duas tarifas SÓ quando ele veio da tabela do
-- motor e foi calculado por inteiro no turno. Não cobrem todos os caminhos, e a
-- coluna não promete isso: o degrau do Haiku 5.5 (custo por passo), o preço
-- informado pela OpenRouter oficial, o catálogo da instalação (modelo fora da
-- tabela) e a linha com esta coluna NULA (custo pela tarifa inteira do
-- `cacheTtl`, que não fica gravado na linha) seguem com a própria regra.
--
-- Aditiva e idempotente: coluna nulável, sem default e sem constraint. O
-- `update.sh` do self-host reaplica o baseline em banco existente, e nenhuma
-- linha muda. `cache_write_1h_tokens` nunca passa de `cache_write_tokens` por
-- construção (a divisão é proporcional ao total); não vira CHECK para uma
-- chamada já paga não falhar na gravação.

alter table public.llm_calls
  add column if not exists cache_write_1h_tokens integer;

comment on column public.llm_calls.cache_write_1h_tokens is
  'Tokens da gravação de cache com prazo de 1 hora, lidos de cache_creation.ephemeral_1h_input_tokens (Anthropic). O restante da gravação é 5m: cache_write_tokens - cache_write_1h_tokens. Nulo = não medido (linha antiga, provedor sem a divisão ou escritor fora do seam), nunca "zero".';

notify pgrst, 'reload schema';
