-- 0212 · O convite do Google não tinha para quem ir.
--
-- ─── O que o usuário via ────────────────────────────────────────────────────
-- O compromisso marcado aqui chegava ao Google Agenda do ATENDENTE e parava
-- ali. Não havia onde pôr o e-mail do cliente, então o convite do Google —
-- aquele que cai na caixa de entrada com "Sim / Talvez / Não" — nunca era
-- enviado a ninguém. O tradutor de `attendees` existia inteiro em
-- `lib/agenda/google/evento.ts` desde que a integração nasceu, testado e sem
-- UM chamador que preenchesse a lista.
--
-- ─── Por que uma COLUNA, e não o e-mail do contato ──────────────────────────
-- `contacts.email` já existe e `calendar_appointments.contact_id` aponta para
-- lá, então puxar o endereço do cadastro sairia de graça. Não é o que se pediu,
-- e a diferença importa: o contato do CRM é quem RECEBE o atendimento, e o
-- convidado da reunião pode ser outra pessoa — o financeiro do cliente, um
-- sócio, alguém copiado só desta vez. Campo por COMPROMISSO deixa quem marca
-- decidir na hora, sem editar o cadastro do contato por causa de uma reunião.
--
-- ─── Sem CHECK de formato, de propósito ─────────────────────────────────────
-- Mesma decisão que `time_zone` tomou nesta tabela: a validação de forma é do
-- Zod, na rota (`z.string().email()`), que é onde a recusa vira mensagem para
-- quem digitou. Um CHECK aqui devolveria erro de constraint do Postgres —
-- texto que não serve para ninguém e que a rota teria de traduzir de novo.
--
-- ─── Aditiva: nasce nula, e nulo É o comportamento de hoje ──────────────────
-- Compromisso sem convidado não ganha `attendees` no corpo do evento, que é
-- exatamente o que acontece hoje em 100% das linhas. Nada a curar, nada a
-- migrar, e a coluna gerada `needs_google_push` (0200) continua valendo: quem
-- editar o convidado bumpa `updated_at` pelo trigger que já existe e volta a
-- ser candidato do worker de push na batida seguinte.

alter table public.calendar_appointments
  add column if not exists guest_email text;

comment on column public.calendar_appointments.guest_email is
  'E-mail de um convidado externo, digitado por quem marca. Quando presente vira `attendees` no evento do Google e o convite sai por e-mail (`sendUpdates=all` na chamada). Nulo = evento sem convidado, que é o comportamento anterior.';
