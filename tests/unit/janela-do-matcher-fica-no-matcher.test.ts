/**
 * A janela de mensagens do matcher de skill (@vgamkt, #1130) fica NO matcher.
 *
 * `recentInboundSignal` junta as últimas inbound para a skill não "cair" quando o
 * cliente responde só a escolha ("A 2025"). O `skillSignal` do turno, porém,
 * também alimenta o classificador de jailbreak e os candidatos de divergência de
 * estágio. Trocar o `skillSignal` inteiro pela janela fazia uma tentativa de
 * jailbreak de cinco mensagens atrás seguir marcando todo turno seguinte.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

describe("janela do matcher de skill", () => {
  it("o matcher lê a janela", () => {
    expect(FONTE).toMatch(/const sinalDoMatcher = recentInboundSignal\(effectiveContext\.messages\);/);
    expect(FONTE).toMatch(/matchSkills\(skills, sinalDoMatcher\)/);
  });

  it("o resto do turno segue lendo a ÚLTIMA inbound", () => {
    expect(FONTE).toMatch(/const skillSignal = latestInboundSignal\(effectiveContext\.messages\);/);
    const jailbreak = FONTE.slice(FONTE.indexOf("classifyJailbreak("));
    expect(jailbreak).toMatch(/^[\s\S]{0,400}?message: skillSignal,/);
  });
});
