/**
 * A TELEFONIA ESTÁ EM USO NESTA ORGANIZAÇÃO? — o sinal que o item de menu precisa
 * (issue #1290).
 *
 * ─── Por que a pergunta é esta, e não "o módulo está ligado?" ─────────────────
 *
 * "Telefonia ligada" na INSTALAÇÃO é o profile `telefonia` do `COMPOSE_PROFILES`,
 * lido pelo Docker quando os contêineres sobem. O aplicativo NÃO enxerga isso
 * (`lib/recursos-opcionais/catalogo.ts`, `telefonia_sip`: `ler: () => "nao_verificado"`),
 * e inventar uma variável de ambiente aqui acertaria na máquina de
 * desenvolvimento e erraria no self-host — o defeito que a issue pede para não
 * reproduzir.
 *
 * O que o app enxerga é o que a ORGANIZAÇÃO tem, por QUALQUER um dos caminhos
 * que a main de fato usa para ligar — e não só o tronco salvo na tela:
 *
 *  1. o tronco salvo em `voip_trunk_settings` (`/app/settings/voip-trunk`);
 *  2. o tronco da INSTALAÇÃO em `VOIP_TRUNK_ENDPOINT`: sem tronco salvo, a
 *     ligação de saída cai nele (`app/api/v1/calls/route.ts`), e o número (DID)
 *     só se cadastra com ele (`app/api/v1/phone-numbers/route.ts`);
 *  3. um número ATIVO em `phone_numbers`: é por ele que a ligação de ENTRADA
 *     acha a organização (`workers/voice-agent`), sem ler o tronco salvo;
 *  4. uma ligação SIP já registrada em `voice_calls` (`provider = 'sip'`): é o
 *     que a tela de Chamadas lista. A ligação de WhatsApp (`provider =
 *     'wacalls'`) mora na MESMA tabela e tem tela própria — contá-la daria a
 *     porta de uma tela que abre vazia, que é o defeito da #1290.
 *
 * Olhar só o tronco salvo escondia Chamadas de quem atende ligação de verdade.

 * ─── O custo, declarado ──────────────────────────────────────────────────────
 *
 * Até TRÊS leituras de uma linha (`limit(1)`), todas por `organization_id` e em
 * paralelo, dentro do `Promise.all` que o shell de `/app` já dispara — não é
 * consulta em série no caminho quente. Com `VOIP_TRUNK_ENDPOINT` definido, zero.

 * ─── A regra de leitura ──────────────────────────────────────────────────────
 *
 * Falha fechada POR FONTE, como `modulosLigados()` e `capacidadesLigadas()`:
 * erro de banco ou exceção numa leitura = aquela fonte não conta. Basta UMA
 * fonte dizer que sim. Nunca lança — roda no layout de `/app`, e um throw ali
 * derruba todas as telas.
 *
 * Sem cache de processo de propósito: o tronco muda quando o cliente salva a
 * tela, e um menu que só acorda no próximo deploy repetiria o defeito que este
 * arquivo fecha. Se aparecer medido num perfil, memoiza-se aqui e em mais
 * nenhum lugar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

type Leitura = PromiseLike<{ data: unknown[] | null; error: unknown }>;

// A consulta é MONTADA dentro do try: um cliente que não tenha `limit` (ou que
// lance ao encadear) derruba só esta fonte, nunca o sinal inteiro.
async function temLinha(
  leitura: () => Leitura,
  fonte: string,
  organizationId: string,
): Promise<boolean> {
  try {
    const { data, error } = await leitura();
    if (error) {
      logger.warn("telefonia em uso: leitura recusada — a fonte não conta", {
        organization_id: organizationId,
        fonte,
        detalhe: (error as { message?: string }).message,
      });
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (erro) {
    logger.warn("telefonia em uso: leitura falhou — a fonte não conta", {
      organization_id: organizationId,
      fonte,
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return false;
  }
}

export async function telefoniaEmUso(db: SupabaseClient, organizationId: string): Promise<boolean> {
  if ((process.env.VOIP_TRUNK_ENDPOINT ?? "").trim() !== "") return true;
  const fontes = await Promise.all([
    temLinha(
      () =>
        db
          .from("voip_trunk_settings")
          .select("organization_id")
          .eq("organization_id", organizationId)
          .limit(1),
      "tronco salvo",
      organizationId,
    ),
    temLinha(
      () =>
        db
          .from("phone_numbers")
          .select("id")
          .eq("organization_id", organizationId)
          .eq("is_active", true)
          .limit(1),
      "número ativo",
      organizationId,
    ),
    temLinha(
      () =>
        db
          .from("voice_calls")
          .select("id")
          .eq("organization_id", organizationId)
          .eq("provider", "sip")
          .limit(1),
      "ligação SIP registrada",
      organizationId,
    ),
  ]);
  return fontes.some(Boolean);
}
