-- ============================================================================
-- 0141 — ROTACIONAR A CHAVE NÃO PODE APAGAR A CONFIGURAÇÃO DOS PONTOS.
--
-- `ai_purpose_bindings.credential_id` nasceu com `on delete cascade`. Apagar
-- uma credencial não desvinculava: **removia a linha inteira do binding**,
-- levando junto `provider`, `model_id`, `base_url` e `is_enabled`.
--
-- O caminho é banal e recomendado: o operador rotaciona a chave da Anthropic —
-- apaga a antiga, cadastra a nova. Todos os pontos que apontavam para ela
-- voltam calados ao padrão da organização. A tela passa a dizer "Usando o
-- padrão da organização", que é uma frase verdadeira sobre um estado que
-- ninguém escolheu, e nada indica que uma configuração foi apagada.
--
-- `set null` é o desfecho certo porque `credential_id is null` JÁ tem
-- significado no produto — "use a chave da instalação" —, e é o valor com que
-- todo binding nasce. O ponto continua no provedor e no modelo escolhidos, e
-- volta a usar a chave do `.env` até alguém apontar a nova. Nada some.
--
-- `restrict` foi considerado e recusado: transformaria "apagar chave" numa
-- operação que falha com erro de FK — e o operador não tem, na tela de
-- Credenciais, como descobrir quais pontos a usam para desfazer antes.
--
-- Idempotente: derruba a constraint pelo nome (qualquer que seja o desfecho
-- dela hoje) e recria com o comportamento novo.
-- ============================================================================

alter table public.ai_purpose_bindings
  drop constraint if exists ai_purpose_bindings_credential_id_fkey;

alter table public.ai_purpose_bindings
  add constraint ai_purpose_bindings_credential_id_fkey
  foreign key (credential_id) references public.ai_provider_credentials(id)
  on delete set null;

comment on column public.ai_purpose_bindings.credential_id is
  'Chave usada por este ponto. NULL = a chave da instalação (o .env) — que é como todo binding '
  'nasce. ON DELETE SET NULL (migration 0141): apagar a credencial desvincula, nunca apaga a '
  'escolha de provider/modelo. Com o CASCADE anterior, rotacionar uma chave zerava em silêncio a '
  'configuração de todos os pontos que a usavam.';
