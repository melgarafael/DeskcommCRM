/**
 * O PREÇO POR CARACTERE É O QUE FAZ A VOZ ENTRAR NO TETO.
 *
 * `custoDeVozCents` nunca devolve `null` (ao contrário de `costCents`, que
 * devolve null para modelo desconhecido) porque hoje só existe UM serviço de
 * síntese — ElevenLabs — e sem preço aqui o gasto de voz escaparia do
 * orçamento da organização em silêncio, exatamente o defeito de origem que
 * `lib/agent-engine/edge/llm/credentials.ts` documenta para a camada de chat.
 */
import { describe, expect, it } from "vitest";

import { custoDeVozCents } from "@/lib/agent-engine/edge/llm/pricing";

describe("custoDeVozCents", () => {
  it("zero caracteres custa zero", () => {
    expect(custoDeVozCents(0)).toBe(0);
  });

  it("cresce linearmente com o número de caracteres", () => {
    const c100 = custoDeVozCents(100);
    const c200 = custoDeVozCents(200);
    expect(c200).toBeCloseTo(c100 * 2, 10);
  });

  it("nunca é negativo, mesmo com entrada negativa (defeito de chamador, não de preço)", () => {
    expect(custoDeVozCents(-50)).toBe(0);
  });

  it("é uma fração pequena de cent por caractere — ordem de grandeza plausível", () => {
    // ~600 caracteres (o teto de texto-falavel.ts) não pode custar dólares.
    const centsPara600Chars = custoDeVozCents(600);
    expect(centsPara600Chars).toBeGreaterThan(0);
    expect(centsPara600Chars).toBeLessThan(50); // bem menos que US$0,50
  });
});
