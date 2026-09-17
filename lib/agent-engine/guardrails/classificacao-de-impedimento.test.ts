import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BEFORE_SEND_GATES } from "./before-send";
import {
  BEFORE_SEND_GATES_DE_ENTREGA,
  BEFORE_SEND_GATES_DE_SEGURANCA,
  classeDoImpedimento,
  mensagemSanitizadaDoImpedimento,
} from "./classificacao-de-impedimento";
import { PACING_DEFAULTS } from "../pacing/defaults";

describe("classificação de impedimento do ensaio", () => {
  it("entrega e segurança particionam a cadeia inteira, sem overlap", () => {
    const entrega = BEFORE_SEND_GATES_DE_ENTREGA.map((g) => g.name);
    const seguranca = BEFORE_SEND_GATES_DE_SEGURANCA.map((g) => g.name);
    expect(new Set(entrega).size).toBe(entrega.length);
    expect(new Set(seguranca).size).toBe(seguranca.length);
    expect(entrega.filter((n) => seguranca.includes(n))).toEqual([]);
    expect([...entrega, ...seguranca].sort()).toEqual(
      BEFORE_SEND_GATES.map((g) => g.name).slice().sort(),
    );
    expect(entrega.sort()).toEqual(["messaging_window", "pacing", "spinning"].sort());
    expect(seguranca[0]).toBe("stop");
  });

  it("códigos operacionais são entrega; STOP/LGPD/vazamento são segurança", () => {
    expect(classeDoImpedimento("outside_window", "pacing")).toBe("entrega");
    expect(classeDoImpedimento("warmup_cap", "pacing")).toBe("entrega");
    expect(classeDoImpedimento("daily_cap", "pacing")).toBe("entrega");
    expect(classeDoImpedimento("messaging_window_closed", "messaging_window")).toBe("entrega");
    expect(classeDoImpedimento("mass_identical", "spinning")).toBe("entrega");
    expect(classeDoImpedimento("contato_bloqueado", "stop")).toBe("seguranca");
    expect(classeDoImpedimento("lgpd_anonymized", "lgpd")).toBe("seguranca");
    expect(classeDoImpedimento("internal_vocabulary_leak", "internal_vocabulary")).toBe(
      "seguranca",
    );
    expect(classeDoImpedimento("promise_out_of_table", "promise")).toBe("seguranca");
    expect(classeDoImpedimento("disclosure_required", "disclosure")).toBe("seguranca");
  });

  it("mensagem de janela usa os knobs sem alterar PACING_DEFAULTS", () => {
    expect(PACING_DEFAULTS.windowStartHour).toBe(7);
    expect(PACING_DEFAULTS.windowEndHour).toBe(22);
    expect(PACING_DEFAULTS.timezone).toBe("America/Sao_Paulo");
    expect(
      mensagemSanitizadaDoImpedimento("outside_window", "entrega", {
        start: PACING_DEFAULTS.windowStartHour,
        end: PACING_DEFAULTS.windowEndHour,
      }),
    ).toBe("Fora da janela de envio 7h–22h");
    expect(mensagemSanitizadaDoImpedimento("contato_bloqueado", "seguranca")).toBe(
      "O contato pediu para não receber mensagens",
    );
    expect(mensagemSanitizadaDoImpedimento("internal_vocabulary_leak", "seguranca")).toBe(
      "A resposta usaria palavras internas",
    );
  });

  it("atendimento real continua com a cadeia inteira; o recorte só existe no ensaio", () => {
    const inbound = readFileSync(
      join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
      "utf8",
    );
    const preview = readFileSync(join(process.cwd(), "lib/agent-engine/agent/preview.ts"), "utf8");
    expect(inbound).toMatch(/let chain = await runBeforeSend\(beforeSendArgs\)/);
    expect(inbound).not.toContain("BEFORE_SEND_GATES_DE_ENTREGA");
    expect(inbound).not.toContain("BEFORE_SEND_GATES_DE_SEGURANCA");
    expect(preview).toContain("BEFORE_SEND_GATES_DE_SEGURANCA");
    expect(preview).toContain("BEFORE_SEND_GATES_DE_ENTREGA");
  });
});
