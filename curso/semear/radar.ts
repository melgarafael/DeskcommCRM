/**
 * Semente do módulo Radar: cinco negócios abertos que esfriaram, um em cada
 * situação que a tela distingue — crítico sem dono, crítico com atendente, em
 * risco com o assistente na conversa, em voo (retorno agendado, dono agente) e
 * um sem conversa nenhuma (o clique leva ao funil). Sem propostas: a
 * capacidade "Propostas" vem desligada numa instalação fresca.
 *
 * Roda depois da base, que já apaga contatos/conversas/negócios da organização;
 * mesmo assim apaga antes as próprias linhas pelos ids fixos (idempotente).
 * Datas relativas ao seed: o radar mede horas de silêncio, não datas.
 */
import { type Contexto, ha, semErro } from "../semear-demonstracao";

const id = (prefixo: string, n: number) => `${prefixo}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const contato = (n: number) => id("be3a0000", n);
const conversa = (n: number) => id("be3b0000", n);
const negocio = (n: number) => id("be3c0000", n);
const RETORNO = id("be3e0000", 1);
const H = 60; // minutos numa hora

type Quem = "cliente" | "ia" | "ana";
type Item = {
  n: number;
  nome: string;
  telefone: string;
  titulo: string;
  reais: number;
  /** horas desde a última atividade do negócio */
  frio: number;
  mensagens?: Array<[horas: number, quem: Quem, texto: string]>;
  conversa?: "livre" | "ana" | "ia";
  donoAgente?: boolean;
};

const ITENS: Item[] = [
  {
    n: 1, nome: "Sandra Vieira", telefone: "+5511987651001", titulo: "Alinhador invisível — Sandra Vieira", reais: 4800, frio: 5 * 24,
    mensagens: [
      [5 * 24 + 1, "cliente", "Oi! Queria saber o valor do aparelho invisível."],
      [5 * 24, "ia", "Oi, Sandra! Enviei o orçamento do alinhador para você. Ele vale até o fim da semana que vem."],
    ],
    conversa: "livre",
  },
  {
    n: 2, nome: "Paulo Teixeira", telefone: "+5511987651002", titulo: "Pacote de 10 sessões de fisioterapia — Paulo", reais: 1500, frio: 4 * 24,
    mensagens: [
      [4 * 24 + 1, "cliente", "Vocês fazem pacote de fisioterapia para dor lombar?"],
      [4 * 24, "ana", "Fazemos sim, Paulo! O pacote de 10 sessões sai por R$ 1.500,00. Quer agendar a avaliação?"],
    ],
    conversa: "ana",
  },
  {
    n: 3, nome: "Renata Duarte", telefone: "+5511987651003", titulo: "Avaliação nutricional — Renata Duarte", reais: 280, frio: 30,
    mensagens: [
      [31, "cliente", "A nutricionista faz acompanhamento para gestante?"],
      [30, "ia", "Faz sim, Renata! A Dra. Lívia acompanha gestantes. Quer ver um horário?"],
    ],
    conversa: "ia",
  },
  {
    n: 4, nome: "Gustavo Ramos", telefone: "+5511987651004", titulo: "Clareamento dental — Gustavo Ramos", reais: 900, frio: 50,
    mensagens: [
      [51, "cliente", "Quanto custa o clareamento? Vou ver com calma e te falo."],
      [50, "ia", "Claro, Gustavo! O clareamento sai por R$ 900,00. Fico à disposição."],
    ],
    conversa: "livre", donoAgente: true,
  },
  // sem conversa: veio por indicação e ainda não falou pelo WhatsApp
  { n: 5, nome: "Marcos Azevedo", telefone: "+5511987651005", titulo: "Avaliação postural — Marcos Azevedo", reais: 250, frio: 40 },
];

export async function semear(c: Contexto) {
  const { db, org } = c;
  const ns = ITENS.map((i) => i.n);
  // filhos antes dos pais; a base já apagou tudo, isto é a guarda da reexecução
  semErro(await db.from("cron_jobs").delete().eq("organization_id", org).eq("id", RETORNO), "limpar retorno");
  semErro(await db.from("crm_leads").delete().eq("organization_id", org).in("id", ns.map(negocio)), "limpar negócios");
  semErro(await db.from("conversations").delete().eq("organization_id", org).in("id", ns.map(conversa)), "limpar conversas");
  semErro(await db.from("contacts").delete().eq("organization_id", org).in("id", ns.map(contato)), "limpar contatos");

  for (const i of ITENS) {
    semErro(await db.from("contacts").insert({ id: contato(i.n), organization_id: org, name: i.nome, phone_number: i.telefone }), `contato ${i.nome}`);
    if (i.mensagens) {
      semErro(await db.from("conversations").insert({
        id: conversa(i.n), organization_id: org, contact_id: contato(i.n), channel_session_id: c.sessao, status: "open",
      }), `conversa ${i.nome}`);
      for (const [horas, quem, texto] of i.mensagens) {
        const em = ha(horas * H);
        const recebida = quem === "cliente";
        semErro(await db.from("messages").insert({
          organization_id: org, conversation_id: conversa(i.n), channel_session_id: c.sessao, contact_id: contato(i.n),
          type: "text", body: texto, direction: recebida ? "inbound" : "outbound", status: recebida ? "received" : "read",
          sent_via: recebida ? "external_device" : quem === "ana" ? "user" : "ai",
          sent_by_user_id: quem === "ana" ? c.pessoa.ana : null, sent_at: em, created_at: em,
          ...(quem === "ia" ? { metadata: { ai_generated: true } } : {}),
        }), `mensagem de ${i.nome}`);
        semErro(await db.rpc("fn_mark_conversation_message", {
          p_conv: conversa(i.n), p_direction: recebida ? "inbound" : "outbound", p_preview: texto, p_at: em,
        }), `carimbo de ${i.nome}`);
      }
      if (i.conversa === "ana") {
        semErro(await db.rpc("fn_conversation_assign", {
          p_organization_id: org, p_conversation_id: conversa(i.n), p_to_user_id: c.pessoa.ana, p_reason: "claim",
        }), `atribuir ${i.nome}`);
      }
      if (i.conversa === "ia") {
        semErro(await db.from("conversations").update({ status: "ai_handling", assignee_kind: "ai" }).eq("id", conversa(i.n)), `IA em ${i.nome}`);
      }
      semErro(await db.from("conversations").update({ unread_count_for_assignee: 0 }).eq("id", conversa(i.n)), `lidas de ${i.nome}`);
    }
    const ultima = ha(i.frio * H);
    semErro(await db.from("crm_leads").insert({
      id: negocio(i.n), organization_id: org, pipeline_id: c.funil.id, stage_id: c.funil.etapas[0], title: i.titulo,
      contact_id: contato(i.n), value_cents: i.reais * 100, currency: "BRL", status: "open",
      created_at: ultima, last_activity_at: ultima,
      ...(i.donoAgente ? { owner_kind: "ai", owner_agent_id: c.agenteId } : {}),
    }), `negócio ${i.titulo}`);
    // o relógio só anda para frente nos gatilhos; aqui ele é posto no passado de propósito
    semErro(await db.from("crm_leads").update({ last_activity_at: ultima }).eq("id", negocio(i.n)), `relógio de ${i.titulo}`);
  }

  // em voo: o assistente prometeu voltar a falar com o Gustavo daqui a 2 dias
  semErro(await db.from("cron_jobs").insert({
    id: RETORNO, organization_id: org, contact_id: contato(4), kind: "at", job_kind: "followup_turn",
    next_run_at: ha(-50 * H), enabled: true,
  }), "retorno do Gustavo");
}
