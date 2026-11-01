/**
 * Validade, em segundos, do link temporário de uma mídia de mensagem guardada no
 * bucket `whatsapp-media`. Uma só constante para a rota `/api/v1/messages/[id]/media`
 * e para o histórico do MCP: eram duas literais 3600 com um comentário dizendo
 * que eram a mesma.
 */
export const VALIDADE_DO_LINK_DE_MIDIA_S = 3600;
