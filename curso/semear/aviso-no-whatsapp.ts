/**
 * Semente do módulo "Aviso no WhatsApp" (/app/ai/cases/avisos): o aviso de caso
 * já configurado — saindo pela "Recepção Bem Viver" para o celular da Helena,
 * ligado — e os últimos cinco avisos, um de cada desfecho que a lista sabe
 * mostrar ("Entregue", "Não saiu" com o motivo, "Cancelado").
 *
 * Grava como o motor grava: a configuração numa linha por organização
 * (`config_aviso_de_caso`, gravada pelo service role, porque o RPC da tela exige
 * `auth.uid()`), e cada entrega em `entregas_de_aviso_de_caso` apontando para um
 * caso em `agent_cases`. Os casos daqui nascem JÁ ENCERRADOS: o gatilho de
 * abertura só emite evento para caso aberto, e o contador "Casos" do menu só
 * conta caso esperando alguém — nada disto muda a foto de outro módulo.
 *
 * O contador de mensagens ignoradas também é semeado: é ele que faz a tela
 * mostrar o quadro "As respostas para este número são ignoradas de propósito".
 *
 * Idempotente: `limpar()` apaga a configuração da organização e os casos pelos
 * ids fixos desta semente (entregas e eventos vão junto, em cascata), e tudo é
 * recriado. A base apaga as conversas, o que também leva estes casos junto.
 */
import { type Contexto, conversaId, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const casoId = (n: number) => `d1200100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entregaId = (n: number) => `d1200200-0000-4000-8000-${String(n).padStart(12, "0")}`;
const eventoId = (n: number) => `d1200300-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Celular fictício da Helena: não é de nenhum contato nem de nenhuma conexão da base. */
const CELULAR_DA_HELENA = "+5511994417208";
const IDS_DOS_CASOS = [1, 2, 3, 4, 5].map(casoId);

/** Instante de "N dias atrás às h:m" em São Paulo (UTC-3, sem horário de verão). */
function diasAtras(n: number, h: number, m: number) {
  const sp = new Date(Date.now() - 3 * 3_600_000);
  return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() - n, h + 3, m)).toISOString();
}
const mais = (iso: string, segundos: number) => new Date(Date.parse(iso) + segundos * 1000).toISOString();

type Caso = {
  n: number;
  conversa: number;
  kind: string;
  status: "resolved" | "cancelled" | "escalated";
  title: string;
  summary: string;
  blocker: string;
  aberto: string;
  fechado: string;
  entrega: { status: "enviado" | "falhou" | "cancelado"; erro?: string; tentativas: number };
};

const CASOS: Caso[] = [
  {
    n: 1, conversa: 8, kind: "financeiro", status: "resolved",
    title: "Parcelar o pacote",
    summary: "Beatriz quer pagar o pacote de 10 aulas de pilates em 3 vezes no cartão.",
    blocker: "As instruções não dizem em quantas vezes o pacote pode ser parcelado.",
    aberto: ha(95), fechado: ha(40),
    entrega: { status: "falhou", erro: "sem_endereco_publico", tentativas: 1 },
  },
  {
    n: 2, conversa: 9, kind: "agendamento", status: "resolved",
    title: "Encaixe no mesmo dia",
    summary: "Antônio quer um encaixe hoje à tarde com a nutricionista.",
    blocker: "A IA não pode abrir horário fora da agenda liberada.",
    aberto: diasAtras(1, 16, 40), fechado: diasAtras(1, 16, 52),
    entrega: { status: "enviado", tentativas: 1 },
  },
  {
    n: 3, conversa: 6, kind: "duvida", status: "escalated",
    title: "Atestado para a academia",
    summary: "Lucas pediu um atestado para voltar a treinar na academia.",
    blocker: "Só o fisioterapeuta pode dar um atestado.",
    aberto: diasAtras(2, 10, 15), fechado: diasAtras(2, 15, 5),
    entrega: { status: "falhou", erro: "canal_desconectado", tentativas: 3 },
  },
  {
    n: 4, conversa: 1, kind: "agendamento", status: "cancelled",
    title: "Remarcar o retorno",
    summary: "Mariana quer passar o retorno com a nutricionista para a semana que vem.",
    blocker: "A agenda da próxima semana ainda não foi aberta para a IA marcar.",
    aberto: diasAtras(4, 19, 30), fechado: diasAtras(3, 20, 10),
    entrega: { status: "cancelado", erro: "expirou", tentativas: 3 },
  },
  {
    n: 5, conversa: 7, kind: "duvida", status: "resolved",
    title: "Pedido médico",
    summary: "Camila quer saber se precisa de pedido médico para começar a fisioterapia.",
    blocker: "As instruções não falam de pedido médico para a fisioterapia.",
    aberto: diasAtras(5, 9, 5), fechado: diasAtras(5, 9, 30),
    entrega: { status: "enviado", tentativas: 1 },
  },
];

