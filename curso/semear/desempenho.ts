/**
 * Semente do módulo Desempenho: um mês de trabalho da Clínica Bem Viver para a
 * tela de números ter o que contar — negócios ganhos e perdidos (com dono, data
 * de fechamento e motivo), negócios abertos espalhados pelo funil e cinco
 * conversas respondidas pela equipe, quatro delas com o atendimento encerrado.
 *
 * Tudo dentro dos últimos 30 dias (a janela da tela) e em horário comercial de
 * São Paulo, relativo ao dia em que roda.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos) e recria. Desfaz também a
 * régua do abandono que a lição do Atrito salva pela tela
 * (`organizations.settings.atrito.abandono_horas`), para cada lição partir dos
 * 72h do padrão.
 */
import { type Contexto, exigir, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const conversaId = (n: number) => `de100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const contatoId = (n: number) => `de200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const negocioId = (n: number) => `de300000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Dia de hoje + `dias`, às HH:MM de São Paulo (UTC-3, sem horário de verão). */
function diaAs(dias: number, h: number, m = 0) {
  const sp = new Date(Date.now() - 3 * 3_600_000);
  return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() + dias, h + 3, m)).toISOString();
}
/** Data (AAAA-MM-DD) de hoje + `dias` em São Paulo — coluna date. */
const dia = (dias: number) => diaAs(dias, 12).slice(0, 10);

const CONTATOS = [
  "Larissa Menezes", "Gustavo Ribeiro", "Aline Barbosa", "Marcos Vieira", "Renata Duarte",
  "Eduardo Pacheco", "Vanessa Moura", "Thiago Carvalho", "Cláudia Pires", "Rodrigo Sales",
  "Simone Araújo", "Priscila Antunes", "Felipe Rezende", "Daniela Fonseca", "Bruno Teixeira",
  "Luciana Campos", "André Moreira",
];

type Pessoa = "helena" | "ana" | "carlos";
type Msg = { dias: number; h: number; m: number; quem: "cliente" | Pessoa; texto: string };
type Conversa = { n: number; dono: Pessoa; encerrar: "resolvida" | "convertida" | null; mensagens: Msg[] };

const CONVERSAS: Conversa[] = [
  {
    n: 1, dono: "ana", encerrar: "convertida",
    mensagens: [
      { dias: -6, h: 9, m: 2, quem: "cliente", texto: "Oi! Queria começar um acompanhamento com a nutricionista. Tem horário esta semana?" },
      { dias: -6, h: 9, m: 6, quem: "ana", texto: "Oi, Larissa! Tenho quinta às 10h com a Dra. Lívia. Posso reservar?" },
      { dias: -6, h: 9, m: 11, quem: "cliente", texto: "Pode reservar, obrigada!" },
      { dias: -6, h: 9, m: 13, quem: "ana", texto: "Reservado! Até quinta." },
    ],
  },
  {
    n: 2, dono: "helena", encerrar: "convertida",
    mensagens: [
      { dias: -4, h: 8, m: 20, quem: "cliente", texto: "Bom dia, quanto fica o pacote de 10 sessões de fisioterapia?" },
      { dias: -4, h: 8, m: 32, quem: "helena", texto: "Bom dia, Gustavo! O pacote sai por R$ 1.500 e pode ser parcelado em 3 vezes." },
      { dias: -4, h: 8, m: 40, quem: "cliente", texto: "Fechado, quero começar na segunda." },
      { dias: -4, h: 8, m: 45, quem: "helena", texto: "Ótimo! Segunda às 7h está reservado para você." },
    ],
  },
  {
    n: 3, dono: "carlos", encerrar: "convertida",
    mensagens: [
      { dias: -9, h: 14, m: 10, quem: "cliente", texto: "Vocês fazem clareamento dental a laser?" },
      { dias: -9, h: 14, m: 35, quem: "carlos", texto: "Fazemos sim, Aline. A sessão dura uma hora e o valor é R$ 1.200." },
      { dias: -9, h: 14, m: 40, quem: "cliente", texto: "Quero agendar." },
      { dias: -9, h: 14, m: 44, quem: "carlos", texto: "Agendado para sábado às 9h." },
    ],
  },
  {
    // a que "morreu no silêncio": a clínica respondeu há mais de 72h e o paciente sumiu
    n: 4, dono: "helena", encerrar: null,
    mensagens: [
      { dias: -4, h: 17, m: 30, quem: "cliente", texto: "Estou com dor nas costas. Vocês atendem sem pedido médico?" },
      { dias: -4, h: 17, m: 38, quem: "helena", texto: "Atendemos sim, Marcos! Quer que eu reserve uma avaliação para amanhã às 18h?" },
    ],
  },
  {
    n: 5, dono: "ana", encerrar: "resolvida",
    mensagens: [
      { dias: -2, h: 10, m: 0, quem: "cliente", texto: "Oi, preciso remarcar meu retorno com a nutricionista." },
      { dias: -2, h: 10, m: 40, quem: "ana", texto: "Oi, Renata! Tenho terça às 14h, pode ser?" },
      { dias: -2, h: 10, m: 52, quem: "cliente", texto: "Pode sim, obrigada." },
    ],
  },
];

type Negocio = {
  n: number;
  titulo: string;
  contato: number;
  reais: number;
  dono: Pessoa;
  /** "ganho", "perdido" ou o nome da etapa aberta */
  etapa: string;
  dias: number;
  motivo?: "price" | "no_response" | "cancelled_by_customer";
  /** etapa de onde o negócio perdido saiu */
  saiuDe?: string;
  fechamento?: number;
};

const NEGOCIOS: Negocio[] = [
  { n: 1, titulo: "Pacote de 10 sessões de fisioterapia — Gustavo Ribeiro", contato: 2, reais: 1500, dono: "helena", etapa: "ganho", dias: 4 },
  { n: 2, titulo: "Consulta nutricional — Cláudia Pires", contato: 9, reais: 280, dono: "helena", etapa: "ganho", dias: 9 },
  { n: 3, titulo: "Avaliação postural — Simone Araújo", contato: 11, reais: 180, dono: "helena", etapa: "ganho", dias: 16 },
  { n: 4, titulo: "Acompanhamento nutricional — Larissa Menezes", contato: 1, reais: 840, dono: "ana", etapa: "ganho", dias: 6 },
  { n: 5, titulo: "Pilates duas vezes por semana — Vanessa Moura", contato: 7, reais: 960, dono: "ana", etapa: "ganho", dias: 1 },
  { n: 6, titulo: "Retorno nutricional — Renata Duarte", contato: 5, reais: 200, dono: "ana", etapa: "ganho", dias: 12 },
  { n: 7, titulo: "Fisioterapia pós-cirúrgica — Thiago Carvalho", contato: 8, reais: 1200, dono: "ana", etapa: "ganho", dias: 20 },
  { n: 8, titulo: "Clareamento dental — Aline Barbosa", contato: 3, reais: 1200, dono: "carlos", etapa: "ganho", dias: 9 },
  { n: 9, titulo: "Limpeza e avaliação odontológica — Rodrigo Sales", contato: 10, reais: 250, dono: "carlos", etapa: "ganho", dias: 25 },
  { n: 10, titulo: "Implante dentário — Felipe Rezende", contato: 13, reais: 4500, dono: "carlos", etapa: "perdido", dias: 3, motivo: "price", saiuDe: "Consulta agendada" },
  { n: 11, titulo: "Pacote de pilates — Priscila Antunes", contato: 12, reais: 960, dono: "helena", etapa: "perdido", dias: 11, motivo: "price", saiuDe: "Primeiro contato" },
  { n: 12, titulo: "Avaliação odontológica — Eduardo Pacheco", contato: 6, reais: 150, dono: "ana", etapa: "perdido", dias: 8, motivo: "no_response", saiuDe: "Primeiro contato" },
  { n: 13, titulo: "Avaliação de fisioterapia — Daniela Fonseca", contato: 14, reais: 180, dono: "ana", etapa: "perdido", dias: 14, motivo: "cancelled_by_customer", saiuDe: "Consulta agendada" },
  { n: 14, titulo: "Avaliação de fisioterapia — Marcos Vieira", contato: 4, reais: 180, dono: "helena", etapa: "Primeiro contato", dias: 4 },
  { n: 15, titulo: "Consulta de nutrição esportiva — Bruno Teixeira", contato: 15, reais: 320, dono: "ana", etapa: "Primeiro contato", dias: 2 },
  { n: 16, titulo: "Clareamento dental — Luciana Campos", contato: 16, reais: 1200, dono: "helena", etapa: "Consulta agendada", dias: 3, fechamento: 12 },
  { n: 17, titulo: "Aparelho ortodôntico — André Moreira", contato: 17, reais: 3600, dono: "carlos", etapa: "Consulta agendada", dias: 5, fechamento: 20 },
  { n: 18, titulo: "Retorno de fisioterapia — Thiago Carvalho", contato: 8, reais: 150, dono: "ana", etapa: "Retorno", dias: 1 },
];

export async function semear(c: Contexto) {
  const { db, org, pessoa, sessao, funil } = c;

  // ---------- limpa o que é desta semente ----------
  semErro(await db.from("crm_leads").delete().eq("organization_id", org).in("id", NEGOCIOS.map((x) => negocioId(x.n))), "limpar negócios");
  semErro(await db.from("conversations").delete().eq("organization_id", org).in("id", CONVERSAS.map((x) => conversaId(x.n))), "limpar conversas");
  semErro(await db.from("contacts").delete().eq("organization_id", org).in("id", CONTATOS.map((_, i) => contatoId(i + 1))), "limpar contatos");

  // ---------- a régua do abandono volta ao padrão (a lição a muda pela tela) ----------
  const orgRow = exigir(await db.from("organizations").select("settings").eq("id", org).single(), "settings") as { settings: Record<string, unknown> | null };
  const settings = { ...(orgRow.settings ?? {}) };
  const atrito = { ...((settings.atrito as Record<string, unknown> | undefined) ?? {}) };
  if ("abandono_horas" in atrito) {
    delete atrito.abandono_horas;
    settings.atrito = atrito;
    semErro(await db.from("organizations").update({ settings }).eq("id", org), "régua do abandono");
  }

  // ---------- contatos ----------
  semErro(await db.from("contacts").insert(CONTATOS.map((name, i) => ({
    id: contatoId(i + 1), organization_id: org, name, phone_number: `+55119876501${String(40 + i)}`,
  }))), "contatos");

  // ---------- conversas respondidas pela equipe ----------
  for (const cv of CONVERSAS) {
    const conversa = conversaId(cv.n), contato = contatoId(cv.n);
    semErro(await db.from("conversations").insert({
      id: conversa, organization_id: org, contact_id: contato, channel_session_id: sessao, status: "open",
    }), `conversa ${cv.n}`);
    for (const msg of cv.mensagens) {
      const em = diaAs(msg.dias, msg.h, msg.m);
      const recebida = msg.quem === "cliente";
      semErro(await db.from("messages").insert({
        organization_id: org, conversation_id: conversa, channel_session_id: sessao, contact_id: contato,
        type: "text", body: msg.texto, direction: recebida ? "inbound" : "outbound",
        status: recebida ? "received" : "read",
        sent_via: recebida ? "external_device" : "user",
        sent_by_user_id: recebida ? null : pessoa[msg.quem as Pessoa],
        sent_at: em, created_at: em,
      }), `mensagem da conversa ${cv.n}`);
      semErro(await db.rpc("fn_mark_conversation_message", {
        p_conv: conversa, p_direction: recebida ? "inbound" : "outbound", p_preview: msg.texto, p_at: em,
      }), `carimbo da conversa ${cv.n}`);
    }
    semErro(await db.rpc("fn_conversation_assign", {
      p_organization_id: org, p_conversation_id: conversa, p_to_user_id: pessoa[cv.dono], p_reason: "claim",
    }), `atribuir conversa ${cv.n}`);
    if (!cv.encerrar) continue;
    // a demanda encerrada é o que dá base ao Atrito; o caminho é o mesmo do produto
    const atual = exigir(await db.from("conversations").select("current_demanda_id").eq("id", conversa).single(), `demanda ${cv.n}`) as { current_demanda_id: string | null };
    if (!atual.current_demanda_id) throw new Error(`conversa ${cv.n} sem demanda aberta`);
    const d = exigir(await db.from("demandas").select("revision").eq("id", atual.current_demanda_id).single(), `revisão ${cv.n}`) as { revision: number };
    semErro(await db.rpc("fn_demanda_encerrar", {
      p_org: org, p_demanda: atual.current_demanda_id, p_expected: d.revision, p_desfecho: cv.encerrar, p_actor: pessoa[cv.dono],
    }), `encerrar demanda ${cv.n}`);
    semErro(await db.from("conversations").update({ status: "closed", unread_count_for_assignee: 0 }).eq("id", conversa), `fechar conversa ${cv.n}`);
  }

  // ---------- etapas 5-7 que a base deixa com nome de loja ----------
  // O cartão Funil desenha TODAS as etapas: "Enviado", "Entregue" e "Pós-venda"
  // apareceriam numa clínica. Mesmos nomes e mesma regra (por posição) de
  // semear/funis.ts, então a ordem dos módulos não importa.
  // ponytail: altera linhas da base; o lugar certo é semear-demonstracao.ts.
  const porPosicao = exigir(
    await db.from("crm_stages").select("id, is_lost").eq("pipeline_id", funil.id).order("position"),
    "etapas por posição",
  ) as Array<{ id: string; is_lost: boolean }>;
  for (const [i, nome] of ["Reavaliação", "Alta", "Pós-tratamento"].entries()) {
    const e = porPosicao[4 + i];
    if (e && !e.is_lost) semErro(await db.from("crm_stages").update({ name: nome }).eq("id", e.id), `etapa ${nome}`);
  }

  // ---------- negócios: ganhos, perdidos e abertos no funil Pacientes ----------
  const etapas = exigir(
    await db.from("crm_stages").select("id, name, is_won, is_lost").eq("pipeline_id", funil.id).eq("is_archived", false).order("position"),
    "etapas",
  ) as Array<{ id: string; name: string; is_won: boolean; is_lost: boolean }>;
  const etapa = (nome: string) => {
    const e = nome === "ganho" ? etapas.find((x) => x.is_won) : nome === "perdido" ? etapas.find((x) => x.is_lost) : etapas.find((x) => x.name === demo(nome));
    if (!e) throw new Error(`etapa "${nome}" não existe no funil Pacientes`);
    return e.id;
  };
  for (const [i, x] of NEGOCIOS.entries()) {
    const fechou = x.etapa === "ganho" || x.etapa === "perdido";
    const quando = diaAs(-x.dias, 11 + (i % 6), 15);
    semErro(await db.from("crm_leads").insert({
      id: negocioId(x.n), organization_id: org, pipeline_id: funil.id, stage_id: etapa(x.etapa),
      title: x.titulo, contact_id: contatoId(x.contato), value_cents: x.reais * 100, currency: "BRL",
      status: x.etapa === "ganho" ? "won" : x.etapa === "perdido" ? "lost" : "open",
      closed_at: fechou ? quando : null,
      lost_reason: x.motivo ?? null,
      lost_from_stage_id: x.saiuDe ? etapa(x.saiuDe) : null,
      owner_user_id: pessoa[x.dono], owner_kind: "user", assigned_at: diaAs(-x.dias - 2, 10),
      expected_close_date: x.fechamento === undefined ? null : dia(x.fechamento),
      position_in_stage: 5000 + i * 1000,
      stage_changed_at: quando, created_at: diaAs(-x.dias - 2, 10),
    }), `negócio ${x.titulo}`);
  }
}
