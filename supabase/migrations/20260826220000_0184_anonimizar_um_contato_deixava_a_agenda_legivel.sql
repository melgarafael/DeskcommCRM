-- ============================================================================
-- 0184 — ANONIMIZAR UM CONTATO REPORTAVA SUCESSO E DEIXAVA A CONSULTA LEGÍVEL
--
-- `fn_lgpd_cascade_redact_contact` percorre uma lista de tabelas escrita à mão,
-- e `calendar_appointments` não estava nela. A tabela guarda, em texto livre:
-- `title` ("Consulta — Maria Silva"), `description`, `notes` (a anotação do
-- atendimento, que numa clínica é queixa clínica), `location_details` (o
-- endereço de uma visita) e `cancellation_reason`.
--
-- ⚠️ O que torna isto grave não é o esquecimento — é a FORMA do silêncio. A
-- função devolve contagem por tabela, a rota reporta sucesso, o SLA de D+15 é
-- marcado como cumprido. Nada erra, nada loga, e o titular recebe a confirmação
-- de que seus dados foram anonimizados enquanto a queixa dele continua legível
-- no banco, com hora e endereço.
--
-- E o `on delete restrict` de `contact_id` não protege NADA aqui: a LGPD deste
-- produto ANONIMIZA em vez de apagar (é a doutrina, e é a escolha certa), então
-- o contato vira "Cliente Anonimizado #N" e as linhas da agenda seguem intactas.
--
-- ─── Por que TRIGGER e não um passo dentro da função ─────────────────────
-- A função vem do `pg_dump` e tem ~180 linhas no corpo do baseline. Acrescentar
-- um passo exigiria carregar uma CÓPIA inteira dela no apêndice — duas cópias
-- que divergem no primeiro conserto de qualquer uma. O repo já recusou esse
-- caminho antes, e o gancho em uso é este: `after update of is_anonymized on
-- contacts`, que é o que a 0174 faz para o histórico de captação e roda na MESMA
-- transação do cascade.
--
-- E há uma razão que vale mais que a economia de linhas: o trigger escuta a
-- COLUNA, não o chamador. Existe mais de um caminho de anonimização neste repo,
-- e um passo dentro da função só cobriria quem a chama.
--
-- ─── O que se redige, e o que se PRESERVA ────────────────────────────────
-- Redige o texto livre. PRESERVA `starts_at`, `ends_at`, `status`,
-- `event_type_id` e `owner_user_id` — a doutrina de LGPD deste produto manda
-- preservar timestamps nas atividades, e a razão vale aqui: a clínica precisa
-- responder "quantos atendimentos houve em março" depois de anonimizar, e isso
-- é registro de operação, não dado pessoal. O QUE aconteceu e QUANDO fica; COM
-- QUEM e SOBRE O QUÊ sai.
--
-- ─── `calendar_external_events` fica de FORA, e não por esquecimento ─────
-- Ela não tem `contact_id`. O único vínculo com a pessoa é o `title` copiado do
-- Google, e não há predicado que a alcance a partir do contato anonimizado.
-- Alcançá-la exigiria decidir entre duas coisas que são de produto, não de
-- schema: declarar por escrito que é espelho de sistema de terceiro e o titular
-- exerce o direito lá (e então o EXPORT precisa dizer isso a ele), ou apagar a
-- janela inteira daquela conexão. Fica registrado como pendência com dono, não
-- como omissão silenciosa.
--
-- Aditiva: função nova e trigger novo. Nenhuma linha existente muda ao aplicar.
-- ============================================================================

create or replace function public.fn_redigir_agenda_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.calendar_appointments
     set title               = 'Compromisso anonimizado',
         description         = null,
         notes               = null,
         location_details    = null,
         meeting_url         = null,
         cancellation_reason = null
   where organization_id = new.organization_id
     and contact_id = new.id;
  return new;
end;
$$;

-- Função de trigger não exige EXECUTE de quem dispara o UPDATE, então revogar
-- das três origens não a quebra — e a mantém fora da lista de exceções do
-- invariante de hardening, que é congelada.
revoke execute on function public.fn_redigir_agenda_do_contato_anonimizado() from public, anon, authenticated;
grant  execute on function public.fn_redigir_agenda_do_contato_anonimizado() to service_role;

drop trigger if exists trg_redigir_agenda_ao_anonimizar on public.contacts;
create trigger trg_redigir_agenda_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_redigir_agenda_do_contato_anonimizado();

comment on column public.calendar_appointments.notes is
  'Anotação livre do atendimento — numa clínica, queixa clínica. É dado pessoal: o trigger trg_redigir_agenda_ao_anonimizar (migration 0184) a apaga quando o contato é anonimizado, junto com title, description, location_details, meeting_url e cancellation_reason. Horário, status e dono são PRESERVADOS: o que aconteceu e quando é registro de operação.';

notify pgrst, 'reload schema';
