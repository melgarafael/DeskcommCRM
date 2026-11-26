/**
 * TETO DE RESPOSTAS DA IA PARA VISITANTE ANÔNIMO — seam de canais (F4, Task 1).
 *
 * Apenas o seam de canais (`lib/channels/`) sabe se o provedor tem teto de anônimo
 * e quanto vale. O gate e os loaders NÃO nomeiam provedor (`pnpm lint:channels`):
 * perguntam a `tetoDoAnonimoDoCanal`.
 *
 * Casos do plano (Step 1):
 *  - canal de chat sem config → 20 (padrão)
 *  - 1 e 200 → aceitos
 *  - 0, 201, texto, fracionário → 20 (nunca "sem teto")
 *  - outro provedor → null (não se aplica)
 */
import { describe, expect, it } from "vitest";

import { tetoDoAnonimoDoCanal } from "./teto-do-anonimo";

describe("tetoDoAnonimoDoCanal", () => {
  it("canal de chat sem config → padrão 20", () => {
    expect(tetoDoAnonimoDoCanal("webchat", {})).toBe(20);
    expect(tetoDoAnonimoDoCanal("webchat", null)).toBe(20);
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: {} })).toBe(20);
  });

  it("canal de chat com teto válido → esse valor", () => {
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: { teto_anonimo: 1 } })).toBe(1);
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: { teto_anonimo: 200 } })).toBe(200);
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: { teto_anonimo: 42 } })).toBe(42);
  });

  it("valor fora de 1–200 → padrão 20 (nunca 'sem teto')", () => {
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: { teto_anonimo: 0 } })).toBe(20);
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: { teto_anonimo: 201 } })).toBe(20);
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: { teto_anonimo: -5 } })).toBe(20);
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: { teto_anonimo: 1.5 } })).toBe(20);
  });

  it("texto ou fracionário → padrão 20", () => {
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: { teto_anonimo: "vinte" } })).toBe(20);
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: { teto_anonimo: "abc" } })).toBe(20);
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: { teto_anonimo: NaN } })).toBe(20);
  });

  it("outro provedor → null (não se aplica)", () => {
    expect(tetoDoAnonimoDoCanal("whatsapp", { webchat: { teto_anonimo: 5 } })).toBeNull();
    expect(tetoDoAnonimoDoCanal("telegram", { webchat: { teto_anonimo: 5 } })).toBeNull();
    expect(tetoDoAnonimoDoCanal("instagram", { webchat: { teto_anonimo: 5 } })).toBeNull();
    expect(tetoDoAnonimoDoCanal("meta_cloud", { webchat: { teto_anonimo: 5 } })).toBeNull();
    expect(tetoDoAnonimoDoCanal("webchat", { webchat: { teto_anonimo: 5 } })).not.toBeNull();
  });
});
