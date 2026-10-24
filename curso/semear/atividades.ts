/**
 * Semente do módulo Atividades: uma semana movimentada da Clínica Bem Viver no
 * registro de acontecimentos (`crm_lead_activities`), mais algumas conversas
 * com etiqueta para a aba "Por etiqueta".
 *
 * - 6 negócios próprios (ids fixos) para pacientes da base, e os 2 negócios da
 *   base achados pelo título (a base os recria com id novo a cada rodada).
 * - 29 acontecimentos nos últimos 7 dias, divididos entre a equipe (Helena, Ana,
 *   Carlos), a agente Bia e o sistema; mais 10 entre 8 e 25 dias atrás, que só
 *   aparecem quando o período passa para 30 dias.
 * - 6 conversas próprias com etiquetas (agendamento, convenio, remarcacao,
 *   orcamento, pos-operatorio), abertas e encerradas, com espera mensurável.
 *
 * Linhas de agente levam `evidence` (a constraint exige lastro para ator `ai`).
 * Idempotente: apaga só as próprias linhas (ids fixos) e recria.
 */
import { type Contexto, contatoId, exigir, ha, semErro } from "../semear-demonstracao";

const id = (prefixo: string) => (n: number) => `${prefixo}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const negocioId = id("be3c0000");
const atividadeId = id("be4c0000");
const contatoProprio = id("be2c0000");
const conversaPropria = id("be1c0000");
const execucaoId = id("be5c0000");

const DIA = 24 * 60;
const LEAD_MARIANA = "Primeira consulta nutricional — Mariana";
const LEAD_FERNANDA = "Retorno pós-cirúrgico — Fernanda Oliveira";

type Quem = "helena" | "ana" | "carlos" | "bia" | "sistema";
type Negocio = "mariana" | "fernanda" | 1 | 2 | 3 | 4 | 5 | 6;
type Atividade = { min: number; quem: Quem; tipo: string; negocio: Negocio; motivo: string };

/** Negócios próprios: [n, título, contato da base, etapa (índice), valor em reais, dono]. */
const NEGOCIOS = [
  [1, "Fisioterapia — Roberto Almeida", 2, 2, 1200, "ana"],
  [2, "Avaliação nutricional — Juliana Castro", 3, 1, 280, "helena"],
  [3, "Consulta de nutrição — Pedro Henrique", 4, 0, 280, null],
  [4, "Pacote de 10 sessões de fisioterapia — Lucas Martins", 6, 2, 1500, "ana"],
  [5, "Avaliação postural — Camila Rocha", 7, 1, 180, "helena"],
  [6, "Clareamento dental — Tereza Gomes", 12, 3, 900, "carlos"],
] as const;

/** Contato de cada negócio — o relatório mostra o nome dele ao lado do link. */
const CONTATO_DO_NEGOCIO: Record<string, number> = { mariana: 1, fernanda: 5, 1: 2, 2: 3, 3: 4, 4: 6, 5: 7, 6: 12 };

const ASSUMIU = "Assumiu o atendimento desta conversa";
const NASCEU = "Primeira mensagem pelo WhatsApp";

const ATIVIDADES: Atividade[] = [
  // ---- últimos 7 dias ----
  { min: 18, quem: "helena", tipo: "conversation_claimed", negocio: "mariana", motivo: ASSUMIU },
  { min: 34, quem: "bia", tipo: "ai_turn", negocio: 3, motivo: "Informou o valor da consulta particular e as formas de pagamento" },
  { min: 41, quem: "bia", tipo: "handoff_triggered", negocio: "mariana", motivo: "A paciente pediu para falar com uma pessoa" },
  { min: 75, quem: "ana", tipo: "stage_changed", negocio: 1, motivo: "Movido de Consulta agendada para Em tratamento" },
  { min: 110, quem: "bia", tipo: "appointment_scheduled", negocio: 5, motivo: "Avaliação postural na sexta às 10h" },
  { min: 125, quem: "helena", tipo: "task_completed", negocio: "fernanda", motivo: "Confirmar o retorno da Fernanda com o Dr. Paulo" },
  { min: DIA + 60, quem: "carlos", tipo: "conversation_transferred", negocio: 4, motivo: "Transferida para Ana Ribeiro, que acompanha o pacote de sessões" },
  { min: DIA + 150, quem: "ana", tipo: "appointment_completed", negocio: 4, motivo: "Sessão de fisioterapia realizada" },
  { min: DIA + 200, quem: "sistema", tipo: "lead_created", negocio: 3, motivo: NASCEU },
  { min: DIA + 300, quem: "helena", tipo: "stage_changed", negocio: "fernanda", motivo: "Movido de Primeiro contato para Consulta agendada" },
  { min: DIA + 420, quem: "bia", tipo: "followup_scheduled", negocio: 2, motivo: "Retomar o contato na segunda para confirmar a guia do convênio" },
  { min: 2 * DIA + 30, quem: "helena", tipo: "appointment_scheduled", negocio: "fernanda", motivo: "Retorno com o Dr. Paulo na quinta às 9h30" },
  { min: 2 * DIA + 90, quem: "ana", tipo: "task_completed", negocio: 6, motivo: "Enviar as orientações de cuidado depois do clareamento" },
  { min: 2 * DIA + 240, quem: "carlos", tipo: "stage_changed", negocio: 6, motivo: "Movido de Em tratamento para Retorno" },
  { min: 2 * DIA + 400, quem: "sistema", tipo: "lead_cooled", negocio: 2, motivo: "Sem resposta além do prazo deste estágio" },
  { min: 3 * DIA + 20, quem: "helena", tipo: "conversation_claimed", negocio: 2, motivo: ASSUMIU },
  { min: 3 * DIA + 80, quem: "helena", tipo: "stage_changed", negocio: 2, motivo: "Movido de Primeiro contato para Consulta agendada" },
  { min: 3 * DIA + 150, quem: "bia", tipo: "ai_turn", negocio: 5, motivo: "Explicou como funciona a avaliação postural" },
  { min: 3 * DIA + 260, quem: "ana", tipo: "stage_changed", negocio: 5, motivo: "Movido de Primeiro contato para Consulta agendada" },
  { min: 3 * DIA + 380, quem: "sistema", tipo: "lead_created", negocio: 5, motivo: NASCEU },
  { min: 4 * DIA + 60, quem: "helena", tipo: "lead_edited", negocio: 4, motivo: "Alterou o valor" },
  { min: 4 * DIA + 200, quem: "ana", tipo: "conversation_claimed", negocio: 1, motivo: ASSUMIU },
  { min: 4 * DIA + 330, quem: "bia", tipo: "ai_turn", negocio: 1, motivo: "Confirmou o horário da fisioterapia e mandou o endereço" },
  { min: 5 * DIA + 100, quem: "carlos", tipo: "note", negocio: 6, motivo: "Paciente prefere ser atendida no fim da tarde" },
  { min: 5 * DIA + 250, quem: "ana", tipo: "appointment_completed", negocio: 1, motivo: "Sessão de fisioterapia realizada" },
  { min: 6 * DIA + 60, quem: "helena", tipo: "stage_changed", negocio: 4, motivo: "Movido de Consulta agendada para Em tratamento" },
  { min: 6 * DIA + 140, quem: "ana", tipo: "task_completed", negocio: 4, motivo: "Cobrar a assinatura do contrato do pacote" },
  { min: 6 * DIA + 260, quem: "bia", tipo: "ai_turn", negocio: 2, motivo: "Confirmou que a clínica atende pelo convênio Unimed" },
  { min: 6 * DIA + 400, quem: "sistema", tipo: "lead_created", negocio: 2, motivo: NASCEU },
  // ---- 8 a 25 dias atrás: só entram com o período de 30 dias ----
  { min: 8 * DIA + 600, quem: "ana", tipo: "note", negocio: 4, motivo: "Paciente treina corrida; evitar horários de manhã cedo" },
  { min: 9 * DIA, quem: "helena", tipo: "appointment_scheduled", negocio: 4, motivo: "Avaliação de fisioterapia na terça às 18h" },
  { min: 10 * DIA, quem: "sistema", tipo: "lead_created", negocio: 4, motivo: NASCEU },
  { min: 12 * DIA, quem: "ana", tipo: "stage_changed", negocio: 1, motivo: "Movido de Primeiro contato para Consulta agendada" },
  { min: 13 * DIA, quem: "sistema", tipo: "lead_created", negocio: 1, motivo: NASCEU },
  { min: 18 * DIA, quem: "helena", tipo: "stage_changed", negocio: 6, motivo: "Movido de Consulta agendada para Em tratamento" },
  { min: 20 * DIA, quem: "carlos", tipo: "appointment_completed", negocio: 6, motivo: "Avaliação odontológica realizada" },
  { min: 22 * DIA, quem: "helena", tipo: "task_completed", negocio: 6, motivo: "Enviar o orçamento do clareamento" },
  { min: 24 * DIA, quem: "bia", tipo: "ai_turn", negocio: 6, motivo: "Tirou dúvidas sobre o clareamento dental" },
  { min: 25 * DIA, quem: "sistema", tipo: "lead_created", negocio: 6, motivo: NASCEU },
];

const MODULO_DO_TIPO: Record<string, string> = {
  conversation_claimed: "inbox", conversation_transferred: "inbox", handoff_triggered: "agent", ai_turn: "agent",
  stage_changed: "crm", lead_edited: "crm", note: "crm", lead_created: "canal.ingest", lead_cooled: "risk",
  appointment_scheduled: "agenda", appointment_completed: "agenda", task_completed: "tasks", followup_scheduled: "followup",
};

/** Conversas próprias com etiqueta: [n, nome, etiquetas, aberta?, cliente escreveu há (min), resposta depois de (min) | null, quem respondeu]. */
const CONVERSAS = [
  [1, "Patrícia Mendes", ["agendamento"], true, 3 * 60, null, null],
  [2, "Gustavo Ramos", ["agendamento", "convenio"], false, 2 * DIA, 12, "helena"],
  [3, "Sandra Vieira", ["remarcacao"], false, DIA + 200, 25, "ana"],
  [4, "Eduardo Costa", ["orcamento"], true, 50, 1, "ia"],
  [5, "Larissa Pinto", ["convenio"], false, 3 * DIA, 40, "helena"],
  [6, "Marcos Teixeira", ["remarcacao", "pos-operatorio"], true, 5 * 60, 8, "ana"],
] as const;

const PERGUNTA: Record<number, string> = {
  1: "Oi! Queria marcar uma limpeza com a dentista. Tem horário na semana que vem?",
  2: "Bom dia, quero agendar fisioterapia pelo convênio. Preciso de guia?",
  3: "Não vou conseguir ir na sessão de amanhã. Dá para trocar para sexta?",
  4: "Quanto custa o pacote de 10 sessões de pilates?",
  5: "Vocês aceitam o convênio Bradesco Saúde para nutrição?",
  6: "Preciso remarcar o retorno da cirurgia do joelho, pode ser na outra semana?",
};
const RESPOSTA: Record<number, string> = {
  2: "Bom dia, Gustavo! Precisa sim. Com a guia em mãos, já marco o seu horário.",
  3: "Claro, Sandra! Fica para sexta às 17h.",
  4: "O pacote de 10 sessões sai por R$ 900,00, Eduardo. Quer que eu veja os horários?",
  5: "Aceitamos sim, Larissa! A consulta sai sem custo pelo seu plano.",
  6: "Pode sim, Marcos. Tenho terça às 8h30 com o Dr. Paulo.",
};

export async function semear(c: Contexto) {
  const { db, org, pessoa, sessao, agenteId, funil } = c;

  // ---------- limpa só o que é desta semente ----------
  semErro(await db.from("crm_lead_activities").delete().eq("organization_id", org).in("id", ATIVIDADES.map((_, i) => atividadeId(i + 1))), "limpar atividades");
  semErro(await db.from("crm_leads").delete().eq("organization_id", org).in("id", NEGOCIOS.map(([n]) => negocioId(n))), "limpar negócios");
  semErro(await db.from("conversations").delete().eq("organization_id", org).in("id", CONVERSAS.map(([n]) => conversaPropria(n))), "limpar conversas");
  semErro(await db.from("contacts").delete().eq("organization_id", org).in("id", CONVERSAS.map(([n]) => contatoProprio(n))), "limpar contatos");

  // ---------- negócios ----------
  semErro(await db.from("crm_leads").insert(NEGOCIOS.map(([n, title, contato, etapa, reais, dono]) => ({
    id: negocioId(n), organization_id: org, pipeline_id: funil.id, stage_id: funil.etapas[etapa]!, title, contact_id: contatoId(contato),
    value_cents: reais * 100, currency: "BRL", status: "open", owner_user_id: dono ? pessoa[dono] : null,
  }))), "negócios");
  const daBase = exigir(
    await db.from("crm_leads").select("id, title").eq("organization_id", org).in("title", [LEAD_MARIANA, LEAD_FERNANDA]),
    "negócios da base",
  ) as Array<{ id: string; title: string }>;
  const daBasePorTitulo = (titulo: string) => {
    const l = daBase.find((x) => x.title === titulo);
    if (!l) throw new Error(`negócio da base sumiu: ${titulo}`);
    return l.id;
  };
  const leadDe = (n: Negocio) =>
    n === "mariana" ? daBasePorTitulo(LEAD_MARIANA) : n === "fernanda" ? daBasePorTitulo(LEAD_FERNANDA) : negocioId(n);

  // ---------- acontecimentos ----------
  semErro(await db.from("crm_lead_activities").insert(ATIVIDADES.map((a, i) => {
    const quando = ha(a.min);
    const humano = a.quem === "helena" || a.quem === "ana" || a.quem === "carlos";
    return {
      id: atividadeId(i + 1), organization_id: org, lead_id: leadDe(a.negocio), contact_id: contatoId(CONTATO_DO_NEGOCIO[String(a.negocio)]!),
      source_module: MODULO_DO_TIPO[a.tipo] ?? "crm", type: a.tipo, reason: a.motivo,
      actor_kind: humano ? "user" : a.quem === "bia" ? "ai" : "system",
      performed_by_user_id: humano ? pessoa[a.quem as "helena" | "ana" | "carlos"] : null,
      actor_agent_id: a.quem === "bia" ? agenteId : null,
      // ator `ai` sem lastro é recusado pela constraint crm_lead_activities_ai_needs_evidence
      evidence: a.quem === "bia" ? { run_ids: [execucaoId(i + 1)] } : null,
      performed_at: quando, created_at: quando,
    };
  })), "atividades");

  // ---------- conversas com etiqueta (aba Por etiqueta) ----------
  for (const [n, nome, tags, aberta, escreveu, depois, quem] of CONVERSAS) {
    const contato = contatoProprio(n), conversa = conversaPropria(n);
    semErro(await db.from("contacts").insert({
      id: contato, organization_id: org, name: nome, phone_number: `+55119876502${String(n).padStart(2, "0")}`,
    }), `contato ${nome}`);
    semErro(await db.from("conversations").insert({
      id: conversa, organization_id: org, contact_id: contato, channel_session_id: sessao, status: "open", tags: [...tags],
    }), `conversa ${nome}`);
    const mensagens = [{ em: ha(escreveu), recebida: true, texto: PERGUNTA[n]! }];
    if (depois !== null) mensagens.push({ em: ha(escreveu - depois), recebida: false, texto: RESPOSTA[n]! });
    for (const msg of mensagens) {
      const humano = !msg.recebida && quem !== "ia";
      semErro(await db.from("messages").insert({
        organization_id: org, conversation_id: conversa, channel_session_id: sessao, contact_id: contato,
        type: "text", body: msg.texto, direction: msg.recebida ? "inbound" : "outbound",
        status: msg.recebida ? "received" : "read",
        sent_via: msg.recebida ? "external_device" : humano ? "user" : "ai",
        sent_by_user_id: humano ? pessoa[quem as "helena" | "ana"] : null,
        sent_at: msg.em, created_at: msg.em,
        ...(!msg.recebida && !humano ? { metadata: { ai_generated: true } } : {}),
      }), `mensagem de ${nome}`);
      semErro(await db.rpc("fn_mark_conversation_message", {
        p_conv: conversa, p_direction: msg.recebida ? "inbound" : "outbound", p_preview: msg.texto, p_at: msg.em,
      }), `carimbo de ${nome}`);
    }
    semErro(await db.from("conversations").update({
      status: aberta ? (quem === "ia" ? "ai_handling" : "open") : "closed",
      bot_silenced_until: null, unread_count_for_assignee: 0,
    }).eq("id", conversa), `estado de ${nome}`);
  }
}
