/**
 * O MODO DA CHAVE, por provedor — uma função, os provedores que podem estar em vigor.
 *
 * A regra é a mesma que o registro de adaptadores já usa para o revendedor
 * (`modoDaChaveStripe`/`modoDaChaveAsaas`/`modoDaChaveEfi`), e é reusada em vez
 * de reescrita: duas derivações do mesmo prefixo divergem na primeira mudança de
 * formato de chave, e aqui a divergência custa caro — uma chave `sk_live_`
 * gravada como `teste` manda o cliente pagar num link que não cobra.
 *
 * O parâmetro é `ProvedorDeCobranca`, o vocabulário LARGO (o da instalação), e
 * não `ProvedorDePagamento` (o da organização): a linha da organização é
 * limitada pelo CHECK da migration 9409 a stripe|asaas, mas a herança vem de
 * `provedorDaInstalacao()`, que conhece também `efi` (#4944 / migration 9418).
 * Estreitar aqui devolveria `null` para uma chave de Efi que o adaptador sabe
 * cobrar, e a herança viraria `sem_gateway` sem ninguém ter configurado nada
 * errado.
 */
import { modoDaChaveAsaas } from "@/lib/cobranca/provedores/asaas";
import { modoDaChaveEfi } from "@/lib/cobranca/provedores/efi";
import { modoDaChaveStripe } from "@/lib/cobranca/provedores/stripe";
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";

import type { ModoDePagamento } from "./vocabulario";

/** `null` quando o prefixo não é de chave nenhuma conhecida do provedor. */
export function modoDaChave(provider: ProvedorDeCobranca, chave: string): ModoDePagamento | null {
  switch (provider) {
    case "stripe":
      return modoDaChaveStripe(chave);
    case "asaas":
      return modoDaChaveAsaas(chave);
    case "efi":
      return modoDaChaveEfi(chave);
  }
}
