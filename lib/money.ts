/**
 * Conversão de valor digitado (reais) para centavos.
 *
 * A versão anterior vivia copiada em três formulários de lead e fazia
 * `reais.replace(/\./g, "").replace(",", ".")` — ou seja, tratava TODO ponto
 * como separador de milhar. Quem digitasse "249.90" (o jeito natural em
 * teclado numérico) tinha o valor gravado como R$ 24.990,00: cem vezes maior,
 * sem erro na tela, alimentando funil e relatórios com número errado.
 *
 * A regra aqui desambigua sem adivinhação, porque em pt-BR grupo de milhar tem
 * SEMPRE 3 dígitos:
 *
 *   "249,90"      → vírgula é decimal                       → 24990
 *   "249.90"      → ponto seguido de 2 dígitos é decimal    → 24990
 *   "1.234"       → ponto seguido de 3 dígitos é milhar     → 123400
 *   "1.234,56"    → tem vírgula: pontos são milhar          → 123456
 *   "1,234.56"    → formato en: o último separador é decimal→ 123456
 *   "1.234.567"   → todos os grupos com 3 dígitos           → 123456700
 *
 * Devolve null quando não dá para ler um número — quem chama decide a mensagem.
 */
export function parseReaisToCents(input: string): number | null {
  const raw = input.trim();
  if (raw.length === 0) return null;
  if (!/^[\d.,\s]+$/.test(raw)) return null;

  const s = raw.replace(/\s/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  let decimalSep = "";
  if (lastComma >= 0 && lastDot >= 0) {
    // Os dois presentes: o que vem por último é o decimal (pt-BR ou en).
    decimalSep = lastComma > lastDot ? "," : ".";
  } else if (lastComma >= 0) {
    decimalSep = ",";
  } else if (lastDot >= 0) {
    // Só ponto: é milhar apenas se o grupo final tiver exatamente 3 dígitos.
    decimalSep = s.length - lastDot - 1 === 3 ? "" : ".";
  }

  let normalized: string;
  if (decimalSep === "") {
    normalized = s.replace(/[.,]/g, "");
  } else {
    const cut = decimalSep === "," ? lastComma : lastDot;
    const inteiro = s.slice(0, cut).replace(/[.,]/g, "");
    const frac = s.slice(cut + 1);
    if (!/^\d*$/.test(frac)) return null;
    normalized = `${inteiro || "0"}.${frac}`;
  }

  const n = Number(normalized);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Centavos → "249,90 MTn". Para eco na tela do que foi entendido. */
export function formatCentsMZN(cents: number): string {
  return (cents / 100).toLocaleString("pt-MZ", { style: "currency", currency: "MZN" });
}

/**
 * Centavos de DÓLAR → "US$ 249,90". Para todo número que sai de
 * `llm_calls.cost_cents` / `ai_invocations.cost_cents`.
 *
 * ⚠️ EXISTE PORQUE O NÚMERO É DÓLAR E SETE TELAS O ESCREVIAM EM REAL.
 * `lib/agent-engine/edge/llm/pricing.ts` cota o provedor em USD e grava centavo
 * de USD; formatar em BRL fazia o dono do negócio ler um valor ~5x menor do que
 * o que estava sendo cobrado dele — e, depois que o teto passou a vincular,
 * armar um limite ~5x maior do que pensava. A conversão de moeda NÃO é feita
 * (exigiria fonte de câmbio, dependência externa nova num produto self-host):
 * o que muda é o rótulo dizer a unidade real.
 *
 * Vírgula decimal porque a frase é pt-PT; "US$" porque a moeda é dólar. É a
 * mesma escolha de `emDolares` em `lib/agent-engine/edge/llm/orcamento.ts` —
 * mas ali ela não pode importar daqui (o módulo é do engine e roda no worker).
 */
export function formatCentsUSD(cents: number): string {
  return ((cents ?? 0) / 100).toLocaleString("pt-PT", { style: "currency", currency: "USD" });
}
