import { describe, expect, it } from "vitest";

import { clientePelaAgendaLigado } from "@/lib/schemas/settings";

/**
 * A régua TypeScript de "a regra cliente pela agenda está ligada?".
 *
 * Tem de ser IDÊNTICA à do banco — `settings->'crm'->'cliente_pela_agenda' =
 * 'true'::jsonb` em `fn_marcar_contato_como_cliente` (migration 0262): só o
 * booleano `true` liga. Se a tela aceitasse a string `"true"`, mostraria o selo
 * "Cliente" de uma regra que o trigger não aplica — e a data exibida estaria
 * congelada. E nunca lança: o layout de `/app` chama isto a cada render.
 */
describe("clientePelaAgendaLigado", () => {
  it.each([
    ["settings ausente", undefined],
    ["settings nulo", null],
    ["settings vazio", {}],
    ["crm nulo", { crm: null }],
    ["crm array", { crm: [] }],
    ["crm string", { crm: "ligado" }],
    ["chave ausente", { crm: {} }],
    ["false", { crm: { cliente_pela_agenda: false } }],
    ["string 'true'", { crm: { cliente_pela_agenda: "true" } }],
    ["número 1", { crm: { cliente_pela_agenda: 1 } }],
    ["settings array", [{ crm: { cliente_pela_agenda: true } }]],
  ])("%s → desligado", (_nome, settings) => {
    expect(clientePelaAgendaLigado(settings)).toBe(false);
  });

  it("só o booleano true liga, e o resto de settings não interfere", () => {
    expect(clientePelaAgendaLigado({ crm: { cliente_pela_agenda: true } })).toBe(true);
    expect(
      clientePelaAgendaLigado({
        visibility_mode: "all",
        agenda: { confirmation_delay_minutes: 10 },
        crm: { cliente_pela_agenda: true, outra: "coisa" },
      }),
    ).toBe(true);
  });
});
