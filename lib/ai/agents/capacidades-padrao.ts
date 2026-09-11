/**
 * As capacidades com que o primeiro agente da organização nasce.
 *
 * Até aqui ele nascia com `tool_ids = '{}'`, e array vazio faz o turno não
 * montar ferramenta nenhuma: o "funcionário de IA" que o onboarding entrega
 * conversa e só. Não cria lead, não move card, não anota nada. O produto inteiro
 * — funil, contatos, negócios — fica do outro lado de uma porta que ninguém
 * abriu, e o dono não tem como saber disso.
 *
 * A escolha é o pacote `vender` INTEIRO, e não uma lista montada à mão:
 *
 *  - é o buraco real. O motor já tem ferramentas nativas para conversar
 *    (responder, buscar conhecimento, pedir ajuda humana); o que ele não tem é
 *    qualquer coisa que enxergue ou mexa no card do CRM;
 *  - cabe com folga no teto por agente, enquanto NENHUM par de pacotes cabe —
 *    ligar dois seria estourar ou escolher metade de cada, e meio pacote é uma
 *    lista arbitrária que ninguém consegue explicar;
 *  - a tela conta uma história: o dono abre as capacidades e lê "Vender e mover
 *    o funil: ligado", em vez de uma lista de itens soltos.
 *
 * Derivada do pacote em tempo de execução, nunca fixada como lista de ids: uma
 * cópia da lista envelheceria em silêncio na primeira capacidade nova do
 * catálogo — e o agente do onboarding é justamente quem ninguém revisa depois.
 */
import { allTools } from "@/lib/mcp/tools";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import { ligarPacote } from "@/lib/mcp/tools/selecao-por-pacote";
import type { ModulesState } from "@/lib/modules/config";

/** O pacote que o primeiro agente recebe ligado. */
export const PACOTE_PADRAO_DO_ONBOARDING = "vender" as const;

/**
 * O catálogo restrito ao que TEM handler. Uma entrada declarada sem
 * implementação viraria um id gravado em `tool_ids` que nunca monta ferramenta:
 * a tela mostraria a capacidade ligada e o turno não teria a mão.
 */
const MODULOS_DESLIGADOS: ModulesState = { academia: false };

export function catalogoComHandler(modulos: ModulesState = MODULOS_DESLIGADOS) {
  const comHandler = new Set(allTools.map((t) => t.name));
  return TOOL_CATALOG.filter(
    (c) =>
      comHandler.has(c.name) &&
      (c.name !== "crm_find_academia_classes" || modulos.academia),
  );
}

export function capacidadesPadraoDoOnboarding(
  modulos: ModulesState = MODULOS_DESLIGADOS,
): string[] {
  const catalogo = catalogoComHandler(modulos);
  // `ligarPacote` já respeita as duas regras que importam: capacidade de risco
  // crítico nunca entra por pacote, e a ordem é a do catálogo (para o diff de
  // versão do agente ser legível).
  return ligarPacote([], catalogo, PACOTE_PADRAO_DO_ONBOARDING);
}
