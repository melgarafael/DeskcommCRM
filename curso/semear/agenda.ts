/**
 * Semente do módulo Agenda: três tipos de atendimento da clínica, a jornada da
 * Ana (fisioterapia) e do Carlos (odontologia), e três semanas de compromissos
 * em volta de "agora" — a passada, a corrente e a que vem —, com realizados,
 * uma falta, um cancelado e um aguardando confirmação.
 *
 * ⚠️ Os compromissos NÃO têm contato vinculado, e é de propósito:
 * `calendar_appointments.contact_id` é `on delete restrict`, e a base apaga
 * todos os contatos da organização antes de cada lição. Um compromisso com
 * cliente travaria a semente da base de TODOS os módulos. O nome do paciente
 * vai no título. (E o gatilho `trg_agendamento_marca_cliente` ainda mudaria as
 * etiquetas dos contatos que a Inbox fotografa.)
 *
 * Idempotente: começa pelo `limpar` (compromissos e tipos pelos ids fixos desta
 * semente), recria os dois e grava a jornada por upsert.
 *
 * `limpar` (chamado pela base antes de QUALQUER aula) tira do banco os
 * compromissos e os tipos desta semente. Sem ele, as três semanas de
 * compromissos ficavam na bancada depois da aula de Agenda e apareciam em outras
 * telas: os realizados e confirmados dos últimos 30 dias entravam em
 * "Atendimentos sem comanda" (Comandas), cada um com "sem preço no serviço",
 * porque estes tipos não têm preço — e quantos entravam dependia do dia da
 * captura. A jornada (`attendant_availability`) fica: a linha é da pessoa, e a
 * semente de Equipe grava nas mesmas.
 */
import { type Contexto, semErro } from "../semear-demonstracao";

const tipoId = (n: number) => `be310000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const compromissoId = (n: number) => `be300000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ENDERECO = "Rua das Acácias, 120 — 3º andar";

/** Instante de um dia da semana CORRENTE (0 = domingo) às h:m de São Paulo (UTC-3, sem horário de verão). */
function naSemana(dia: number, h: number, m: number) {
  const sp = new Date(Date.now() - 3 * 3_600_000);
  return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() - sp.getUTCDay() + dia, h + 3, m));
}

