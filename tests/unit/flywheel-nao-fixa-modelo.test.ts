import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Os dois pontos do flywheel (`flywheel_judge` e `flywheel_distiller`) não podem
 * fixar id de modelo no código.
 *
 * Fixavam `claude-haiku-4-5`, e id de modelo só vale no vocabulário do provedor
 * que a instalação usa: numa VPS com a org apontada para OpenRouter o provedor
 * devolvia 400 `claude-haiku-4-5 is not a valid model ID` e a rodada agendada
 * morria a cada disparo — medido em produção em 2026-09-05. Sem `model`, o ponto
 * resolve pela cadeia normal (painel de provedores, senão o padrão da org), que é
 * a que faz todos os outros pontos funcionarem naquela mesma instalação.
 */
describe("flywheel vivo", () => {
  const fonte = readFileSync(
    resolve(process.cwd(), "lib/agent-engine/flywheel/live.ts"),
    "utf-8",
  );

  it("não passa modelo fixo para runModelCall", () => {
    const dentroDeChamada = fonte.match(/^\s*model:\s*.+$/gm) ?? [];
    expect(dentroDeChamada).toEqual([]);
  });

  it("grava no veredito o provedor e o modelo que a chamada realmente usou", () => {
    expect(fonte).toContain("judgedCall.provider");
    expect(fonte).toContain("judgedCall.model");
  });
});
