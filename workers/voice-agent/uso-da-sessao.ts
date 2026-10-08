/**
 * O USO DE UMA LIGAÇÃO NA OPENAI REALTIME — medido, somado e virado UMA linha
 * de `llm_calls` no fim da chamada. Puro: sem rede, sem banco, sem relógio.
 *
 * ═══ POR QUE ═══
 *
 * A sessão de voz é o gasto mais caro por minuto do produto e não deixava linha
 * nenhuma: a tela de Uso de IA mostrava zero para quem atende por telefone.
 *
 * ═══ O QUE É MEDIDO DE VERDADE ═══
 *
 * Cada `response.done` da Realtime API traz `response.usage` com os tokens
 * daquela resposta (entrada e saída, cada um com o detalhe texto/áudio/cache).
 * Esta soma é o uso REAL da sessão, vindo do provedor — nada estimado. A
 * duração da ligação vai em `latency_ms`, que é o "quanto tempo durou" desta
 * chamada (não é latência de resposta).
 *
 * ═══ ⚠️ O QUE NÃO É: O PREÇO ═══
 *
 * `cost_cents` sai NULO, e é LIMITAÇÃO DECLARADA, não preço. Token de ÁUDIO é
 * cobrado a uma tarifa própria, muito acima da de texto, e nem `ai_pricing` nem
 * `pricing.ts` têm tarifa de modelo realtime — `computeCost` precificaria o
 * áudio como texto (ou devolveria 0). Inventar a tarifa aqui seria número
 * errado com cara de medido. O que a linha entrega: quantas ligações, quantos
 * tokens (o detalhe áudio/texto vai no log do fim da chamada) e quanto tempo.
 * O gasto em dinheiro da voz segue FORA da régua do teto até existir tarifa
 * de realtime no catálogo.
 *
 * Nulo, e não 0, porque é o nulo que DIZ isso na tela: `getBudgetStatus` conta
 * linha `ok` com `cost_cents` nulo como `gasto_incompleto`, e o card de
 * Orçamento avisa que o gasto medido é menor que o real e que a parada pode não
 * disparar. Um 0 seria o número com cara de medido que este cabeçalho recusa —
 * o card afirmaria medição completa com a ligação inteira fora da conta.
 */
import type { ChamadaDeIa } from "@/lib/ai/usage/registrar-chamada";

/**
 * O `purpose` da sessão de voz em `llm_calls`.
 *
 * ⚠️ PENDENTE: ainda não é ponto de `lib/ai/pontos/registro.ts` — a tela de
 * Execuções o mostra cru até o ponto existir lá (com `registraEm: "llm_calls"`).
 */
export const PURPOSE_DA_VOZ = "voz_ao_vivo";

export interface UsoDaSessao {
  /** Quantos `response.done` trouxeram uso. */
  respostas: number;
  entrada: number;
  saida: number;
  entradaAudio: number;
  entradaTexto: number;
  entradaCache: number;
  saidaAudio: number;
  saidaTexto: number;
}

export function usoVazio(): UsoDaSessao {
  return {
    respostas: 0,
    entrada: 0,
    saida: 0,
    entradaAudio: 0,
    entradaTexto: 0,
    entradaCache: 0,
    saidaAudio: 0,
    saidaTexto: 0,
  };
}

/** Número finito e não negativo, ou 0 — o evento vem de fora e não é validado. */
function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Soma o `response.usage` de um `response.done` ao acumulado. Evento sem uso
 * (resposta cancelada antes de gerar, ou formato que mudou) não conta como
 * resposta medida — devolve o acumulado como estava.
 */
export function somarUsoDaResposta(acumulado: UsoDaSessao, usage: unknown): UsoDaSessao {
  if (usage === null || typeof usage !== "object") return acumulado;
  const u = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_token_details?: { audio_tokens?: unknown; text_tokens?: unknown; cached_tokens?: unknown };
    output_token_details?: { audio_tokens?: unknown; text_tokens?: unknown };
  };
  return {
    respostas: acumulado.respostas + 1,
    entrada: acumulado.entrada + n(u.input_tokens),
    saida: acumulado.saida + n(u.output_tokens),
    entradaAudio: acumulado.entradaAudio + n(u.input_token_details?.audio_tokens),
    entradaTexto: acumulado.entradaTexto + n(u.input_token_details?.text_tokens),
    entradaCache: acumulado.entradaCache + n(u.input_token_details?.cached_tokens),
    saidaAudio: acumulado.saidaAudio + n(u.output_token_details?.audio_tokens),
    saidaTexto: acumulado.saidaTexto + n(u.output_token_details?.text_tokens),
  };
}

/**
 * A linha da ligação. `erro` só quando a sessão nem abriu (handshake recusado
 * pela OpenAI — chave errada, sem saldo, modelo inexistente): é a falha que a
 * tela de Execuções precisa mostrar. Ligação que abriu e terminou é `ok`, com o
 * uso que houve.
 */
export function linhaDaLigacao(entrada: {
  organizationId: string;
  agentId: string | null;
  contactId: string | null;
  modelo: string;
  uso: UsoDaSessao;
  duracaoMs: number;
  erro: { message: string; status?: number } | null;
}): ChamadaDeIa {
  return {
    organization_id: entrada.organizationId,
    agent_id: entrada.agentId,
    contact_id: entrada.contactId,
    purpose: PURPOSE_DA_VOZ,
    provider: "openai",
    model: entrada.modelo,
    input_tokens: entrada.uso.entrada,
    output_tokens: entrada.uso.saida,
    // Ver o cabeçalho: tokens medidos, tarifa de áudio desconhecida → nulo.
    cost_cents: null,
    latency_ms: entrada.duracaoMs,
    erro: entrada.erro,
  };
}