type Quem = "ana" | "carlos" | "helena";
type Desejo = "realizado" | "faltou" | "pendente" | "cancelado" | "normal";
// [dia, hora, minuto, duração, quem, tipo (1..3 ou null), título, desejo]
// `dia` conta a partir do domingo da semana CORRENTE: 1..6 é esta semana, 8..13
// a que vem e -6..-1 a passada. As lições que precisam de "passados" voltam uma
// semana e as que precisam de "próximos" avançam uma — assim a captura dá o
// mesmo resultado em qualquer dia, inclusive no sábado à noite e no domingo.
//
// A ORDEM é o id (compromissoId(i + 1)) e as lições apontam para ids: linha
// nova entra no FIM, nunca no meio.
//
// A segunda-feira desta semana tem TRÊS compromissos (o 3º é o id 3) para o
// "+1" da visão de Mês. A visão de Mês abre no mês de hoje e começa na semana
// do dia 1, então a semana passada some dela na primeira semana do mês (e a que
// vem some quando hoje cai na última linha). A semana corrente é a única que
// está na grade do mês em qualquer dia.
const SEMANA: Array<[number, number, number, number, Quem, number | null, string, Desejo]> = [
  // semana passada: tudo já aconteceu
  [-6, 8, 0, 50, "ana", 1, "Sessão de fisioterapia — Lucas Martins", "realizado"],
  [-6, 9, 0, 60, "carlos", 3, "Consulta odontológica — Pedro Henrique Lima", "realizado"],
  // (esta semana) o 3º compromisso da segunda-feira — ver o "+1" acima
  [1, 14, 0, 50, "ana", 1, "Sessão de fisioterapia — Tereza Gomes", "normal"],
  [-5, 8, 30, 30, "ana", 2, "Avaliação postural — Camila Rocha", "faltou"],
  [-5, 10, 0, 60, "carlos", 3, "Consulta odontológica — Beatriz Nogueira", "normal"],
  [-4, 9, 0, 50, "ana", 1, "Sessão de fisioterapia — Lucas Martins", "realizado"],
  [-3, 10, 0, 50, "ana", 1, "Sessão de fisioterapia — Antônio Ferreira", "cancelado"],
  [-2, 16, 0, 60, "carlos", 3, "Consulta odontológica — Osvaldo Pires", "normal"],
  // esta semana
  [3, 17, 0, 60, "helena", null, "Reunião de equipe — planejamento do mês", "normal"],
  [1, 8, 0, 50, "ana", 1, "Sessão de fisioterapia — Lucas Martins", "realizado"],
  [1, 9, 0, 60, "carlos", 3, "Consulta odontológica — Pedro Henrique Lima", "realizado"],
  [2, 8, 30, 30, "ana", 2, "Avaliação postural — Camila Rocha", "normal"],
  [2, 15, 0, 50, "ana", 1, "Sessão de fisioterapia — Roberto Almeida", "normal"],
  [3, 11, 0, 60, "carlos", 3, "Consulta odontológica — Juliana Castro", "normal"],
  [4, 8, 0, 50, "ana", 1, "Sessão de fisioterapia — Tereza Gomes", "normal"],
  [4, 14, 0, 60, "carlos", 3, "Consulta odontológica — Fernanda Oliveira", "normal"],
  [5, 9, 0, 50, "ana", 1, "Sessão de fisioterapia — Lucas Martins", "normal"],
  [5, 10, 0, 30, "ana", 2, "Avaliação postural — Mariana Souza", "normal"],
  [6, 8, 0, 50, "ana", 1, "Sessão de fisioterapia — Roberto Almeida", "normal"],
  [6, 10, 0, 50, "ana", 1, "Sessão de fisioterapia — Camila Rocha", "normal"],
  // semana que vem: tudo por acontecer
  [8, 8, 0, 50, "ana", 1, "Sessão de fisioterapia — Roberto Almeida", "normal"],
  [8, 10, 0, 60, "carlos", 3, "Consulta odontológica — Beatriz Nogueira", "normal"],
  [9, 9, 0, 30, "ana", 2, "Avaliação postural — Juliana Castro", "pendente"],
  [10, 14, 0, 50, "ana", 1, "Sessão de fisioterapia — Camila Rocha", "normal"],
  [11, 11, 0, 60, "carlos", 3, "Consulta odontológica — Fernanda Oliveira", "normal"],
  [12, 9, 0, 50, "ana", 1, "Sessão de fisioterapia — Lucas Martins", "normal"],
];

const TIPO_IDS = [1, 2, 3].map(tipoId);
const COMPROMISSO_IDS = SEMANA.map((_, i) => compromissoId(i + 1));

