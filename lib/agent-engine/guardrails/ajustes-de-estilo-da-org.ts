import type { Queryable } from "../queue/queue";

/**
 * Lista FECHADA de ajustes de estilo que o produto sabe aplicar e testar.
 *
 * Não existe "localizar/substituir" livre: cada item precisa de semântica
 * determinística, teste próprio e uma chave conhecida pelo servidor.
 */
export const AJUSTES_DE_ESTILO = ["sem_travessao_longo"] as const;
export type AjusteDeEstilo = (typeof AJUSTES_DE_ESTILO)[number];

/** Prefixo no vocabulário aberto de `org_guardrail_layers`. */
const PREFIXO = "estilo:";

export type AjustesDeEstiloDaOrg = Record<AjusteDeEstilo, boolean>;

export const AJUSTES_DESLIGADOS: AjustesDeEstiloDaOrg = {
  sem_travessao_longo: false,
};

export function chavePersistidaDoAjuste(ajuste: AjusteDeEstilo): string {
  return `${PREFIXO}${ajuste}`;
}

export function ajusteDaChavePersistida(layer: string): AjusteDeEstilo | null {
  if (!layer.startsWith(PREFIXO)) return null;
  const ajuste = layer.slice(PREFIXO.length);
  return (AJUSTES_DE_ESTILO as readonly string[]).includes(ajuste)
    ? (ajuste as AjusteDeEstilo)
    : null;
}

/** O que a leitura viu — e se ela chegou a ver. */
export interface LeituraDosAjustes {
  ajustes: AjustesDeEstiloDaOrg;
  /**
   * `true` quando a consulta falhou e os ajustes acima são o default, não a
   * escolha da organização. Quem chama registra isso: degradar em silêncio faz
   * "a organização desligou" e "não consegui perguntar" terem a mesma cara.
   */
  leituraFalhou: boolean;
}

/**
 * Lê somente escolhas conhecidas da organização. Ausência de linha = desligado,
 * que é o default de produto pedido pela #378. Falha de leitura também degrada
 * para desligado: preferência de estilo não pode derrubar um atendimento — mas
 * ela volta marcada, para o chamador deixar rastro.
 *
 * ⚠️ **Chame FORA de transação aberta.** Uma consulta que falha dentro de uma
 * transação a deixa abortada, e a PRÓXIMA consulta morre com 25P02 — o `catch`
 * daqui esconderia a causa e o envio quebraria longe, com outro nome.
 */
export async function lerAjustesDeEstiloDaOrg(
  db: Queryable,
  organizationId: string,
): Promise<LeituraDosAjustes> {
  try {
    const { rows } = await db.query<{ layer: string; enabled: boolean }>(
      `select layer, enabled
         from org_guardrail_layers
        where organization_id = $1
          and layer = any($2::text[])`,
      [organizationId, AJUSTES_DE_ESTILO.map(chavePersistidaDoAjuste)],
    );
    const ajustes = { ...AJUSTES_DESLIGADOS };
    for (const row of rows) {
      const ajuste = ajusteDaChavePersistida(row.layer);
      if (ajuste !== null) ajustes[ajuste] = row.enabled;
    }
    return { ajustes, leituraFalhou: false };
  } catch {
    return { ajustes: { ...AJUSTES_DESLIGADOS }, leituraFalhou: true };
  }
}

/**
 * Primeiro item da lista fechada: troca travessão longo por vírgula + espaço.
 *
 * Nas bordas de uma linha o travessão some, em vez de virar vírgula órfã. No
 * meio, apenas espaços horizontais ao redor dele são absorvidos (`a—b` e
 * `a — b`); a quebra de linha nunca entra no lugar da vírgula, então um ajuste
 * de pontuação não achata os parágrafos escritos pelo modelo.
 *
 * As quatro bordas abaixo foram medidas na versão anterior desta função, que
 * trocava o travessão por vírgula em qualquer posição:
 *
 *   "Olá: — tudo bem?"        → "Olá:, tudo bem?"        (pontuação dupla)
 *   "Oi, — tudo bem?"         → "Oi,, tudo bem?"         (vírgula dupla)
 *   "Isso — — aquilo"         → "Isso, , aquilo"         (travessões seguidos)
 *   "Fim da linha —\r\n"      → "Fim da linha, \r\n"     (vírgula órfã em CRLF)
 *
 * Por isso: `\r?\n` nas bordas (o texto do modelo pode chegar com CRLF), uma ou
 * MAIS ocorrências por vez (`(?:—[ \t]*)+`), e travessão logo depois de `,`,
 * `:` ou `;` apenas SOME — quem já tinha pontuação não ganha outra.
 */
export function removerTravessaoLongo(texto: string): string {
  return texto
    .replace(/(^|\r?\n)[ \t]*(?:—[ \t]*)+/g, "$1")
    .replace(/[ \t]*(?:—[ \t]*)+(?=\r?\n|$)/g, "")
    .replace(/([,:;])[ \t]*(?:—[ \t]*)+/g, "$1 ")
    .replace(/[ \t]*(?:—[ \t]*)+/g, ", ");
}

/** Aplica os itens ligados em ordem de código, nunca por regra livre do usuário. */
export function aplicarAjustesDeEstilo(
  texto: string,
  ajustes: AjustesDeEstiloDaOrg,
): string {
  let resultado = texto;
  if (ajustes.sem_travessao_longo) resultado = removerTravessaoLongo(resultado);
  return resultado;
}
