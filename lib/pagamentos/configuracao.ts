/**
 * O SEGREDO DO AVISO DE PAGAMENTO — e o que falta quando ele não existe.
 *
 * ─── De onde vem ────────────────────────────────────────────────────────────
 *
 * Do painel da instalação (`lib/instalacao/catalogo.ts`), cifrado no banco, como
 * toda credencial de provedor. NÃO do `.env` por atalho: um
 * `INFINITEPAY_WEBHOOK_SECRET` esquecido no arquivo de instalação viraria o
 * segredo que aceita qualquer aviso de "pago" sem ninguém ter decidido isso —
 * a mesma razão pela qual `lib/cobranca/configuracao.ts` só aceita a chave como
 * `fonte: "banco"`.
 *
 * ─── O que a rota faz com "não configurado" ─────────────────────────────────
 *
 * NADA. Não é 200 com "recebido": um aviso aceito sem conferência é pior que um
 * aviso perdido, porque o provedor para de reentregar o que ele acha que já
 * chegou. A rota responde 503 dizendo QUAL chave falta e onde configurá-la, e o
 * negócio não muda. É a diferença entre falhar alto e fingir sucesso.
 */
import { valorDaInstalacao } from "@/lib/instalacao/config";

/**
 * A chave no catálogo da instalação. Uma só, e é ela que a tela mostra.
 *
 * O nome dela aparece ESCRITO de novo no call site de `configuracaoDoRecebimento`,
 * de propósito: a cerca `painel-nao-promete-o-que-nao-cumpre` procura
 * `valorDaInstalacao("<CHAVE>")` no código de produção, e uma leitura por
 * constante é invisível para ela — a chave ficaria marcada como editável na tela
 * sem que ninguém conseguisse provar que o motor a lê. É a mesma razão do literal
 * em `lib/cobranca/configuracao.ts`. O `satisfies` logo abaixo amarra os dois: se
 * esta constante mudar, o build acusa antes de a chave sair de sincronia.
 */
export const CHAVE_DO_SEGREDO = "INFINITEPAY_WEBHOOK_SECRET";

export interface ConfiguracaoDoRecebimento {
  /** `null` = não configurado. Quem chama DEVE recusar, nunca seguir. */
  readonly segredo: string | null;
  /** O nome da chave que falta, para a mensagem de erro ser acionável. */
  readonly chave: string;
}

export async function configuracaoDoRecebimento(): Promise<ConfiguracaoDoRecebimento> {
  const v = await valorDaInstalacao("INFINITEPAY_WEBHOOK_SECRET" satisfies typeof CHAVE_DO_SEGREDO);
  const valor = v.fonte === "banco" ? v.valor : null;
  const limpo = typeof valor === "string" ? valor.trim() : "";
  // Segredo curto é segredo adivinhado: o HMAC do aviso vale o tamanho da chave.
  return { segredo: limpo.length >= 16 ? limpo : null, chave: CHAVE_DO_SEGREDO };
}
