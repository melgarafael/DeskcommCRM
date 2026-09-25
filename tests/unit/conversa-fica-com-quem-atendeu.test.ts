import { describe, expect, it } from "vitest";

import {
  atendimentoConfigPatchSchema,
  conversaFicaComQuemAtendeu,
  mesclarSettingsDeAtendimento,
  routingConfigSchema,
} from "@/lib/schemas/routing";

/**
 * "A conversa fica com quem atendeu" (ideia de @gustavorodcruz96, #1527): ajuste
 * por empresa, DESLIGADO por padrão. O banco (`fn_service_inbound`, migration
 * 0396) lê o mesmo caminho com a mesma régua — só o booleano `true` liga.
 */
describe("conversaFicaComQuemAtendeu", () => {
  it.each([
    ["settings ausente", null],
    ["settings sem routing", {}],
    ["routing sem a chave", { routing: { mode: "manual" } }],
    ["false", { routing: { conversation_stays_with_attendant: false } }],
    ["texto \"true\"", { routing: { conversation_stays_with_attendant: "true" } }],
    ["1", { routing: { conversation_stays_with_attendant: 1 } }],
  ])("desligado com %s", (_nome, settings) => {
    expect(conversaFicaComQuemAtendeu(settings)).toBe(false);
  });

  it("liga só com o booleano true em settings.routing", () => {
    expect(
      conversaFicaComQuemAtendeu({ routing: { conversation_stays_with_attendant: true } }),
    ).toBe(true);
  });

  it("o padrão do schema é desligado", () => {
    expect(routingConfigSchema.parse({}).conversation_stays_with_attendant).toBe(false);
  });
});

describe("mesclarSettingsDeAtendimento preserva o ajuste", () => {
  const ligado = { routing: { ...routingConfigSchema.parse({}), conversation_stays_with_attendant: true } };

  it("cliente antigo que não manda a chave não desliga o ajuste por omissão", () => {
    const input = atendimentoConfigPatchSchema.parse({ mode: "round_robin" });
    const { settings } = mesclarSettingsDeAtendimento(ligado, input);
    expect(conversaFicaComQuemAtendeu(settings)).toBe(true);
  });

  it("mandar false desliga, mandar true liga", () => {
    const off = mesclarSettingsDeAtendimento(
      ligado,
      atendimentoConfigPatchSchema.parse({ mode: "manual", conversation_stays_with_attendant: false }),
    );
    expect(conversaFicaComQuemAtendeu(off.settings)).toBe(false);
    const on = mesclarSettingsDeAtendimento(
      {},
      atendimentoConfigPatchSchema.parse({ mode: "manual", conversation_stays_with_attendant: true }),
    );
    expect(conversaFicaComQuemAtendeu(on.settings)).toBe(true);
  });

  it("empresa que nunca mexeu continua desligada depois de salvar outra coisa", () => {
    const { settings } = mesclarSettingsDeAtendimento(
      {},
      atendimentoConfigPatchSchema.parse({ mode: "manual" }),
    );
    expect(conversaFicaComQuemAtendeu(settings)).toBe(false);
  });
});
