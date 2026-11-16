/**
 * O RESUMO dos argumentos de uma escrita remota para a trilha de auditoria
 * (#4445).
 *
 * ── Por que não os argumentos como vieram ───────────────────────────────────
 *
 * `auditMcpToolCall` grava `metadata.args` com `redactArgs`, que protege um
 * punhado de NOMES conhecidos (`token`, `senha`, `cpf`…) e corta string longa.
 * Num servidor MCP externo isso não basta: o argumento é o que o cliente
 * ditou na conversa — nome, documento, endereço, cartão — e a chave pode se
 * chamar `documento`, `cpf_titular` ou `observacao`, que ninguém previu. O
 * `api_audit_log` é append-only: o que entrar fica.
 *
 * Então a escrita remota audita FORMA, não conteúdo: quais campos foram
 * enviados, de que tipo, com que tamanho. Dá para investigar ("mandou
 * `documento` de 11 caracteres numa chamada que o ERP recusou") sem guardar o
 * documento.
 *
 * ── O que sobrevive ─────────────────────────────────────────────────────────
 *
 *  - string que PARECE identificador de sistema (sem espaço, sem acento, sem
 *    vírgula, até `LIMITE_DA_STRING`): vai inteira. É o id do evento, o slug do
 *    horário, a data ISO — exatamente o que a investigação precisa;
 *  - string que parece documento/telefone/cartão (começa com dígito e segue só
 *    com dígito e separador, 7+ dígitos): vira `{ tipo: "numero_como_texto",
 *    digitos: N }`. Forma sim, número não;
 *  - qualquer outra string (nome, endereço, observação ditada): vira
 *    `{ tipo: "texto", caracteres: N }` — o teto não basta, porque um nome de 30
 *    caracteres é conteúdo, não identificador;
 *  - número/booleano/null: como vieram (não são texto livre);
 *  - objeto/array: só a FORMA — tipo, chaves/itens — porque podem carregar
 *    payload inteiro e são justamente o caso "nunca o payload inteiro".
 */

/** Teto de cada string resumida. Curto de propósito: identificador cabe, PII não. */
export const LIMITE_DA_STRING = 48;

/** Teto de chaves/itens listados de um objeto ou array. */
const LIMITE_DE_FILHOS = 12;

/**
 * O formato de identificador de sistema: sem espaço, sem acento, sem vírgula.
 * `2026-11-20T15:00:00-03:00`, `evt_9f2c`, um uuid, um slug — é o que a
 * investigação precisa e o que não é texto ditado por ninguém.
 */
const CARA_DE_IDENTIFICADOR = /^[A-Za-z0-9._:@+/-]+$/;

/**
 * Cara de documento/telefone/cartão: começa com dígito e segue só com dígito e
 * separador. Esses NUNCA vão inteiros — são exatamente o dado pessoal que a
 * trilha append-only não pode guardar.
 */
const CARA_DE_NUMERO_PESSOAL = /^\+?[0-9][0-9 .\-()]*$/;

function resumoDoValor(valor: unknown): unknown {
  if (valor === null) return null;
  if (typeof valor === "number" || typeof valor === "boolean") return valor;
  if (typeof valor === "string") {
    if (valor.length > LIMITE_DA_STRING) return { tipo: "texto", caracteres: valor.length };
    if (CARA_DE_NUMERO_PESSOAL.test(valor) && valor.replace(/\D/g, "").length >= 7) {
      // CPF, CNPJ, telefone, cartão, código de barras: forma sim, número não.
      return { tipo: "numero_como_texto", digitos: valor.replace(/\D/g, "").length };
    }
    if (!CARA_DE_IDENTIFICADOR.test(valor)) return { tipo: "texto", caracteres: valor.length };
    return valor;
  }
  if (Array.isArray(valor)) {
    return {
      tipo: "array",
      itens: valor.length,
      ...(valor.length > 0 ? { primeiro: resumoDoValor(valor[0]) } : {}),
    };
  }
  if (typeof valor === "object") {
    const chaves = Object.keys(valor as Record<string, unknown>);
    return {
      tipo: "objeto",
      chaves: chaves.slice(0, LIMITE_DE_FILHOS),
      ...(chaves.length > LIMITE_DE_FILHOS ? { mais_chaves: chaves.length - LIMITE_DE_FILHOS } : {}),
    };
  }
  return { tipo: typeof valor };
}

/**
 * O mapa de argumentos que vai para `metadata.args` numa escrita remota.
 *
 * `undefined` no valor não vira chave: é o que o modelo não mandou, e a
 * ausência de um campo também é informação de investigação.
 */
export function resumirArgumentosDaEscrita(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const resumo: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(args)) {
    if (valor === undefined) continue;
    resumo[chave] = resumoDoValor(valor);
  }
  return resumo;
}
