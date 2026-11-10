/**
 * O CARIMBO DO PEDIDO DOS EVENTOS QUE A PROSPECÇÃO EMITE (#3072).
 *
 * `metadata.request_id` do `event_log` diz de QUAL pedido o evento nasceu, e o motor
 * de automações usa esse campo no anti-laço: `rule:<uuid da REGRA>` e
 * `metadata.caused_by_rule` significam "quem emitiu este evento foi uma AÇÃO DE
 * REGRA" — e aí o evento é pulado, sem rodar regra nenhuma (profundidade 1;
 * cadeia regra→regra segue fora, `.specs/features/crm-automacao-fluxos/spec.md:70`).
 *
 * `rule:` é a marca da ação de regra, e SÓ dela
 * (`lib/automation/actions/create-or-move-lead.ts:41`, `send-ai-message.ts:161`,
 * `send-whatsapp.ts:89`). A campanha de prospecção não é regra: enquanto ela abria
 * o negócio carimbando `rule:<id da campanha>`, o `lead.created` da empresa
 * abordada chegava ao motor com a marca errada e TODA regra de "negócio criado" era
 * pulada — a etiqueta de separação do lead frio, o roteamento e a exclusão de
 * follow-up nunca aconteciam, e `event_log.consumed_by` registrava
 * `automation-rules: caused_by_rule` para um evento que não veio de regra nenhuma.
 *
 * O prefixo próprio não é invenção nova: os eventos do ENVIO da campanha já saíam
 * com ele (`lib/prospecting/worker.ts`). Aqui ele vira a definição única do módulo,
 * para o carimbo do negócio não voltar a ser escrito à mão com o prefixo da regra.
 */
export const PREFIXO_DO_PEDIDO_DA_PROSPECCAO = "prospecting:";

/** O `request_id` de um evento nascido da prospecção — NUNCA `rule:`. */
export function pedidoDaProspeccao(id: string): string {
  return `${PREFIXO_DO_PEDIDO_DA_PROSPECCAO}${id}`;
}
