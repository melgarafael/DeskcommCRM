/**
 * O DECIDIDOR da `ai_decide` (#1970) — função PURA, no mesmo desenho de
 * `lib/routing/decide.ts` (a decisão de roteamento do repo): sem DB, sem
 * relógio e sem chamada de modelo. Quem fala com o modelo é o chamador
 * (`lib/agent-engine/agent/decisao-de-acao.ts`); aqui mora o que precisa ser
 * testável sem nada em volta:
 *
 *  1. `montarMensagemDaDecisao` — o que a IA LÊ: a instrução de quem montou a
 *     regra, o conjunto FINITO de opções e o contexto do evento.
 *  2. `interpretarDecisao` — o que a IA RESPONDEU vira escolha, ou não vira
 *     nada. Saída de modelo não é confiável: resposta vazia, prosa sem JSON,
 *     JSON sem `escolha` e `escolha` fora do conjunto são QUATRO recusas
 *     diferentes, cada uma com o seu motivo — e todas significam a MESMA coisa
 *     para o motor: não executa nada (#1970, critério "resposta inválida não
 *     executa nada e registra o motivo").
 *
 * Nunca chuta: `interpretarDecisao` só aceita um `id` que esteja literalmente
 * nas opções recebidas. Um palpite vira ação errada na regra de outra pessoa —
 * o defeito oposto ao da IA que não fez nada, e pior, porque passa despercebido.
 */
import { extrairObjetoJsonDoTexto } from "@/lib/agent-engine/texto/extrair-json-do-texto";

/** Uma opção do `ai_decide` — o id que a IA devolve e a ação que ele dispara. */
export interface OpcaoDeDecisao {
  id: string;
  rotulo: string;
  acao: { type: string; config?: Record<string, unknown> };
}

/** Por que a resposta não virou escolha — o motivo que vai para o run. */
export type MotivoDaDecisao =
  | "resposta_vazia"
  | "sem_json"
  | "escolha_ausente"
  | "escolha_fora_do_conjunto";

export type DecisaoDeAcao =
  | { ok: true; escolha: string }
  | { ok: false; motivo: MotivoDaDecisao };

export interface EntradaDaDecisao {
  /** A instrução de quem montou a regra — o que a IA pondera ao escolher. */
  instrucao: string;
  /** O conjunto FINITO de opções (o schema garante 2 a 6, ids únicos). */
  opcoes: readonly OpcaoDeDecisao[];
  /** O contexto do evento que disparou a regra — sai projetado por `fichaDaDecisao`, nunca inteiro. */
  contexto: Record<string, unknown>;
}

/**
 * Teto do contexto no prompt: contexto de evento com anexo vira payload grande,
 * e o que não cabe em teto nenhum é truncado em vez de estourar a janela. O
 * recorte é por CARACTERE — sem ele a chamada falharia em run que funcionava.
 */
const TETO_DO_CONTEXTO = 6000;

const INSTRUCAO_FIXA =
  "Você é o decididor de uma automação de CRM (NÃO fala com o cliente e NÃO executa nada você mesmo). " +
  "Leia a instrução de quem montou a regra, o contexto do evento e as opções disponíveis, e escolha UMA opção. " +
  "Responda SOMENTE com JSON, sem explicação: {\"escolha\": \"<id de UMA opção, exatamente como está na lista>\"}. " +
  "Escolha um id que exista na lista; fora da lista a automação não executa nada.";

function formatarOpcoes(opcoes: readonly OpcaoDeDecisao[]): string {
  return opcoes.map((o) => `- id: ${o.id} — ${o.rotulo} (ação: ${o.acao.type})`).join("\n");
}

/**
 * A FICHA que vai ao provedor de LLM — lista FIXA, nunca o contexto inteiro.
 *
 * `buildContext` (lib/automation/engine.ts) hidrata `lead` e `contact` com
 * `select("*")`: serializar isso mandava para fora da instalação e-mail,
 * telefone, ids internos, `organization_id` e o CPF cifrado. É o mesmo defeito
 * que `lib/automation/dados-do-formulario.ts` (`CAMPOS_DO_CONTATO`) e a projeção
 * do `call_webhook` já corrigiram, com a mesma receita: itera os campos
 * PERMITIDOS, não os presentes — coluna nova amanhã não vaza sozinha.
 *
 * A lista é mais curta que a daqueles dois porque o uso é outro: eles escrevem
 * ao cliente ou entregam ao integrador; aqui a IA só ESCOLHE uma opção, e nome,
 * e-mail e telefone não mudam escolha nenhuma.
 *
 * ponytail: `custom_fields` vai inteiro — é o dado de negócio que a instrução
 * do operador costuma citar ("quer parcelar?"), e é o que o operador cadastrou.
 * Teto: um campo personalizado com documento dentro sai junto; o caminho é
 * filtrar pelos campos do funil quando alguém pedir.
 */
