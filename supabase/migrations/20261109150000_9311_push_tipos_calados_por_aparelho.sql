-- manifest: push_subscriptions.tipos_calados — o aparelho escolhe quais tipos de aviso recebe no celular (antes, desligar "Nova mensagem" desligava tudo)
--
-- As escolhas da tela Configurações › Notificações ficavam só no navegador
-- (localStorage), e o servidor, que não as via, mandava todo tipo de aviso a
-- toda inscrição. A única forma de calar um tipo era desligar o Push de
-- "Nova mensagem", que encerrava a inscrição do aparelho inteiro.
--
-- Agora cada inscrição guarda os tipos que o aparelho CALOU. Vazio (o padrão)
-- é o comportamento de antes: tudo chega. O vocabulário vive no TypeScript
-- (`NOTIFY_UI_CATEGORIES`, em `lib/notifications/prefs.ts`) e a rota valida com
-- Zod; não há CHECK para que um tipo novo não exija migration.
--
-- Idempotente; a policy `push_subscriptions_own` já cobre a coluna nova.

alter table public.push_subscriptions
  add column if not exists tipos_calados text[] not null default '{}';

comment on column public.push_subscriptions.tipos_calados is
  'Tipos de aviso que este aparelho não quer receber no celular (NOTIFY_UI_CATEGORIES). Vazio = recebe todos.';
