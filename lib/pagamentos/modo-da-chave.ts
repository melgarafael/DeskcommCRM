/**
 * O MODO DA CHAVE, por provedor — uma função, dois provedores.
 *
 * A regra é a mesma que o registro de adaptadores já usa para o revendedor
 * (`modoDaChaveStripe`/`modoDaChaveAsaas`), e é reusada em vez de reescrita:
 * duas derivações do mesmo prefixo divergem na primeira mudança de formato de
 * chave, e aqui a divergência custa caro — uma chave `sk_live_` gravada como
 * `teste` manda o cliente pagar num link que não cobra.
 */
import { modoDaChaveAsaas } from "@/lib/cobranca/provedores/asaas";
import { modoDaChaveStripe } from "@/lib/cobranca/provedores/stripe";

import type { ModoDePagamento, ProvedorDePagamento } from "./vocabulario";

/** `null` quando o prefixo não é de chave nenhuma conhecida do provedor. */
export function modoDaChave(provider: ProvedorDePagamento, chave: string): ModoDePagamento | null {
  const modo = provider === "stripe" ? modoDaChaveStripe(chave) : modoDaChaveAsaas(chave);
  return modo === null ? null : modo;
}
