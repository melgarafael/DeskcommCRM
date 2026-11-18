/**
 * Semente do módulo "Aviso no WhatsApp" (Agente de IA › Ver tudo em IA › Aviso
 * no WhatsApp, /app/ai/cases/avisos): o aviso de caso já configurado — saindo
 * pela "Recepção Bem Viver" para o celular do plantão da recepção — e os
 * últimos avisos que ele mandou, um de cada situação que a lista sabe mostrar
 * (entregue, não saiu, tentando enviar).
 *
 * Toda entrega aponta para um caso (`entregas_de_aviso_de_caso.case_id` é FK),
 * então a semente abre quatro casos da Bia nas conversas da base. Eles nascem
 * já no status final e com `opened_at` antigo; a base apaga as conversas antes
 * de toda aula, e os casos e as entregas vão junto, em cascata.
 *
 * O número que recebe é fictício e não é de nenhum contato: a configuração
 * transforma esse número em "interno" (o que ele manda deixa de virar
 * atendimento), e um contato da base aqui mudaria a Inbox.
 *
 * `limpar` é exportado porque a configuração é UMA linha por organização e
 * outras aulas dependem do estado de fábrica (sem linha): "Aviso de
 * agendamento" mostra a chave "Usar o mesmo número do aviso de caso" travada, e
 * a ação "Mensagem para a equipe" das automações lê este número.
 *
 * Idempotente: upsert da configuração e ids fixos para casos e entregas.
 */
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, conversaId, ha, semErro } from "../semear-demonstracao";

const casoId = (n: number) => `f1d00002-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entregaId = (n: number) => `f1d00003-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PLANTAO = "+5511976543210";

type Caso = {
  n: number;
  conversa: number;
  status: "awaiting_human" | "resolved";
  kind: string;
  title: string;
  summary: string;
  blocker: string;
  aberto: string;
  fechado?: string;
  entrega: { status: "enviado" | "falhou" | "pendente"; erro?: string; tentativas: number; em: string };
};

const CASOS: Caso[] = [
  {
    n: 1, conversa: 5, status: "awaiting_human", kind: "agendamento", aberto: ha(3),
    title: "Retorno com o Dr. Paulo",
    summary: "Fernanda quer saber se pode levar o laudo da cirurgia em foto pelo celular, em vez de impresso.",
    blocker: "A IA não sabe o que o Dr. Paulo aceita no retorno.",
    entrega: { status: "pendente", tentativas: 1, em: ha(2) },
  },
  {
    n: 2, conversa: 4, status: "awaiting_human", kind: "financeiro", aberto: ha(40),
    title: "Desconto no Pix",
    summary: "Pedro quer saber se a consulta particular com a nutricionista tem desconto no pagamento por Pix.",
    blocker: "As instruções não falam de desconto no Pix, e a IA não pode prometer preço diferente.",
    entrega: { status: "enviado", tentativas: 1, em: ha(39) },
  },
  {
    n: 3, conversa: 3, status: "awaiting_human", kind: "duvida", aberto: ha(26 * 60),
    title: "Convênio Unimed",
    summary: "Juliana quer saber se o plano Unimed dela cobre 10 sessões de fisioterapia.",
    blocker: "Só a recepção consegue consultar a carteirinha no portal do convênio.",
    entrega: { status: "falhou", erro: "canal_desconectado", tentativas: 3, em: ha(26 * 60) },
  },
  {
    n: 4, conversa: 6, status: "resolved", kind: "agendamento", aberto: ha(2 * 24 * 60 + 300), fechado: ha(2 * 24 * 60 + 240),
    title: "Trocar sessão",
    summary: "Lucas pediu para passar a sessão de fisioterapia de quarta para sexta à noite.",
    blocker: "A IA não pode mexer na agenda do fisioterapeuta sem a equipe confirmar.",
    entrega: { status: "enviado", tentativas: 1, em: ha(2 * 24 * 60 + 299) },
  },
];

/** Limpeza chamada antes de QUALQUER aula: devolve o aviso de caso ao estado de fábrica (sem linha). */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  semErro(await db.from("config_aviso_de_caso").delete().eq("organization_id", org), "aviso de caso de fábrica");
  // as entregas saem em cascata com os casos
  semErro(await db.from("agent_cases").delete().eq("organization_id", org).in("id", CASOS.map((x) => casoId(x.n))), "limpar casos do aviso");
}

export async function semear(c: Contexto) {
  const { db, org, sessao, agenteId, pessoa } = c;
  await limpar(c);

  // service role: a RPC da tela (fn_definir_aviso_de_caso) exige auth.uid()
  semErro(await db.from("config_aviso_de_caso").insert({
    organization_id: org, channel_session_id: sessao, telefone_destino: PLANTAO,
    rotulo: demo("Plantão da recepção"), ligado: true, resposta_whatsapp_habilitada: false,
    criado_por: pessoa.helena, atualizado_por: pessoa.helena,
    created_at: ha(5 * 24 * 60), updated_at: ha(5 * 24 * 60),
  }), "config do aviso de caso");

  semErro(await db.from("agent_cases").insert(CASOS.map((x) => ({
    id: casoId(x.n), organization_id: org, conversation_id: conversaId(x.conversa), agent_id: agenteId,
    status: x.status, kind: x.kind, source: "agent", title: x.title, summary: x.summary, blocker: x.blocker,
    opened_at: x.aberto, created_at: x.aberto, updated_at: x.fechado ?? x.aberto, closed_at: x.fechado ?? null,
  }))), "casos do aviso");

  semErro(await db.from("entregas_de_aviso_de_caso").insert(CASOS.map((x) => ({
    id: entregaId(x.n), organization_id: org, case_id: casoId(x.n), destino: PLANTAO, channel_session_id: sessao,
    status: x.entrega.status, tentativas: x.entrega.tentativas, erro_codigo: x.entrega.erro ?? null,
    enviado_em: x.entrega.status === "enviado" ? x.entrega.em : null, created_at: x.entrega.em,
  }))), "entregas do aviso de caso");
}
