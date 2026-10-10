/**
 * O REGISTRO DOS ADAPTADORES DE COBRANÇA (spec cobrança do revendedor §6.4).
 *
 * Um só lugar monta o adaptador de produção: a chave lida a CADA uso pela
 * configuração (que só aceita o que a tela de Cobrança gravou) e a base de
 * teste, que só existe em bancada (loopback com o app em loopback). Stripe e
 * Asaas no mesmo contrato; o dublê de bancada atende os dois nos caminhos das
 * APIs reais: /v1 (Stripe) e /v3 (Asaas).
 */
import { chaveDoProvedor } from "@/lib/cobranca/configuracao";
import { env } from "@/lib/env";

import { criarAdaptadorAsaas, modoDaChaveAsaas } from "./asaas";
import { baseDeTesteDaCobranca } from "./base-de-teste";
import type { AdaptadorDeCobranca, Modo, ProvedorDeCobranca } from "./contrato";
import { criarAdaptadorStripe, marcaDaInstalacao, modoDaChaveStripe } from "./stripe";

export interface OpcoesDoAdaptador {
  fetch?: typeof fetch;
  /** Só a Conexão usa: testa a chave DIGITADA antes de gravá-la. */
  chave?: () => Promise<string | null>;
}

export function adaptador(id: ProvedorDeCobranca, opcoes: OpcoesDoAdaptador = {}): AdaptadorDeCobranca {
  const teste = baseDeTesteDaCobranca();
  const comum = {
    lerChave: opcoes.chave ?? (() => chaveDoProvedor(id)),
    fetch: opcoes.fetch,
    marca: marcaDaInstalacao(env.NEXT_PUBLIC_APP_URL ?? ""),
  };
  switch (id) {
    case "stripe":
      return criarAdaptadorStripe({ ...comum, baseUrl: teste === null ? undefined : `${teste}/v1` });
    case "asaas":
      return criarAdaptadorAsaas({ ...comum, baseUrl: teste === null ? undefined : `${teste}/v3` });
  }
}

/** O modo da chave GRAVADA (teste ou produção). `null` = nada gravado, ou prefixo desconhecido. */
export async function modoDoProvedor(id: ProvedorDeCobranca): Promise<Modo | null> {
  const chave = await chaveDoProvedor(id);
  if (chave === null) return null;
  return id === "stripe" ? modoDaChaveStripe(chave) : modoDaChaveAsaas(chave);
}
