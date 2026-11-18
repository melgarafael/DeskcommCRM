/**
 * Semente do módulo "Propostas" da IA (Agente de IA › Ver tudo em IA ›
 * Propostas, /app/ai/proposals): os próximos passos que a Bia sugeriu para três
 * negócios abertos da clínica, esperando decisão, e duas decisões já tomadas
 * (uma aprovada, uma ignorada) para a aba "Já decididas".
 *
 * Grava onde o motor grava: a proposta é `lead_state.next_action` do CONTATO
 * (com o `next_action_seq` que a decisão confere), e a tela a pendura no
 * negócio aberto do contato pela mesma regra do board. As decisões passadas são
 * `crm_lead_activities` `next_action_approved`/`next_action_dismissed`, como
 * `POST /api/v1/leads/{id}/next-action` emite.
 *
 * Usa os dois negócios da base (Mariana e Fernanda, achados pelo título — a base
 * os recria com id novo a cada rodada) e cria um terceiro, da Juliana.
 *
 * Sem `limpar`: tudo aqui vive em linhas que a base apaga antes de toda aula
 * (`lead_state` cai com os contatos, as atividades com os negócios). As lições
 * que aprovam uma proposta pela tela também são desfeitas assim.
 */
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, contatoId, exigir, ha, semErro } from "../semear-demonstracao";

const negocioId = (n: number) => `f1d00004-0000-4000-8000-${String(n).padStart(12, "0")}`;
const atividadeId = (n: number) => `f1d00005-0000-4000-8000-${String(n).padStart(12, "0")}`;

const LEAD_MARIANA = "Primeira consulta nutricional — Mariana";
const LEAD_FERNANDA = "Retorno pós-cirúrgico — Fernanda Oliveira";
const LEAD_JULIANA = "Fisioterapia pelo convênio — Juliana Castro";

/** [contato da base, próxima ação sugerida pela Bia, há quantos minutos, seq]. */
const PROPOSTAS = [
  [5, "Confirmar com a Fernanda o retorno de quinta às 9h30 com o Dr. Paulo", 120, 2],
  [3, "Pedir à Juliana a foto da carteirinha da Unimed para conferir a cobertura", 80, 1],
  [1, "Ligar para a Mariana e explicar como funciona o plano alimentar antes de marcar", 35, 1],
] as const;

export async function semear(c: Contexto) {
  const { db, org, pessoa, funil } = c;

  semErro(await db.from("crm_leads").delete().eq("organization_id", org).eq("id", negocioId(1)), "limpar negócio da Juliana");
  semErro(await db.from("crm_leads").insert({
    id: negocioId(1), organization_id: org, pipeline_id: funil.id, stage_id: funil.etapas[0]!,
    title: demo(LEAD_JULIANA), contact_id: contatoId(3), value_cents: 120_000, currency: "BRL", status: "open",
  }), "negócio da Juliana");

  const daBase = exigir(
    await db.from("crm_leads").select("id, title").eq("organization_id", org).in("title", [demo(LEAD_MARIANA), demo(LEAD_FERNANDA)]),
    "negócios da base",
  ) as Array<{ id: string; title: string }>;
  const leadDe = (titulo: string) => {
    const l = daBase.find((x) => x.title === demo(titulo));
    if (!l) throw new Error(`negócio da base sumiu: ${titulo}`);
    return l.id;
  };

  // ---------- as propostas pendentes (uma por contato: lead_state é unique por contato) ----------
  semErro(
    await db.from("lead_state").delete().eq("organization_id", org).in("contact_id", PROPOSTAS.map(([n]) => contatoId(n))),
    "limpar estado do agente",
  );
  semErro(await db.from("lead_state").insert(PROPOSTAS.map(([n, texto, min, seq]) => ({
    organization_id: org, contact_id: contatoId(n), stage: "qualifying",
    next_action: demo(texto), next_action_seq: seq, updated_at: ha(min),
  }))), "propostas da Bia");

  // ---------- duas decisões passadas ----------
  const DECISOES = [
    { n: 1, lead: leadDe(LEAD_FERNANDA), contato: 5, tipo: "next_action_approved", quem: pessoa.helena, min: 26 * 60, texto: "Marcar o retorno da Fernanda com o Dr. Paulo para esta semana" },
    { n: 2, lead: negocioId(1), contato: 3, tipo: "next_action_dismissed", quem: pessoa.ana, min: 2 * 24 * 60, texto: "Oferecer à Juliana o pacote de 10 sessões de fisioterapia" },
  ];
  semErro(await db.from("crm_lead_activities").delete().eq("organization_id", org).in("id", DECISOES.map((d) => atividadeId(d.n))), "limpar decisões");
  semErro(await db.from("crm_lead_activities").insert(DECISOES.map((d) => {
    const texto = demo(d.texto);
    const aprovou = d.tipo === "next_action_approved";
    return {
      id: atividadeId(d.n), organization_id: org, lead_id: d.lead, contact_id: contatoId(d.contato),
      type: d.tipo, source_module: "crm", source_id: d.lead, actor_kind: "user", performed_by_user_id: d.quem,
      reason: `${aprovou ? "Aprovou" : "Descartou"}: ${texto}`,
      payload: { next_action: texto, decision: aprovou ? "approve" : "dismiss" },
      performed_at: ha(d.min), created_at: ha(d.min),
    };
  })), "decisões passadas");
}
