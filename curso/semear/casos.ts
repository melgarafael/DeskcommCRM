/**
 * Casos da tela /app/ai/cases — os bloqueios que a Bia (a IA da clínica) abriu
 * para a equipe resolver. Três abertos (dois esperando a equipe, um esperando o
 * paciente) e três já encerrados, um de cada desfecho.
 *
 * Grava como o motor grava (`lib/agent-engine/agent/human-cases.ts`): a linha
 * em `agent_cases` + os eventos da linha do tempo em `agent_case_events`, com
 * os mesmos `kind`/`actor_kind`/`human_action` de cada transição. Insere já no
 * status final, então os gatilhos de FECHAMENTO não rodam (só o de abertura,
 * que só emite evento).
 *
 * Idempotente: apaga só os casos com os ids daqui (os eventos vão em cascata).
 * A base já apaga as conversas, o que também leva os casos junto.
 */
import { type Contexto, conversaId, exigir, ha, ontemAs, semErro } from "../semear-demonstracao";

/** Um segundo depois: eventos do mesmo instante sairiam em ordem qualquer na linha do tempo. */
const depois = (iso: string) => new Date(Date.parse(iso) + 1000).toISOString();
const casoId = (n: number) => `ca5e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Evento = {
  em: string;
  kind: string;
  ator: "agent" | "human" | "system" | "lead";
  humano?: "helena";
  acao?: "resolved" | "need_lead_info" | "escalate";
  texto?: string;
};

type Caso = {
  n: number;
  conversa: number;
  kind: string;
  status: "awaiting_human" | "awaiting_lead" | "resolved" | "escalated" | "cancelled";
  source?: "agent" | "guardrail_autofallback";
  title: string;
  summary: string;
  blocker: string;
  aberto: string;
  fechado?: string;
  eventos: Evento[];
};

const CASOS: Caso[] = [
  {
    n: 1, conversa: 4, kind: "financeiro", status: "awaiting_human",
    title: "Desconto no Pix",
    summary: "Pedro quer saber se a consulta particular com a nutricionista (R$ 280,00) tem desconto no pagamento por Pix.",
    blocker: "As instruções não falam de desconto no Pix, e a IA não pode prometer preço diferente sem a equipe confirmar.",
    aberto: ha(2),
    eventos: [
      { em: ha(2), kind: "opened", ator: "agent" },
      { em: ha(1), kind: "agent_noted", ator: "agent", texto: "Avisei o Pedro que a recepção confirma o valor no Pix em instantes." },
    ],
  },
  {
    n: 2, conversa: 7, kind: "agendamento", status: "awaiting_lead",
    title: "Sábado de manhã",
    summary: "Camila quer fazer a primeira sessão de fisioterapia, com a avaliação postural, num sábado de manhã.",
    blocker: "A agenda de sábado da fisioterapia não está liberada para a IA marcar.",
    aberto: ha(48),
    eventos: [
      { em: ha(48), kind: "opened", ator: "agent" },
      { em: ha(30), kind: "human_replied", ator: "human", humano: "helena", acao: "need_lead_info", texto: "Temos sábado às 8h ou às 11h. Pergunte qual ela prefere." },
      { em: depois(ha(30)), kind: "lead_asked", ator: "human", humano: "helena" },
    ],
  },
  {
    n: 3, conversa: 3, kind: "duvida", status: "awaiting_human", source: "guardrail_autofallback",
    title: "Convênio Unimed",
    summary: "Juliana quer saber se o plano Unimed dela cobre 10 sessões de fisioterapia ou se precisa de autorização antes.",
    blocker: "Só a recepção consegue consultar a carteirinha no portal do convênio.",
    aberto: ha(88),
    eventos: [{ em: ha(88), kind: "opened", ator: "system" }],
  },
  {
    n: 4, conversa: 6, kind: "agendamento", status: "resolved",
    title: "Trocar sessão",
    summary: "Lucas pediu para passar a sessão de fisioterapia de quarta para sexta à noite.",
    blocker: "A IA não pode mexer na agenda do fisioterapeuta sem a equipe confirmar o horário.",
    aberto: ha(200), fechado: ha(190),
    eventos: [
      { em: ha(200), kind: "opened", ator: "agent" },
      { em: ha(190), kind: "human_replied", ator: "human", humano: "helena", acao: "resolved", texto: "Remarquei para sexta às 18h com o Dr. Rafael." },
      { em: depois(ha(190)), kind: "resolved", ator: "human", humano: "helena" },
    ],
  },
  {
    n: 5, conversa: 5, kind: "problema", status: "escalated",
    title: "Curativo",
    summary: "Fernanda perguntou se pode tirar o curativo antes do retorno com o Dr. Paulo.",
    blocker: "É uma orientação de saúde: a IA não pode responder sobre cuidados depois da cirurgia.",
    aberto: ontemAs(16, 12), fechado: ontemAs(16, 40),
    eventos: [
      { em: ontemAs(16, 12), kind: "opened", ator: "agent" },
      { em: ontemAs(16, 40), kind: "human_replied", ator: "human", humano: "helena", acao: "escalate", texto: "Assunto de saúde: vou ligar para ela e falar com o Dr. Paulo." },
      { em: depois(ontemAs(16, 40)), kind: "escalated", ator: "human", humano: "helena" },
    ],
  },
  {
    n: 6, conversa: 2, kind: "outro", status: "cancelled",
    title: "Recibo do plano",
    summary: "Roberto pediu o recibo da última sessão de fisioterapia para pedir reembolso ao plano de saúde.",
    blocker: "A IA não tem acesso aos recibos emitidos pela clínica.",
    aberto: ha(2 * 24 * 60 + 30), fechado: ha(2 * 24 * 60 + 5),
    eventos: [
      { em: ha(2 * 24 * 60 + 30), kind: "opened", ator: "agent" },
      { em: ha(2 * 24 * 60 + 5), kind: "agent_noted", ator: "agent", texto: "O paciente disse que já achou o recibo no e-mail. Não precisa mais da equipe." },
      { em: depois(ha(2 * 24 * 60 + 5)), kind: "cancelled", ator: "agent" },
    ],
  },
];

export async function semear(c: Contexto) {
  const ids = CASOS.map((x) => casoId(x.n));
  semErro(await c.db.from("agent_cases").delete().eq("organization_id", c.org).in("id", ids), "limpar casos");

  for (const caso of CASOS) {
    const id = casoId(caso.n);
    exigir(
      await c.db.from("agent_cases").insert({
        id, organization_id: c.org, conversation_id: conversaId(caso.conversa), agent_id: c.agenteId,
        status: caso.status, kind: caso.kind, source: caso.source ?? "agent",
        title: caso.title, summary: caso.summary, blocker: caso.blocker,
        opened_at: caso.aberto, created_at: caso.aberto, updated_at: caso.fechado ?? caso.aberto,
        closed_at: caso.fechado ?? null,
      }).select("id").single(),
      `caso ${caso.title}`,
    );
    semErro(await c.db.from("agent_case_events").insert(caso.eventos.map((e) => ({
      organization_id: c.org, case_id: id, kind: e.kind, actor_kind: e.ator,
      actor_user_id: e.humano ? c.pessoa[e.humano] : null,
      human_action: e.acao ?? null, body: e.texto ?? null, created_at: e.em,
    }))), `eventos de ${caso.title}`);
  }
}
