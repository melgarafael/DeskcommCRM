-- 0270 · Lista de teste de quem pode publicar no Instagram — igual ao
-- pré-go-live do WhatsApp, mas para a capacidade de publicação.
--
-- O número do WhatsApp do agente é COMPARTILHADO — qualquer pessoa que
-- mandar mensagem para ele é um lead, e sem esta trava qualquer uma
-- conseguiria conectar e publicar no PRÓPRIO Instagram dela através do
-- agente. Isso é o comportamento pretendido quando a feature estiver
-- validada, mas enquanto está em teste (system prompt e fluxo ainda não
-- provados numa conversa real), o operador pediu para restringir a quem
-- ele mesmo escolher — mesmo raciocínio do `ai_test_phone_numbers` de
-- `channel_sessions` (migration relacionada: pré-go-live da IA).
--
-- `null` (o valor de toda organização hoje, inclusive a que já usa a
-- feature antes desta coluna existir) significa SEM restrição — nulo é
-- sempre a leitura mais frouxa, e não queremos que uma organização que já
-- estava publicando livremente amanheça bloqueada por uma migration. A
-- restrição é OPT-IN, populada explicitamente por quem pediu.

alter table public.instagram_apps
  add column if not exists allowed_phone_numbers text[];

comment on column public.instagram_apps.allowed_phone_numbers is
  'Lista de teste de quem pode usar crm_instagram_* (conectar/preparar/confirmar). NULL = sem restrição (padrão). Comparação por lib/channels/phone-variants.ts (cobre o nono dígito do Brasil).';
