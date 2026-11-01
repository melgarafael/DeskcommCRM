/**
 * Follow-ups da tela /app/ai/followups — três fluxos da Clínica Bem Viver e a
 * fila de quem está dentro deles.
 *
 *   • "Consulta · retomar quem sumiu na marcação" — instalado do modelo e
 *     PUBLICADO (Ativo);
 *   • "Falta · remarcar quem não veio" — instalado e nunca publicado (Rascunho);
 *   • "Cirurgia · acompanhar a decisão" — publicado e depois DESATIVADO.
 *
 * Instala como a rota `from-model` instala (o grafo e o gatilho do catálogo em
 * `lib/followup/modelos`, nunca um desenho à mão) e publica pela mesma função
 * do botão Publicar (`fn_publish_followup_flow_version`).
 *
 * A fila: quatro inscrições no fluxo da consulta (uma esperando resposta, uma
 * pausada porque a Ana assumiu, uma pausada pela Helena e uma encerrada porque
 * a paciente respondeu), com a linha do tempo gravada como o motor grava, e uma
 * promessa de retorno que a Bia agendou. Tudo no futuro ou parado: nada vence
 * durante a captura.
 *
 * Idempotente: apaga os fluxos com os ids daqui e os que as lições criam pelos
 * nomes do catálogo (instalar o modelo do exame); inscrições, versões e eventos
 * vão em cascata. A base já apaga os contatos, o que leva inscrições e promessas.
 */
import { MODELOS_DE_FOLLOWUP } from "../../lib/followup/modelos";
import { type Contexto, contatoId, conversaId, exigir, ha, semErro } from "../semear-demonstracao";

