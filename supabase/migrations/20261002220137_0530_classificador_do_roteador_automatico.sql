-- 0530 — o classificador do roteador nasce "Automático"
--
-- O `ai_routers.config` semeava `'classifier_model', 'claude-haiku-4-5'`, um id
-- fixo do ANTHROPIC dentro de um produto multi-provedor. Medido numa instalação
-- real com a organização na OpenRouter (2026-10-02, `llm_calls`):
--
--   provider openrouter · model claude-haiku-4-5 · http_status 400
--   error_message "claude-haiku-4-5 is not a valid model ID"
--   origem_da_escolha "variavel_de_ambiente"
--
-- O id fixo entra pela PRECEDÊNCIA 3 de `decidirBinding`
-- (`lib/ai/pontos/resolver.ts`): modelo do call site vence o padrão da
-- organização, e como `classifyIntent` só passa `model` quando o roteador tem
-- um, o roteador nascia com o id do Anthropic e ele ia para o endpoint da
-- OpenRouter — `origin` = provider da org, `modelId` = id do call site, sem
-- tradução no meio. (Quem tem binding do painel para `intent_router` nunca foi
-- afetado: a precedência 2 vence a 3.)
--
-- E o id nem existe na OpenRouter. Conferido no catálogo público
-- (`GET https://openrouter.ai/api/v1/models`, 464 ids, medido em 2026-10-02):
-- o modelo é `anthropic/claude-haiku-4.5` — PONTO entre 4 e 5, não traço. A
-- forma `claude-haiku-4-5` é a do ANTHROPIC nativo (0023/0104), o que faz o
-- default parecer válido em qualquer revisão de catálogo.
--
-- O conserto é o que `lib/agent-engine/agent/router-config.ts` já exige na
-- docstring de `classifierModel`: "NUNCA um id fixo aqui". O default passa a
-- não trazer `classifier_model`, e `loadActiveRouter` devolve `null` =
-- "Automático" — o seam resolve pelo painel de provedores, senão pelo padrão da
-- organização, como qualquer outro ponto. Mesmo defeito, na mesma forma, já
-- corrigido em `lib/agent-engine/flywheel/live.ts`.
--
-- `sticky` e `min_confidence` FICAM no default, com os mesmos valores da 0085
-- (e os mesmos que o leitor presume, `router-config.ts:110-114`). Só
-- `classifier_model` sai.

-- 1 · Default novo: sem id de modelo. Quem cria um roteador agora nasce em
-- "Automático" e o seam escolhe.
alter table public.ai_routers
  alter column config set default jsonb_build_object(
    'sticky', true,
    'min_confidence', 0.6);

-- 2 · Cura das linhas já semeadas, preservando todo o resto do config (`-`
-- remove só a chave; `jsonb_build_object` reescreveria a linha).
--
-- A cura alcança SÓ a linha que tem a forma exata do seed E que quebrava:
--
--   (a) `classifier_model = 'claude-haiku-4-5'` — o único id que a 0085 semeou.
--       `anthropic/claude-haiku-4-5` NÃO entra: nunca foi semeado em
--       `ai_routers`, e é um modelo válido do catálogo da Requesty (0410) que a
--       tela oferece e grava com `classifier_provider = 'requesty'`. Apagá-lo
--       seria desfazer uma escolha deliberada.
--   (b) `classifier_provider` ausente ou vazio — o seed nunca teve provedor, e a
--       tela grava os dois juntos desde que o seletor existe. Linha com provedor
--       é escolha de alguém e vai pelo `llmOverride`, que funciona.
--   (c) a organização NÃO está no Anthropic. O provedor efetivo é
--       `settings.llm.provider`, e a leitura dele em
--       `lib/agent-engine/edge/llm/credentials.ts` (`llmSettingsSchema`) cai para
--       'anthropic' quando o campo falta, não é texto ou é vazio — a guarda
--       abaixo reproduz exatamente essa regra. Nessas organizações o alias
--       `claude-haiku-4-5` resolve (0104) e o seed FUNCIONAVA: tirá-lo trocaria
--       o Haiku pelo modelo padrão da organização (mais caro e mais lento) sem
--       ninguém escolher. Elas ficam como estão.
--
-- Resíduo conhecido: a organização Anthropic que depois mudar de provedor leva
-- o seed junto. Isso já era assim antes desta migration; salvar o roteador em
-- "Automático" na tela limpa a chave.
update public.ai_routers r
set config = r.config - 'classifier_model'
from public.organizations o
where o.id = r.organization_id
  and r.config->>'classifier_model' = 'claude-haiku-4-5'
  and coalesce(r.config->>'classifier_provider', '') = ''
  and coalesce(
        case when jsonb_typeof(o.settings->'llm'->'provider') = 'string'
             then nullif(o.settings->'llm'->>'provider', '') end,
        'anthropic') <> 'anthropic';

-- Idempotente por construção: rodar duas vezes dá o mesmo estado (o default já
-- não tem a chave, e o `where` só acha linha que ainda tem o seed). Sem filtro
-- de organização de propósito: o default foi semeado em todas, e a correção é
-- do schema, não de um cliente.
