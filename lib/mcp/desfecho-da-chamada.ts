/**
 * A RÉGUA ÚNICA DA RECUSA DE UMA CHAMADA DE FERRAMENTA (#4342 / #4343).
 *
 * ═══ O DEFEITO, MEDIDO ═══
 *
 * `crm_create_lead` recusa com `{ erro: "sem_destino", mensagem }` e não cria
 * negócio nenhum. Mesmo assim a chamada era registrada como SUCESSO nos três
 * lugares que afirmam o que aconteceu:
 *
 *   - no traço do turno (`lib/agent-engine/agent/traco-do-turno.ts`) a régua
 *     era `{ ok: false }` — a convenção de OUTRA família de ferramentas;
 *   - no `api_audit_log` do agente (`lib/ai/runtime/tools.ts`), que só
 *     reconhecia `{ permitido: false, motivo }`;
 *   - no `api_audit_log` da rota MCP externa (`lib/mcp/server.ts`), que só
 *     olhava o vazio declarado.
 *
 * E, como o gate `registro_sem_efeito` lê o predicado alimentado pela ponte
 * (`lib/ai/runtime/efeito-das-escritas.ts`), a recusa virava
 * `produziu_efeito` — o gate liberava a fala "já registrei seu interesse".
 *
 * ═══ POR QUE UM MÓDULO, E NÃO UMA CHECAGEM EM CADA LUGAR ═══
 *
 * Três réguas sobre o mesmo dado nascem diferentes e discordam em silêncio —
 * foi exatamente o que aconteceu. Aqui há UMA resposta para "esta chamada
 * recusou?" e os três caminhos leem dela. Não é um `switch` por ferramenta:
 * é o formato de retorno que o catálogo já usa, reconhecido uma vez.
 *
 * ═══ OS FORMATOS RECONHECIDOS (inventário em `tests/unit/desfecho-da-chamada.test.ts`) ═══
 *
 *   `{ permitido: false, motivo, mensagem }` — recusa de escopo do handler
 *       (as leituras escopadas ao contato do turno e as escritas de funil);
 *   `{ resultado_incerto: true, ... }`       — escrita sem desfecho confirmado;
 *   `{ erro: "<codigo>", mensagem }`         — dados externos, receitas,
 *       conhecimento e as demais tools do catálogo;
 *   `{ error: "<texto>" | { code, message } }` — o que a ponte devolve ao
 *       modelo quando a exceção é dela (papel/escopo/teto);
 *   `{ ok: false, error }`                   — a convenção das tools nativas do
 *       run (mensagem, troca de etapa, agenda).
 *
 * Sucesso é `null`. Um resultado de sucesso que carregue `erro: null` continua
 * sucesso: campo nulo não afirma recusa.
 *
 * Puro de propósito: sem I/O, sem relógio, sem banco — os três chamadores
 * testam a mesma função.
 */

/** O que a chamada disse quando recusou. */
export interface RecusaDaChamada {
  /**
   * O código legível por máquina, quando a recusa tem um (`sem_destino`,
   * `fora_da_conversa`, `resultado_incerto`). `null` quando o que veio foi
   * texto solto — aí a `mensagem` é a única informação honesta.
   */
  codigo: string | null;
  /** O texto devolvido ao modelo. Nunca vazio. */
  mensagem: string;
  /**
   * De qual formato a recusa veio. O ingresso do agente usa isto para manter o
   * rótulo histórico do audit (`contato_da_conversa:`) nas recusas de escopo e
   * não renomear o que o painel já lê.
   */
  origem: "permitido" | "incerto" | "erro" | "error" | "ok";
}

/**
 * Um CÓDIGO, e não uma frase: minúsculas, dígitos e `_`, sem espaço nem ponto.
 * É o que separa `sem_destino` de "não consegui registrar a proposta agora." —
 * as duas coisas viajam no mesmo campo `error` de formatos diferentes.
 */
const PARECE_CODIGO = /^[a-z][a-z0-9_]{0,60}$/;

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor : null;
}

function codigoDe(valor: unknown): string | null {
  const t = texto(valor);
  return t !== null && PARECE_CODIGO.test(t) ? t : null;
}

/**
 * `null` quando a chamada NÃO recusou. Qualquer outro retorno é recusa — e
 * recusa nunca é efeito: quem decide o `success` do audit e o estado do traço
 * lê daqui, em vez de reimplementar "deu certo?".
 */
export function recusaDaChamada(result: unknown): RecusaDaChamada | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;

  // 1. Recusa de escopo devolvida pelo handler (contato do turno, funil).
  if (r.permitido === false) {
    const motivo = texto(r.motivo);
    return {
      codigo: codigoDe(motivo),
      mensagem: texto(r.mensagem) ?? motivo ?? "recusada",
      origem: "permitido",
    };
  }

  // 2. Escrita sem desfecho: não se sabe se gravou. Não é sucesso — e a fala
  //    também não pode negar. O traço e o audit a tratam como recusa, com o
  //    código próprio para quem for investigar.
  if (r.resultado_incerto === true) {
    return {
      codigo: "resultado_incerto",
      mensagem: texto(r.mensagem) ?? texto(r.error) ?? "resultado_incerto",
      origem: "incerto",
    };
  }

  // 3. `{ erro, mensagem }` — o formato do catálogo MCP.
  const erro = texto(r.erro);
  if (erro !== null) {
    return { codigo: codigoDe(erro), mensagem: texto(r.mensagem) ?? erro, origem: "erro" };
  }

  // 4. `{ error }` — o que a ponte devolve ao modelo.
  const error = r.error;
  const errorTexto = texto(error);
  if (errorTexto !== null) {
    return { codigo: codigoDe(errorTexto), mensagem: errorTexto, origem: "error" };
  }
  if (typeof error === "object" && error !== null) {
    const e = error as { code?: unknown; message?: unknown };
    const mensagem = texto(e.message) ?? texto(e.code);
    if (mensagem !== null) {
      return { codigo: codigoDe(e.code), mensagem, origem: "error" };
    }
  }

  // 5. `{ ok: false }` — a convenção das tools nativas do run.
  if (r.ok === false) {
    const motivo = texto(r.motivo) ?? texto(r.erro) ?? texto(r.error);
    return { codigo: codigoDe(motivo), mensagem: motivo ?? "falhou", origem: "ok" };
  }

  return null;
}

/**
 * O rótulo do `error` no `api_audit_log`, no formato que o painel já lê.
 *
 * As recusas de escopo do handler mantêm `contato_da_conversa:` (é o nome
 * histórico e há teste sobre ele); as demais passam a `recusa_da_ferramenta:`,
 * para `sem_destino` não ser lido como recusa de contato.
 */
export function rotuloDaRecusa(recusa: RecusaDaChamada): string {
  const prefixo = recusa.origem === "permitido" ? "contato_da_conversa" : "recusa_da_ferramenta";
  return `${prefixo}:${recusa.codigo ?? recusa.mensagem}`;
}