const fluxoId = (n: number) => `be300000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const inscricaoId = (n: number) => `be320000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const promessaId = (n: number) => `be330000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DIA = 24 * 60;
/** Minutos no FUTURO (o `ha` só anda para trás). */
const daqui = (minutos: number) => ha(-minutos);

function modelo(id: string) {
  const m = MODELOS_DE_FOLLOWUP.find((x) => x.id === id);
  if (!m) throw new Error(`modelo ${id} não existe no catálogo`);
  return m;
}

type Evento = { em: string; no: string | null; tipo: string; payload?: Record<string, unknown> };
type Inscricao = {
  n: number;
  status: "waiting_reply" | "paused_handoff" | "paused_manual" | "cancelled";
  no: string;
  proximo: string | null;
  inicio: string;
  passos: number;
  desfecho?: "replied";
  fim?: string;
  eventos: Evento[];
};

/** O começo de toda escada: saiu do início, mandou a primeira e ficou esperando a resposta. */
const primeiroToque = (em: string): Evento[] => [
  { em, no: "inicio", tipo: "node_advanced", payload: { next_node_id: "msg-1" } },
  { em, no: "msg-1", tipo: "action_sent" },
  { em, no: "msg-1", tipo: "node_advanced", payload: { next_node_id: "resposta-1" } },
];

export async function semear(c: Contexto) {
  const { db, org } = c;

  // ---------- limpa o que é deste módulo ----------
  const nomes = MODELOS_DE_FOLLOWUP.map((m) => m.nome);
  semErro(await db.from("followup_flow_pointers").delete().eq("organization_id", org).in("id", [1, 2, 3].map(fluxoId)), "limpar fluxos");
  semErro(await db.from("followup_flow_pointers").delete().eq("organization_id", org).in("name", nomes), "limpar fluxos por nome");
  for (const nome of nomes) {
    semErro(await db.from("followup_flow_pointers").delete().eq("organization_id", org).like("name", `${nome} (cópia%`), "limpar cópias");
  }

  // ---------- os três fluxos ----------
  const FLUXOS = [
    { n: 1, modelo: "clinica-consulta-retomada", publicar: true, desativar: false, atualizado: ha(70) },
    { n: 2, modelo: "clinica-falta-remarcar", publicar: false, desativar: false, atualizado: ha(DIA + 200) },
    { n: 3, modelo: "clinica-cirurgia-decisao", publicar: true, desativar: true, atualizado: ha(12 * DIA) },
  ] as const;
  const versaoDe: Record<number, string> = {};
  for (const f of FLUXOS) {
    const m = modelo(f.modelo);
    semErro(await db.from("followup_flow_pointers").insert({
      id: fluxoId(f.n), organization_id: org, name: m.nome, draft_graph: m.grafo,
      trigger_config: m.gatilho({ stageId: c.funil.etapas[3] }), handoff_policy: m.handoffPolicy,
    }), `fluxo ${m.nome}`);
    if (f.publicar) {
      versaoDe[f.n] = exigir(await db.rpc("fn_publish_followup_flow_version", {
        p_org: org, p_pointer: fluxoId(f.n), p_graph: m.grafo, p_created_by: c.pessoa.helena,
      }), `publicar ${m.nome}`) as string;
    }
    semErro(await db.from("followup_flow_pointers").update({
      ...(f.desativar ? { status: "disabled" } : {}), updated_at: f.atualizado,
    }).eq("id", fluxoId(f.n)), `estado de ${m.nome}`);
  }

  // ---------- a fila: inscrições no fluxo da consulta ----------
  const INSCRICOES: Inscricao[] = [
    {
      // Antônio sumiu há 6 dias: já levou dois toques e o fluxo espera a resposta do segundo
      n: 9, status: "waiting_reply", no: "resposta-2", proximo: daqui(DIA + 5 * 60), inicio: ha(5 * DIA), passos: 7,
      eventos: [
        ...primeiroToque(ha(5 * DIA)),
        { em: ha(3 * DIA), no: "resposta-1", tipo: "node_advanced", payload: { next_node_id: "espera-2", class: "no_reply" } },
        { em: ha(3 * DIA), no: "espera-2", tipo: "wait_started", payload: { next_eval_at: ha(DIA) } },
        { em: ha(DIA), no: "espera-2", tipo: "node_advanced", payload: { next_node_id: "msg-2" } },
        { em: ha(DIA), no: "msg-2", tipo: "action_sent" },
        { em: ha(DIA), no: "msg-2", tipo: "node_advanced", payload: { next_node_id: "resposta-2" } },
      ],
    },
    {
      // a Ana assumiu a conversa do Lucas: o fluxo espera ela terminar
      n: 6, status: "paused_handoff", no: "resposta-1", proximo: null, inicio: ha(DIA + 300), passos: 2,
      eventos: [...primeiroToque(ha(DIA + 300)), { em: ha(190), no: "resposta-1", tipo: "handoff_paused" }],
    },
    {
      // a Helena segurou o fluxo da Camila
      n: 7, status: "paused_manual", no: "resposta-1", proximo: null, inicio: ha(DIA + 120), passos: 2,
      eventos: [
        ...primeiroToque(ha(DIA + 120)),
        { em: ha(45), no: "resposta-1", tipo: "paused_manual", payload: { actor_user_id: c.pessoa.helena } },
      ],
    },
    {
      // a Tereza respondeu ao primeiro toque: o fluxo saiu de cena
      n: 12, status: "cancelled", no: "resposta-1", proximo: null, inicio: ha(3 * DIA), passos: 2, desfecho: "replied", fim: ha(2 * DIA + 600),
      eventos: [...primeiroToque(ha(3 * DIA)), { em: ha(2 * DIA + 600), no: "resposta-1", tipo: "reactivity_replied" }],
    },
  ];
  for (const i of INSCRICOES) {
    semErro(await db.from("followup_enrollments").insert({
      id: inscricaoId(i.n), organization_id: org, pointer_id: fluxoId(1), version_id: versaoDe[1], agent_id: c.agenteId,
      contact_id: contatoId(i.n), conversation_id: conversaId(i.n), current_node_id: i.no, status: i.status,
      next_eval_at: i.proximo, steps_taken: i.passos, started_at: i.inicio, updated_at: i.fim ?? i.eventos.at(-1)!.em,
      ...(i.desfecho ? { outcome: i.desfecho, completed_at: i.fim } : {}),
    }), `inscrição do contato ${i.n}`);
    // um segundo entre eventos: os do mesmo instante sairiam em ordem qualquer na linha do tempo
    semErro(await db.from("followup_enrollment_events").insert(i.eventos.map((e, k) => ({
      organization_id: org, enrollment_id: inscricaoId(i.n), node_id: e.no, event_type: e.tipo, payload: e.payload ?? {},
      created_at: new Date(Date.parse(e.em) + k * 1000).toISOString(),
    }))), `eventos da inscrição ${i.n}`);
  }

  // ---------- a promessa: a Bia combinou de voltar a falar com o Pedro ----------
  const amanha9h = (() => {
    const sp = new Date(Date.now() - 3 * 3600_000);
    return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() + 1, 9 + 3, 0)).toISOString();
  })();
  semErro(await db.from("cron_jobs").insert({
    id: promessaId(4), organization_id: org, contact_id: contatoId(4), kind: "at", job_kind: "followup_turn", next_run_at: amanha9h,
    payload: {
      reason: "Pedro vai confirmar com o banco se consegue pagar por Pix",
      promise: "Amanhã cedo eu te chamo para confirmar a forma de pagamento e o horário da consulta.",
      promised_at: amanha9h, conversation_id: conversaId(4),
    },
  }), "promessa do Pedro");
}
