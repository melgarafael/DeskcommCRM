/**
 * O NOME DA INTEGRAÇÃO no balão (#5160).
 *
 * ─── O defeito, medido na main `03604fd978` ────────────────────────────────
 *
 * Mensagem enviada por token de API (`POST /api/v1/messages` com Bearer) nasce
 * `sent_via='system'` (`origemDaMensagem`, `app/api/v1/messages/_handler.ts`) e
 * o balão desenhava só "Sistema": o dono lia a conversa sem saber QUAL
 * integração falou. A `api_tokens.name` existe na linha do token, mas a linha
 * de `messages` não a carregava, e o balão não faz join — o que não está na
 * linha não aparece em lugar nenhum.
 *
 * ─── Por que a chave mora aqui ─────────────────────────────────────────────
 *
 * Quem ESCREVE (handler, com o client de service role) e quem LÊ (o balão, no
 * cliente) precisam do mesmo literal, e um segundo literal digitado no
 * componente divergiria em silêncio na primeira renomeação. Este módulo é puro
 * — sem `supabase`, sem `next` —, então serve aos dois lados.
 *
 * A chave é escrita DEPOIS de `input.metadata` no handler e o valor é lido da
 * linha do token (`api_tokens.name`), nunca do corpo da requisição: `metadata`
 * é entrada do cliente, e aceitar nome dali seria deixar qualquer token
 * escolher a própria assinatura na tela — o mesmo erro que a #3649 fechou para
 * `ai_actor_name`. O handler também REMOVE a chave do metadata de entrada,
 * para um valor forjado não sobreviver numa linha sem nome resolvido.
 */
export const CHAVE_DO_NOME_DA_INTEGRACAO = "integration_actor_name";

/**
 * O nome gravado na linha, ou `null` quando não há (linha antiga, token
 * revogado, leitura do token falhou). O balão cai para "Integração".
 *
 * Nunca traduz: nome de token é dado do operador (#1046/#3649 — traduzir dado
 * muda o dado).
 */
export function nomeDaIntegracaoDaMensagem(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const gravado = metadata?.[CHAVE_DO_NOME_DA_INTEGRACAO];
  if (typeof gravado !== "string") return null;
  const nome = gravado.trim();
  return nome || null;
}
