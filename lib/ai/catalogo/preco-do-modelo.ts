/**
 * O PREÇO DO MODELO, NA FORMA EM QUE UM LEIGO COMPARA.
 *
 * `ai_models.*_price_per_million_cents` guarda CENTAVOS DE DÓLAR por MILHÃO de
 * tokens (a OpenRouter publica dólares por token; `precoParaCentavosPorMilhao`
 * em `openrouter.ts` converte e arredonda para cima). Na tela vira dólares por
 * milhão — `10` é "US$ 0,10", não "10".
 *
 * Os dois extremos NÃO são a mesma coisa, e a tela não os pode misturar
 * (mesma regra de `lib/ai/runtime/cost.ts`):
 *   - `0`    é gratuito DE VERDADE (a catalogação grava 0 de propósito);
 *   - `null` é preço DESCONHECIDO — nunca "de graça".
 */
export function formatarDolaresPorMilhao(
  centavos: number | null | undefined,
  idioma: string,
): string | null {
  if (centavos == null || !Number.isFinite(centavos) || centavos < 0) return null;
  return new Intl.NumberFormat(idioma, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(centavos / 100);
}
