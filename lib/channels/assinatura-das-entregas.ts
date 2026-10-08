/**
 * AS ÚLTIMAS ENTREGAS DO WHATSAPP CHEGARAM ASSINADAS? — a resposta que a tela
 * de `/admin/sistema` mostra ao lado de "Exigir assinatura nas entregas do canal".
 *
 * ─── Por que isto existe (doc 99 do mantenedor, opção A) ────────────────────
 *
 * O interruptor vem desligado porque ligá-lo com o servidor do canal sem
 * assinar corta a entrada de TODAS as mensagens. Até o PR #2268 o compose
 * entregava o segredo com o nome errado e nenhuma entrega vinha assinada; depois
 * dele, quem atualiza passa a receber entregas assinadas — mas o "ligue quando
 * ele estiver assinando" só existia num comentário de código. Esta leitura
 * transforma isso em algo que o operador vê, e a tela sugere ligar quando a
 * resposta é sim. O padrão NÃO muda (decisão do dono).
 *
 * ─── Por que não há tabela nova ─────────────────────────────────────────────
 *
 * A verdade já é gravada, por entrega: as duas rotas do webhook escrevem
 * `webhook_events_log.valid_signature` com o que `authenticateWahaWebhook`
 * respondeu. Um contador por instalação seria uma SEGUNDA fonte do mesmo fato,
 * com escrita no caminho quente da ingestão. Aqui só se lê, e só quando um
 * administrador da plataforma abre a tela.
 *
 * ─── A regra do "sim" ───────────────────────────────────────────────────────
 *
 * Não basta "a mais recente veio assinada": numa instalação com DOIS números,
 * um assinando (movimentado) e outro sem assinar (pouco movimentado), a mais
 * recente seria quase sempre assinada, a tela sugeriria ligar — e o segundo
 * pararia de receber. Então: **sim = houve entrega assinada na janela, e nenhuma sem
 * assinatura chegou desde a PRIMEIRA assinada**. Entrega sem assinatura de antes
 * da atualização não conta contra (é o passado que o #2268 consertou); entrega
 * sem assinatura de depois conta, porque prova que algum servidor ainda não
 * assina.
 *
 * O LIMITE desta regra: ela só enxerga quem ENTREGOU. Um número que não assina
 * e não entregou nada desde a primeira entrega assinada (ou nada na janela) não
 * aparece na conta — e é indistinguível do "passado de antes do #2268". Com o
 * WAHA do compose isso não acontece (um segredo só, todas as sessões assinam
 * juntas); com dois WAHAs ou um proxy no meio, confira cada número antes de
 * ligar.
 *
 * Mora em `lib/channels/` porque pergunta pelo transporte pelo nome
 * (`provider = 'waha'`) — o interruptor só vale para esse transporte.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** A janela de "últimas entregas". Igual ao prazo em que a linha ainda tem o corpo. */
export const JANELA_DAS_ENTREGAS_EM_DIAS = 7;

export interface AssinaturaDasEntregas {
  /** `null` = nenhuma entrega na janela: não há o que responder. */
  readonly assinadas: boolean | null;
  readonly ultimaAssinadaEm: string | null;
  readonly ultimaSemAssinaturaEm: string | null;
}

/** A regra do "sim", isolada para ser testada nas duas direções. */
export function responderAssinatura(instantes: {
  primeiraAssinadaEm: string | null;
  ultimaAssinadaEm: string | null;
  ultimaSemAssinaturaEm: string | null;
}): AssinaturaDasEntregas {
  const { primeiraAssinadaEm, ultimaAssinadaEm, ultimaSemAssinaturaEm } = instantes;
  let assinadas: boolean | null;
  if (!ultimaAssinadaEm || !primeiraAssinadaEm) assinadas = ultimaSemAssinaturaEm ? false : null;
  else
    assinadas =
      !ultimaSemAssinaturaEm || Date.parse(ultimaSemAssinaturaEm) < Date.parse(primeiraAssinadaEm);
  return { assinadas, ultimaAssinadaEm, ultimaSemAssinaturaEm };
}

/**
 * Lê as três datas e responde; `null` quando a leitura falhou, e aí a tela não
 * diz nada (nem sim, nem "sem entregas"). Nunca lança: roda dentro da página, e
 * um throw ali é a tela inteira fora do ar por causa de um aviso.
 */
export async function lerAssinaturaDasEntregas(
  admin: SupabaseClient,
  agora: Date = new Date(),
): Promise<AssinaturaDasEntregas | null> {
  const desde = new Date(agora.getTime() - JANELA_DAS_ENTREGAS_EM_DIAS * 86_400_000).toISOString();
  const instante = (assinada: boolean, maisRecente: boolean) =>
    admin
      .from("webhook_events_log")
      .select("received_at")
      .eq("provider", "waha")
      .eq("valid_signature", assinada)
      .gte("received_at", desde)
      // ponytail: `archived_at is null` é o predicado do índice parcial
      // `webhook_events_log_a_esvaziar_idx (received_at)` — sem ele não há
      // índice que comece por `received_at` e cada leitura varre a tabela. Na
      // janela de 7 dias toda linha ainda tem corpo (a poda é em D+7); se a
      // retenção for encurtada, a janela encolhe junto, e é só isso.
      .is("archived_at", null)
      .order("received_at", { ascending: !maisRecente })
      .limit(1)
      .maybeSingle();

  try {
    const [primeira, ultima, semAssinatura] = await Promise.all([
      instante(true, false),
      instante(true, true),
      instante(false, true),
    ]);
    const erro = primeira.error ?? ultima.error ?? semAssinatura.error;
    if (erro) {
      logger.warn("assinatura das entregas do canal: leitura recusada — a tela não opina", {
        erro: erro.message,
      });
      return null;
    }
    const em = (r: { data: unknown }) =>
      ((r.data as { received_at?: string } | null)?.received_at ?? null);
    return responderAssinatura({
      primeiraAssinadaEm: em(primeira),
      ultimaAssinadaEm: em(ultima),
      ultimaSemAssinaturaEm: em(semAssinatura),
    });
  } catch (e) {
    logger.warn("assinatura das entregas do canal: leitura falhou — a tela não opina", {
      erro: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