/**
 * Antes de qualquer aula: tira o aviso de caso e os casos daqui (estado de fábrica).
 * Casos pelos ids fixos — entregas e eventos caem em cascata. A configuração é
 * UMA linha por organização (a chave é `organization_id`), e é a mesma que as
 * aulas gravam e removem pela tela, com rótulo em PT ou em ES: apagá-la pela
 * organização cobre as duas línguas. O rastro que o salvar deixa em
 * `api_audit_log` fica: a tabela é append-only, nem o service role apaga.
 */
export async function limpar(c: Contexto) {
  semErro(await c.db.from("agent_cases").delete().eq("organization_id", c.org).in("id", IDS_DOS_CASOS), "limpar casos do aviso");
  semErro(await c.db.from("config_aviso_de_caso").delete().eq("organization_id", c.org), "aviso de caso de fábrica");
}

export async function semear(c: Contexto) {
  const { db, org, sessao, pessoa, agenteId } = c;
  await limpar(c);

  // service role: o RPC da tela (fn_definir_aviso_de_caso) exige auth.uid()
  semErro(await db.from("config_aviso_de_caso").insert({
    organization_id: org, channel_session_id: sessao, telefone_destino: CELULAR_DA_HELENA,
    rotulo: demo("Celular da Helena"), ligado: true, resposta_whatsapp_habilitada: false,
    mensagens_ignoradas: 4, ultima_mensagem_ignorada_em: diasAtras(1, 16, 58),
    criado_por: pessoa.helena, atualizado_por: pessoa.helena,
    created_at: diasAtras(9, 11, 20), updated_at: diasAtras(9, 11, 20),
  }), "config do aviso de caso");

  for (const caso of CASOS) {
    const id = casoId(caso.n);
    semErro(await db.from("agent_cases").insert({
      id, organization_id: org, conversation_id: conversaId(caso.conversa), agent_id: agenteId,
      status: caso.status, kind: caso.kind, source: "agent",
      title: demo(caso.title), summary: demo(caso.summary), blocker: demo(caso.blocker),
      opened_at: caso.aberto, created_at: caso.aberto, updated_at: caso.fechado, closed_at: caso.fechado,
    }), `caso ${caso.title}`);
    semErro(await db.from("agent_case_events").insert([
      { id: eventoId(caso.n * 10 + 1), organization_id: org, case_id: id, kind: "opened", actor_kind: "agent", created_at: caso.aberto },
      {
        id: eventoId(caso.n * 10 + 2), organization_id: org, case_id: id,
        kind: caso.status, actor_kind: caso.status === "cancelled" ? "agent" : "human",
        actor_user_id: caso.status === "cancelled" ? null : pessoa.helena, created_at: caso.fechado,
      },
    ]), `eventos de ${caso.title}`);
    const tentouEm = mais(caso.aberto, 20);
    semErro(await db.from("entregas_de_aviso_de_caso").insert({
      id: entregaId(caso.n), organization_id: org, case_id: id,
      destino: CELULAR_DA_HELENA, channel_session_id: sessao,
      status: caso.entrega.status, tentativas: caso.entrega.tentativas, erro_codigo: caso.entrega.erro ?? null,
      enviado_em: caso.entrega.status === "enviado" ? tentouEm : null,
      created_at: tentouEm, updated_at: tentouEm,
    }), `entrega de ${caso.title}`);
  }
}