/**
 * Tira do banco os compromissos e os tipos desta semente, e só eles (pelos ids
 * fixos). Roda antes de qualquer aula e no começo do `semear`. As lições de
 * Agenda não gravam compromisso novo (as de marcar e remarcar param antes de
 * confirmar); o que elas mudam — "Realizado", aprovar — é status de compromisso
 * desta semente, que sai pelo id.
 */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  semErro(
    await db.from("calendar_appointments").delete().eq("organization_id", org).in("id", COMPROMISSO_IDS),
    "limpar compromissos da agenda",
  );
  // `sale_items.event_type_id` (módulo Comandas) é `on delete restrict`. As
  // lições de Comandas só lançam os serviços da semente delas, mas a limpeza das
  // comandas roda DEPOIS desta (ordem alfabética das sementes): se uma comanda
  // ainda prender um destes tipos, eles ficam até a próxima aula, em vez de
  // derrubar a base de todas as aulas. Sem compromisso nenhum, um tipo sozinho
  // não aparece em "Atendimentos sem comanda".
  const tipos = await db.from("calendar_event_types").delete().eq("organization_id", org).in("id", TIPO_IDS);
  if (tipos.error && tipos.error.code !== "23503") semErro(tipos, "limpar tipos da agenda");
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;

  // ---------- começa do zero: compromissos e tipos desta semente (a mesma limpeza da base) ----------
  await limpar(c);

  // ---------- tipos de atendimento da clínica ----------
  const TIPOS = [
    { n: 1, name: "Sessão de fisioterapia", slug: "sessao-de-fisioterapia", category: "procedimento", duration_minutes: 50, dono: pessoa.ana, location_details: `${ENDERECO}, sala 2` },
    { n: 2, name: "Avaliação postural", slug: "avaliacao-postural", category: "consulta", duration_minutes: 30, dono: pessoa.ana, location_details: `${ENDERECO}, sala 2` },
    { n: 3, name: "Consulta odontológica", slug: "consulta-odontologica", category: "consulta", duration_minutes: 60, dono: pessoa.carlos, location_details: `${ENDERECO}, consultório 4` },
  ];
  semErro(await db.from("calendar_event_types").upsert(TIPOS.map((t) => ({
    id: tipoId(t.n), organization_id: org, name: t.name, slug: t.slug, category: t.category,
    duration_minutes: t.duration_minutes, default_owner_user_id: t.dono, location_kind: "in_person",
    location_details: t.location_details, is_active: true, position: 100 + t.n,
  })), { onConflict: "id" }), "tipos de atendimento");

  // ---------- jornada: só o horário publicado; disponibilidade e capacidade ficam como estão ----------
  const manhaETarde = (dias: number[], tarde: string) =>
    dias.flatMap((dow) => [{ dow, start: "08:00", end: "12:00" }, { dow, start: "13:00", end: tarde }]);
  const JORNADA = [
    { user_id: pessoa.ana, windows: [...manhaETarde([1, 2, 3, 4, 5], "18:00"), { dow: 6, start: "08:00", end: "12:00" }] },
    { user_id: pessoa.carlos, windows: manhaETarde([1, 2, 3, 4, 5], "17:00") },
  ];
  for (const j of JORNADA) {
    semErro(await db.from("attendant_availability").upsert({
      organization_id: org, user_id: j.user_id, schedule: { timezone: "America/Sao_Paulo", windows: j.windows },
    }, { onConflict: "organization_id,user_id" }), "jornada");
  }

  // ---------- três semanas de compromissos (os antigos saíram no `limpar` do começo) ----------
  const ids = COMPROMISSO_IDS;
  const agora = Date.now();
  semErro(await db.from("calendar_appointments").insert(SEMANA.map(([dia, h, m, dur, quem, tipo, titulo, desejo], i) => {
    const comeca = naSemana(dia, h, m);
    const passou = comeca.getTime() < agora;
    const status =
      desejo === "cancelado" ? "cancelled"
      : desejo === "pendente" ? "pending"
      : passou && desejo === "realizado" ? "completed"
      : passou && desejo === "faltou" ? "no_show"
      : "confirmed";
    const reuniao = tipo === null;
    return {
      id: ids[i], organization_id: org, event_type_id: tipo ? tipoId(tipo) : null, title: titulo,
      starts_at: comeca.toISOString(), ends_at: new Date(comeca.getTime() + dur * 60_000).toISOString(),
      time_zone: "America/Sao_Paulo", status, owner_user_id: pessoa[quem],
      location_kind: "in_person",
      location_details: reuniao ? `${ENDERECO}, sala de reuniões` : quem === "carlos" ? `${ENDERECO}, consultório 4` : `${ENDERECO}, sala 2`,
      description: reuniao ? "Pauta: escala de dezembro, novos horários de sábado e retorno dos pacientes que faltaram." : null,
      notes: reuniao ? "Trazer a lista de faltas da semana impressa." : null,
      ...(status === "cancelled" ? { cancelled_at: new Date(agora - 26 * 3_600_000).toISOString(), cancellation_reason: "O paciente pediu para remarcar por telefone." } : {}),
      created_by_kind: "user", created_by_user_id: pessoa.helena, source: "ui",
    };
  })), "compromissos");
}
