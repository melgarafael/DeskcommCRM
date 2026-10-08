/**
 * O REGISTRO DOS ADAPTADORES DE COBRANÇA (spec cobrança do revendedor §6.4).
 *
 * Um só lugar monta o adaptador de produção: a chave lida a CADA uso pela
 * configuração (que só aceita o que a tela de Cobrança gravou) e a base de
 * teste, que só existe em bancada (loopback com o app em loopback). O Asaas
 * entra na PR 3b, no mesmo contrato.
 */
import { chaveDoProvedor } from "@/lib/cobranca/configuracao";
import { env } from "@/lib/env";

import { baseDeTesteDaCobranca } from "./base-de-teste";
import { ErroDoProvedor, type AdaptadorDeCobranca, type Modo, type ProvedorDeCobranca } from "./contrato";
import { criarAdaptadorStripe, marcaDaInstalacao, modoDaChaveStripe } from "./stripe";

export interface OpcoesDoAdaptador {
  fetch?: typeof fetch;
  /** Só a Conexão usa: testa a chave DIGITADA antes de gravá-la. */
  chave?: () => Promise<string | null>;
}

export function adaptador(id: ProvedorDeCobranca, opcoes: OpcoesDoAdaptador = {}): AdaptadorDeCobranca {
  if (id !== "stripe") throw new ErroDoProvedor(null, "provedor_nao_suportado", false);
  const teste = baseDeTesteDaCobranca();
  return criarAdaptadorStripe({
    lerChave: opcoes.chave ?? (() => chaveDoProvedor("stripe")),
    fetch: opcoes.fetch,
    baseUrl: teste === null ? undefined : `${teste}/v1`,
    marca: marcaDaInstalacao(env.NEXT_PUBLIC_APP_URL ?? ""),
  });
}

/** O modo da chave GRAVADA (teste ou produção). `null` = nada gravado, ou provedor ainda sem suporte. */
export async function modoDoProvedor(id: ProvedorDeCobranca): Promise<Modo | null> {
  if (id !== "stripe") return null;
  const chave = await chaveDoProvedor("stripe");
  return chave === null ? null : modoDaChaveStripe(chave);
}
