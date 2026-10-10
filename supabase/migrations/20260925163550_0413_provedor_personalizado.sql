-- ============================================================================
-- 2026-09-25 — 0413: PROVEDOR PERSONALIZADO COMPATÍVEL COM OPENAI (#1642)
--
-- A tela de Credenciais ganha "Provedor personalizado (compatível com OpenAI)":
-- endpoint do próprio operador (OmniRouter, 9Router, proxy corporativo, modelo
-- local) que fala a API da OpenAI. A CHAVE já nasce cifrada pelo mesmo
-- caminho das outras (0023) — o que falta é o ENDEREÇO, que é escolha do
-- operador e por isso mora na LINHA da credencial, e não em `.env` nem no
-- binding do ponto: o mesmo endereço tem de valer para o cadastro, para a
-- validação e para o turno do agente, e três lugares para a mesma escolha é
-- como as duas telas passam a discordar.
--
-- Aditiva e idempotente (`add column if not exists`, constraint por
-- `drop if exists` + `add`, view `create or replace`, grants reemitidos).
-- NENHUM provedor nativo muda de comportamento: `base_url` nasce `null` em
-- toda linha existente, o runtime só o lê quando o provider é `custom`, e os
-- quatro continuam indo ao endpoint intrínseco.
--
-- Sem função nova em `public` ⇒ o item 9 da doutrina não é acionado.
-- ============================================================================

alter table public.ai_provider_credentials
  add column if not exists base_url text;

-- Forma do dado no banco, igual à da aplicação (zod da rota): http(s) sem
-- espaço. O CHECK é o que sobra para quem escrever direto no SQL ou pelo
-- PostgREST — e `null` continua sendo a resposta de todo provedor nativo.
alter table public.ai_provider_credentials
  drop constraint if exists ai_provider_credentials_base_url_check;
alter table public.ai_provider_credentials
  add constraint ai_provider_credentials_base_url_check
  check (base_url is null or base_url ~* '^https?://[^[:space:]]+$');

-- A view é a ÚNICA superfície de leitura da tela: expor `base_url` aqui é o
-- que faz a tela mostrar o endereço cadastrado sem abrir a tabela. Coluna nova
-- no FIM da lista — `create or replace view` não renomea nem reordena coluna
-- existente.
create or replace view public.ai_provider_credentials_safe
with (security_invoker = true) as
 select id,
    organization_id,
    provider,
    label,
    api_key_last4,
    validated_at,
    validation_error,
    models_available,
    is_active,
    created_by,
    created_at,
    updated_at,
    base_url
   from public.ai_provider_credentials;

-- O SELECT é POR COLUNA desde a 0150: as três colunas do segredo ficam fora
-- de propósito, e `revoke` de tabela inteira é quem as mantém fora. A lista tem
-- de acompanhar a tabela — sem `base_url` aqui, a view nova responderia
-- "permission denied for table ai_provider_credentials" para todo manager, e a
-- tela de Credenciais viraria `[]`. `base_url` não é segredo: é um endpoint.
revoke select on public.ai_provider_credentials from authenticated, anon;
grant select (
  id, organization_id, provider, label, api_key_last4, validated_at,
  validation_error, models_available, is_active, created_by, created_at, updated_at,
  base_url
) on public.ai_provider_credentials to authenticated;
grant select on public.ai_provider_credentials_safe to authenticated;

-- O PostgREST guarda o schema em cache; sem isto a coluna nova só aparece no
-- próximo reload.
notify pgrst, 'reload schema';
