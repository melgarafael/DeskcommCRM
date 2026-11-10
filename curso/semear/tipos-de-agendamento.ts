/**
 * Semente do módulo "Tipos de agendamento" (/app/settings/tenant/agenda): os
 * tipos que as lições mostram, editam, desativam e transformam em serviço.
 *
 * Idempotente e só sobre as próprias linhas: apaga e recria os tipos de ids
 * fixos desta semente, o tipo que a lição de criar cria (por slug) e o dia
 * fechado que a lição de regras grava (Helena, data fixa). Os três tipos que a
 * organização ganha ao nascer (Consulta, Reunião, Atendimento) e os do módulo
 * Agenda ficam como estão.
 *
 * Ordem da limpeza: a programação de serviço (horários, profissionais) aponta
 * para o tipo, e o gatilho `trg_calendar_service_type_guard` recusa tipo de
 * serviço ativo sem horário — então apaga-se o tipo inteiro (as tabelas filhas
 * caem em cascata), nunca se "desliga" campo a campo.
 */
import { type Contexto, semErro } from "../semear-demonstracao";

const tipoId = (n: number) => `be7a1100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ENDERECO = "Rua das Acácias, 120 — 3º andar";

/** Slug do tipo que a lição "criar um tipo" cria pela tela. */
const SLUG_CRIADO_NA_LICAO = "retorno-de-fisioterapia";
/** Dia que a lição de regras fecha pela tela (agenda da Helena). */
export const DIA_FECHADO_NA_LICAO = "2027-09-07";

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;

  const TIPOS = [
    {
      n: 1, name: "Limpeza dental", slug: "limpeza-dental", category: "procedimento", duration_minutes: 40,
      default_owner_user_id: pessoa.carlos, location_kind: "in_person", location_details: `${ENDERECO}, consultório 4`,
      default_price_cents: 18000, reminder_enabled: true, reminder_minutes_before: 1440, reminder_extra_offsets_minutes: [120],
      reminder_body: "Oi {{nome}}! Amanhã às {{hora}} é a sua limpeza dental na Clínica Bem Viver. Qualquer imprevisto, é só responder aqui.",
      is_active: true,
    },
    {
      n: 2, name: "Avaliação odontológica", slug: "avaliacao-odontologica", category: "consulta", duration_minutes: 30,
      default_owner_user_id: null, location_kind: "in_person", location_details: `${ENDERECO}, consultório 4`,
      default_price_cents: null, reminder_enabled: false, reminder_minutes_before: 1440, reminder_extra_offsets_minutes: [],
      reminder_body: null, is_active: true,
    },
    {
      n: 3, name: "Pilates em grupo", slug: "pilates-em-grupo", category: "procedimento", duration_minutes: 50,
      default_owner_user_id: pessoa.ana, location_kind: "in_person", location_details: `${ENDERECO}, sala de pilates`,
      default_price_cents: 9000, reminder_enabled: false, reminder_minutes_before: 1440, reminder_extra_offsets_minutes: [],
      reminder_body: null, is_active: true,
    },
    {
      n: 4, name: "Orientação nutricional por vídeo", slug: "orientacao-nutricional-por-video", category: "consulta", duration_minutes: 30,
      default_owner_user_id: pessoa.helena, location_kind: "video_link", location_details: null,
      default_price_cents: 15000, reminder_enabled: false, reminder_minutes_before: 1440, reminder_extra_offsets_minutes: [],
      reminder_body: null, is_active: true,
    },
    {
      n: 5, name: "Drenagem linfática", slug: "drenagem-linfatica", category: "procedimento", duration_minutes: 60,
      default_owner_user_id: pessoa.ana, location_kind: "in_person", location_details: `${ENDERECO}, sala 2`,
      default_price_cents: 16000, reminder_enabled: false, reminder_minutes_before: 1440, reminder_extra_offsets_minutes: [],
      reminder_body: null, is_active: false,
    },
  ];
  await limparTiposDasLicoes(c);

  // ---------- recria ----------
  semErro(await db.from("calendar_event_types").insert(TIPOS.map(({ n, ...t }) => ({
    id: tipoId(n), organization_id: org, ...t, requires_confirmation: false, position: 200 + n,
  }))), "tipos de agendamento");
}

/**
 * Tira o que este módulo e as lições dele deixaram. A Agenda chama também: sem isso, uma aula da
 * Agenda refotografada depois deste módulo mostra os tipos dele na lista de "Horários livres de".
 */
export async function limparTiposDasLicoes(c: Contexto) {
  const { db, org, pessoa } = c;
  const ids = [1, 2, 3, 4, 5].map(tipoId);

  // ---------- limpa: o que as lições criaram/mudaram e os próprios tipos ----------
  semErro(await db.from("calendar_event_types").delete().eq("organization_id", org).eq("slug", SLUG_CRIADO_NA_LICAO), "limpar tipo criado na lição");
  semErro(await db.from("calendar_service_occurrences").delete().eq("organization_id", org).in("event_type_id", ids), "limpar ocorrências");
  semErro(await db.from("calendar_service_blocks").delete().eq("organization_id", org).in("event_type_id", ids), "limpar bloqueios de serviço");
  semErro(await db.from("calendar_event_types").delete().eq("organization_id", org).in("id", ids), "limpar tipos");
  semErro(await db.from("calendar_availability_exceptions").delete().eq("organization_id", org)
    .eq("user_id", pessoa.helena).eq("exception_date", DIA_FECHADO_NA_LICAO), "limpar dia fechado");
}