const FICHA_DA_DECISAO = {
  evento: ["body_preview", "added_tags", "event_type_name", "status", "lost_reason", "won_reason"],
  // `title` fica de fora: neste produto o título do negócio nasce do nome do
  // contato e, sem nome, do telefone (nascimento-do-lead.ts, create-or-move-lead.ts).
  lead: ["status", "value_cents", "currency", "tags", "custom_fields", "source", "won_reason", "lost_reason"],
  contact: ["tags"],
} as const;

function projetar(origem: unknown, campos: readonly string[]): Record<string, unknown> | undefined {
  if (!origem || typeof origem !== "object") return undefined;
  const linha = origem as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const campo of campos) if (linha[campo] !== undefined && linha[campo] !== null) out[campo] = linha[campo];
  return Object.keys(out).length ? out : undefined;
}

/** Exportada para o teste de vazamento olhar a ficha sem montar o prompt. */
export function fichaDaDecisao(contexto: Record<string, unknown>): Record<string, unknown> {
  const ficha: Record<string, unknown> = {};
  const evento = projetar(contexto.event, FICHA_DA_DECISAO.evento);
  const negocio = projetar(contexto.lead, FICHA_DA_DECISAO.lead);
  const contato = projetar(contexto.contact, FICHA_DA_DECISAO.contact);
  if (evento) ficha.evento = evento;
  if (negocio) ficha.negocio = negocio;
  if (contato) ficha.contato = contato;
  return ficha;
}

function formatarContexto(contexto: Record<string, unknown>): string {
  let texto: string;
  try {
    texto = JSON.stringify(contexto) ?? "";
  } catch {
    // Contexto com ciclo (payload de evento malformado) não pode derrubar a
    // regra: o que não serializa sai de fora, e a IA decide com o resto.
    texto = "";
  }
  if (texto.length > TETO_DO_CONTEXTO) {
    return `${texto.slice(0, TETO_DO_CONTEXTO)}…(contexto cortado em ${TETO_DO_CONTEXTO} caracteres)`;
  }
  return texto;
}

/** O prompt da decisão: instrução do operador, opções e contexto, nessa ordem. */
export function montarMensagemDaDecisao(entrada: EntradaDaDecisao): string {
  return [
    INSTRUCAO_FIXA,
    "",
    "## Instrução de quem montou a regra",
    entrada.instrucao.trim(),
    "",
    "## Opções (conjunto fechado — só existe isto)",
    formatarOpcoes(entrada.opcoes),
    "",
    "## Contexto do evento",
    formatarContexto(fichaDaDecisao(entrada.contexto)),
  ].join("\n");
}

/**
 * Lê a resposta do modelo. Tolerante a prosa e a cerca em volta (o JSON pode
 * vir embalado), intolerante a tudo que não seja um id das opções.
 *
 * Devolve SÓ o id — o executor é quem mapeia id → ação e executa. Separar os
 * dois é o que permite testar a recusa sem executar nada: `ok:false` já vem com
 * o motivo, e o motivo é o que vai para `automation_rule_runs`.
 */
export function interpretarDecisao(
  respostaBruta: string | null | undefined,
  opcoes: readonly OpcaoDeDecisao[],
): DecisaoDeAcao {
  const resposta = (respostaBruta ?? "").trim();
  if (!resposta) return { ok: false, motivo: "resposta_vazia" };

  const obj = extrairObjetoJsonDoTexto(resposta);
  if (obj === null) return { ok: false, motivo: "sem_json" };

  const escolha = typeof obj.escolha === "string" ? obj.escolha.trim() : null;
  if (!escolha) return { ok: false, motivo: "escolha_ausente" };

  const conhecidas = opcoes.map((o) => o.id);
  if (!conhecidas.includes(escolha)) return { ok: false, motivo: "escolha_fora_do_conjunto" };

  return { ok: true, escolha };
}
