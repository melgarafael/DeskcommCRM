-- 0098 — contacts.locale: a coluna que o código já lia e o banco nunca teve.
--
-- O `ai-response-worker` seleciona `contacts:contact_id(id, display_name, locale,
-- is_blocked, force_human)` (workers/ai-response-worker.ts) e o render do prompt
-- consome `{{contact_locale}}` (lib/ai/render-system-prompt.ts). A coluna nunca
-- existiu no baseline, então em TODA instalação self-host o PostgREST devolvia
--
--     column contacts_1.locale does not exist
--
-- e o worker registrava `skip / conversation_not_found` para cada conversa. Como
-- o skip é logado em nível info e o dono do dispatch por padrão é o
-- agent-engine (AI_DISPATCH_OWNER=engine), o sintoma ficava escondido no log em
-- vez de estourar — schema drift silencioso.
--
-- NULLABLE de propósito (doutrina DIRC): o idioma do contato não é duplicado do
-- da organização. NULL = "não definido, herda o padrão", que é exatamente o que
-- o código faz com `?? "pt-BR"`. Copiar o default para cada linha criaria
-- duplicação sem fonte da verdade e um backfill a manter.
--
-- Sem CHECK: código de locale é vocabulário ABERTO (pt-BR, es-PY, en-US, …). Uma
-- constraint aqui quebraria o `update.sh` de clones com valores legados, o que a
-- doutrina de migrations proíbe.

alter table public.contacts
  add column if not exists locale text;

comment on column public.contacts.locale is
  'Idioma preferido do contato (ex.: pt-BR, es-PY). NULL = herda o padrão da organização; o código resolve com fallback pt-BR.';

-- O PostgREST cacheia o schema: sem recarregar, a coluna existe no Postgres mas
-- a API segue respondendo "does not exist" até o próximo restart.
notify pgrst, 'reload schema';
