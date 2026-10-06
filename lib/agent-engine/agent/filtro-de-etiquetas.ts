/**
 * FILTRO POR ETIQUETA DO CONTATO — "este agente responde a quem escreveu?"
 *
 * NÃO é gatilho. Pôr ou tirar uma etiqueta não faz agente nenhum escrever para
 * ninguém. O filtro só é consultado quando o contato MANDA mensagem (ou quando
 * um follow-up do agente vai sair): aí, entre os agentes que poderiam atender
 * a conversa, vale o primeiro cujo filtro aceita as etiquetas do contato. Se
 * nenhum aceitar, a IA fica calada e a conversa segue no Inbox
 * (`resolve-turn-agent.ts`, desfecho `fora_das_etiquetas`).
 *
 * Mora na versão do agente (`ai_agent_versions.trigger_config.filters`), ao
 * lado do horário de funcionamento: muda no rascunho e vale quando publica.
 *
 *   contact_tags_include — responde só quem tem ALGUMA destas. Vazio = todos.
 *   contact_tags_exclude — nunca responde quem tem alguma destas. Vence o include.
 *
 * As etiquetas comparadas são as do CONTATO (`contacts.tags`), as do Inbox. As
 * do negócio (`crm_leads.tags`) ficam de fora.
 *
 * Leitura defensiva que falha ABERTA, como `janela-de-atendimento.ts`: jsonb com
 * forma estranha vira "sem filtro". Quem garante a forma é o schema de gravação
 * (`lib/ai/agents/validation.ts`); um filtro torto que calasse o agente para
 * todo mundo seria pior que um filtro ignorado.
 */
import { normalizarTag, normalizarTags } from '@/lib/contacts/tag-normalizada';

/** Teto de etiquetas por lista — o mesmo na tela e no schema. */
export const TETO_DE_ETIQUETAS_NO_FILTRO = 20;

export interface FiltroDeEtiquetas {
  /** Responde só quem tem alguma destas. Vazio = qualquer contato. */
  incluir: string[];
  /** Nunca responde quem tem alguma destas. Vence `incluir`. */
  excluir: string[];
}

function listaDeEtiquetas(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [];
  return normalizarTags(bruto.filter((t): t is string => typeof t === 'string'));
}

/** Extrai o filtro de `trigger_config`. `null` = sem filtro (as duas listas vazias ou ausentes). */
export function lerFiltroDeEtiquetas(triggerConfig: unknown): FiltroDeEtiquetas | null {
  if (typeof triggerConfig !== 'object' || triggerConfig === null) return null;
  const filters = (triggerConfig as { filters?: unknown }).filters;
  if (typeof filters !== 'object' || filters === null) return null;
  const { contact_tags_include, contact_tags_exclude } = filters as {
    contact_tags_include?: unknown;
    contact_tags_exclude?: unknown;
  };
  const incluir = listaDeEtiquetas(contact_tags_include);
  const excluir = listaDeEtiquetas(contact_tags_exclude);
  if (incluir.length === 0 && excluir.length === 0) return null;
  return { incluir, excluir };
}

/** A regra: `excluir` vence; `incluir` vazio aceita todos; senão, basta uma em comum. */
export function agenteAtendeAsEtiquetas(
  filtro: FiltroDeEtiquetas | null | undefined,
  etiquetasDoContato: readonly string[],
): boolean {
  if (filtro === null || filtro === undefined) return true;
  const doContato = new Set(etiquetasDoContato.map(normalizarTag));
  if (filtro.excluir.some((t) => doContato.has(t))) return false;
  if (filtro.incluir.length === 0) return true;
  return filtro.incluir.some((t) => doContato.has(t));
}
