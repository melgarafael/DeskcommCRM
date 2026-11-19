-- manifest: **Compromisso cancelado não impede mais excluir o contato (achado A9 de `curso/ACHADOS.md`).** A pré-checagem da exclusão (`contarVinculosRestrict`, `app/api/v1/contacts/_handler.ts`) contava TODA linha de `calendar_appointments` do contato, sem olhar o status, e a FK `calendar_appointments.contact_id` (RESTRICT, 0177) recusava a ficha do mesmo jeito. Como o DELETE da Agenda é cancelamento e a tela não tem "apagar compromisso", quem já teve um compromisso cancelado nunca saía da base, e o aviso mandava "cancelar ou apagar" — cancelar não resolvia e apagar não existe. `fn_apagar_contato_com_historico` (0488) passa a DESVINCULAR, na mesma transação e antes de apagar o histórico, os compromissos CANCELADOS do contato (`contact_id` e `conversation_id` a NULL): a linha continua na agenda de quem atendeu, com a mesma ligação ao Google, e só perde o vínculo com uma ficha que está saindo. Compromisso vivo, realizado ou com falta continua barrando, como a 0177 decidiu. Reserva de serviço (`service_occurrence_id`) também continua barrando: o gatilho `fn_calendar_service_appointment_guard` recusa trocar o contato dela com sessão de usuário. Mesma assinatura, mesmo `security invoker`, mesmas permissões. Gate: `tests/unit/contato-delete.test.ts`.
-- 9405 — COMPROMISSO CANCELADO NÃO IMPEDE EXCLUIR O CONTATO (achado A9).
--
-- ═══ O defeito ═══
--
-- Excluir um contato que teve um compromisso CANCELADO devolvia 409 com o aviso
-- "Este contato tem 1 compromisso na Agenda. Cancele ou apague o compromisso
-- antes de excluir.". Duas travas, uma de cada lado:
--
--   1. a pré-checagem da rota (`contarVinculosRestrict`) contava toda linha de
--      `calendar_appointments` do contato, sem filtro de status;
--   2. a FK `calendar_appointments.contact_id` é `on delete restrict` (0177) e
--      não sabe de status nenhum: mesmo sem a pré-checagem, o banco recusaria.
--
-- O DELETE da Agenda é cancelamento (`cancelarAgendamentoHandler`), e a tela não
-- oferece apagar compromisso. Cancelar era o único gesto possível, e ele não
-- liberava a exclusão.
--
-- ═══ Por que DESVINCULAR, e não apagar a linha cancelada ═══
--
--   * A 0177 decidiu que o compromisso não cai em cascata com a ficha: ele está
--     na agenda de quem atendeu. Desvincular mantém a linha.
--   * O compromisso cancelado é quem leva a remoção do evento ao Google
--     (`lib/agenda/google/candidates.ts`). Apagar a linha antes de o envio sair
--     deixaria o evento vivo lá fora, e a leitura do Google recusa evento do
--     produto sem vínculo local (`calendar-executor.ts`: "Evento do produto sem
--     vínculo"). Trocar só `contact_id`/`conversation_id` não mexe em nenhuma
--     coluna que `fn_google_projection_stamp` olha: o espelho segue como estava.
--
-- ═══ O que o UPDATE precisa levar junto ═══
--
--   * `conversation_id = null`: `fn_appointment_stamp` recusa conversa que não é
--     do mesmo contato (`appointment_conversation_scope`). As conversas do
--     contato saem logo abaixo, então o vínculo com elas cairia de qualquer jeito
--     (a FK é `on delete set null`).
--   * `service_occurrence_id is null`: reserva de serviço não troca de contato
--     por sessão de usuário (`fn_calendar_service_appointment_guard`,
--     `service_writer_required`). Ela continua contando na pré-checagem, e o
--     aviso da tela continua honesto.
--
-- `security invoker`, como na 0488: a RLS de quem chama vale para o UPDATE
-- (`calendar_appointments_write`). Linha que a sessão não pode escrever não muda,
-- e a FK recusa a ficha com 23503 — o mesmo desfecho de antes, sem nada apagado,
-- porque a função é uma transação só.
--
-- O UPDATE vem ANTES dos DELETE de propósito: `found`, no fim, tem de ser o do
-- DELETE da ficha (é ele que a rota lê para o 404).
create or replace function public.fn_apagar_contato_com_historico(
  p_contact_id uuid,
  p_organization_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path to 'public', 'pg_temp'
as $$
begin
  -- 9405: compromisso CANCELADO não segura a ficha. Ele fica na agenda, sem
  -- o contato. Reserva de serviço fica de fora (ver cabeçalho da 9405).
  update public.calendar_appointments
     set contact_id = null,
         conversation_id = null
   where contact_id = p_contact_id
     and organization_id = p_organization_id
     and status = 'cancelled'
     and service_occurrence_id is null;

  -- RESTRICT da #752: o histórico sai antes da ficha, na mesma transação.
  delete from public.messages
   where contact_id = p_contact_id
     and organization_id = p_organization_id;

  delete from public.conversations
   where contact_id = p_contact_id
     and organization_id = p_organization_id;

  delete from public.contacts
   where id = p_contact_id
     and organization_id = p_organization_id;

  -- `found` é do DELETE da ficha: false = a ficha não estava acessível para quem
  -- chamou (outra organização, RLS, corrida) — a rota devolve 404 nesse caso.
  return found;
end;
$$;

-- Mesmas permissões da 0488, repetidas: `create or replace` preserva a ACL, mas
-- o bloco fica correto sozinho em quem aplica fora de ordem.
revoke execute on function public.fn_apagar_contato_com_historico(uuid, uuid) from public, anon;
grant  execute on function public.fn_apagar_contato_com_historico(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
