/**
 * Semente do módulo Tarefas: as tarefas da Clínica Bem Viver, uma em cada faixa
 * de prazo que a lista mostra (Atrasadas, Hoje, Esta semana, Mais tarde, Sem
 * prazo) mais uma concluída, uma cancelada e uma em andamento — os filtros de
 * situação.
 *
 * Prazos relativos ao dia em que roda, no fuso de São Paulo (o do capturador):
 * a faixa de cada tarefa não muda com a data da captura.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos + os títulos que as lições
 * criam pela tela) e recria. Os negócios da base são achados pelo título, porque
 * a base os recria com id novo a cada rodada.
 */
import { type Contexto, contatoId, exigir, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const tarefaId = (n: number) => `7a5c0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Títulos que as lições criam pela tela: limpos aqui para cada lição partir do mesmo estado. */
const CRIADAS_NAS_LICOES = [
  "Ligar para a Camila e confirmar a avaliação postural",
  "Mandar lembrete de jejum para os exames de sábado",
  "Lembrar os pacientes do jejum para o exame de sangue",
];

const LEAD_MARIANA = "Primeira consulta nutricional — Mariana";
const LEAD_FERNANDA = "Retorno pós-cirúrgico — Fernanda Oliveira";

/** Dia de hoje + `dias`, às HH:MM de São Paulo (UTC-3, sem horário de verão). */
function diaAs(dias: number, h: number, m = 0) {
  const sp = new Date(Date.now() - 3 * 3_600_000);
  return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() + dias, h + 3, m)).toISOString();
}

/** Ainda hoje, e no futuro: fim da tarde, ou daqui a uma hora se já passou das 16h (teto 23:59). */
function aindaHoje() {
  const sp = new Date(Date.now() - 3 * 3_600_000);
  const minutos = Math.max(17 * 60, Math.ceil((sp.getUTCHours() * 60 + sp.getUTCMinutes() + 60) / 30) * 30);
  const teto = Math.min(minutos, 23 * 60 + 59);
  return diaAs(0, Math.floor(teto / 60), teto % 60);
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;

  const leads = exigir(
    await db.from("crm_leads").select("id, title").eq("organization_id", org).in("title", [demo(LEAD_MARIANA), demo(LEAD_FERNANDA)]),
    "negócios da base",
  ) as Array<{ id: string; title: string }>;
  const lead = (titulo: string) => {
    const l = leads.find((x) => x.title === demo(titulo));
    if (!l) throw new Error(`negócio da base sumiu: ${titulo}`);
    return l.id;
  };

  const TAREFAS = [
    {
      n: 1, title: "Ligar para o Roberto e remarcar a fisioterapia",
      description: "Ele pediu para trocar a sessão de amanhã por causa do trabalho. Oferecer quarta ou sexta de manhã.",
      due_date: diaAs(-1, 10), priority: "high", status: "pending", assigned_to: pessoa.helena, contact_id: contatoId(2),
    },
    {
      n: 2, title: "Enviar o plano alimentar revisado da Mariana",
      description: "A nutricionista ajustou o café da manhã. Mandar o PDF e marcar o retorno.",
      due_date: diaAs(-2, 18), priority: "urgent", status: "pending", assigned_to: pessoa.ana, contact_id: contatoId(1), lead_id: lead(LEAD_MARIANA),
    },
    {
      n: 3, title: "Confirmar o retorno da Fernanda com o Dr. Paulo",
      description: "Retorno pós-cirúrgico de quinta às 9h30. Ver se precisa trocar o curativo.",
      due_date: aindaHoje(), priority: "high", status: "pending", assigned_to: pessoa.helena, contact_id: contatoId(5), lead_id: lead(LEAD_FERNANDA),
    },
    {
      n: 4, title: "Conferir as guias do convênio Unimed da Juliana",
      description: null,
      due_date: diaAs(2, 14), priority: "medium", status: "pending", assigned_to: pessoa.carlos, contact_id: contatoId(3),
    },
    {
      n: 5, title: "Repor luvas e máscaras do consultório odontológico",
      description: "Pedir ao fornecedor de sempre: 10 caixas de luvas M e 5 de máscaras.",
      due_date: diaAs(4, 9), priority: "low", status: "pending", assigned_to: pessoa.ana,
    },
    {
      n: 6, title: "Montar a escala de férias da recepção",
      description: null,
      due_date: diaAs(5, 12), priority: "medium", status: "in_progress", assigned_to: pessoa.helena,
    },
    {
      n: 7, title: "Revisar a tabela de preços das consultas particulares",
      description: "Comparar com as clínicas do bairro antes do reajuste de janeiro.",
      due_date: diaAs(12, 10), priority: "medium", status: "pending", assigned_to: pessoa.carlos,
    },
    {
      n: 8, title: "Atualizar as fotos da clínica no perfil do WhatsApp",
      description: null,
      due_date: null, priority: "low", status: "pending", assigned_to: null,
    },
    {
      n: 9, title: "Enviar o endereço da clínica para a Fernanda",
      description: null,
      due_date: diaAs(-1, 15), priority: "medium", status: "done", assigned_to: pessoa.helena, contact_id: contatoId(5),
    },
    {
      n: 10, title: "Ligar para o Antônio sobre o pacote de pilates",
      description: "Ele disse que ia conversar com a esposa. Ele mesmo vai retornar.",
      due_date: diaAs(-3, 11), priority: "low", status: "cancelled", assigned_to: pessoa.ana, contact_id: contatoId(9),
    },
  ];

  semErro(await db.from("crm_tasks").delete().eq("organization_id", org).in("id", TAREFAS.map((t) => tarefaId(t.n))), "limpar tarefas");
  semErro(await db.from("crm_tasks").delete().eq("organization_id", org).in("title", CRIADAS_NAS_LICOES), "limpar tarefas das lições");

  const linhas = TAREFAS.map(({ n, ...t }, i) => ({
    lead_id: null as string | null, contact_id: null as string | null, ...t,
    id: tarefaId(n), organization_id: org, created_by: pessoa.helena,
    // ordem estável entre tarefas do mesmo prazo
    created_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
  }));
  semErro(await db.from("crm_tasks").insert(linhas), "tarefas");

  // A linha "Tarefa combinada" na linha do tempo do negócio, como o POST /api/v1/tasks
  // grava (lib/tarefas/atividade.ts → buildLeadActivityRow): sem ela, a ficha diria
  // "Nada aconteceu com este negócio ainda" ao lado de uma tarefa do negócio.
  const ids = linhas.map((t) => t.id);
  semErro(
    await db.from("crm_lead_activities").delete().eq("organization_id", org).eq("source_module", "tarefas").in("source_id", ids),
    "limpar linha do tempo das tarefas",
  );
  semErro(
    await db.from("crm_lead_activities").insert(
      linhas.filter((t) => t.lead_id).map((t) => ({
        organization_id: org, lead_id: t.lead_id, contact_id: t.contact_id,
        type: "task_created", source_module: "tarefas", source_id: t.id,
        actor_kind: "user", actor_agent_id: null, performed_by_user_id: pessoa.helena,
        reason: t.title.slice(0, 200), evidence: null,
        payload: { due_date: t.due_date, priority: t.priority },
        performed_at: t.created_at, created_at: t.created_at,
      })),
    ),
    "linha do tempo das tarefas",
  );
}
