import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import { recusouMarketing } from "@/lib/campanhas/elegibilidade";
import { recusaRegistrada } from "@/lib/lgpd/recusa-registrada";
import { contactMayBeProspected } from "@/lib/prospecting/guard";

/**
 * A RECUSA NOS DOIS FORMATOS: `declined_at` (a captação) e `granted: false` (a ficha).
 *
 * A régua é uma só (`lib/lgpd/recusa-registrada.ts`), e as quatro guardas de envio a chamam: a da automação, a da ação
 * de e-mail, a elegibilidade das campanhas e a guarda da prospecção. O caminho inteiro contra Postgres real (a ficha grava,
 * o motor monta o contato, a guarda decide) está em `tests/invariants/recusa-da-ficha-bloqueia-o-envio.test.ts`.
 */
const RAIZ = process.cwd();
const LEITORES = [
  "lib/automation/guarda-do-contato.ts",
  "lib/automation/actions/send-email.ts",
  "lib/campanhas/elegibilidade.ts",
  "lib/prospecting/guard.ts",
];

describe("a régua", () => {
  it.each([
    ["`declined_at` da captação", { marketing: { granted_at: null, declined_at: "2026-11-08T10:00:00.000Z" } }, true],
    ["`granted: false` da ficha", { marketing: { granted: false, granted_at: null } }, true],
    ["`granted: true`", { marketing: { granted: true, granted_at: "2026-01-01T00:00:00Z" } }, false],
    ["o default da coluna (ninguém perguntou)", { marketing: { granted_at: null, source: null, version: null } }, false],
    ["`granted: null`", { marketing: { granted: null } }, false],
    ["`declined_at` vazio", { marketing: { declined_at: "" } }, false],
    ["sem a finalidade", { transactional: { granted: false } }, false],
    ["consentimento nulo", null, false],
    ["consentimento que não é objeto", "recusado", false],
  ] as const)("%s → %s", (_r, consent, esperado) => {
    expect(recusaRegistrada(consent)).toBe(esperado);
  });

  it("a finalidade é a que se pergunta", () => {
    expect(recusaRegistrada({ transactional: { granted: false } }, "transactional")).toBe(true);
    expect(recusaRegistrada({ marketing: { granted: false } }, "transactional")).toBe(false);
  });
});

describe("as guardas de envio leem a recusa da ficha", () => {
  const DA_FICHA = { marketing: { granted: false, granted_at: null } };

  it("a da automação (WhatsApp, mensagem da IA, fluxo de mensagens)", () => {
    const contato = { id: "c1", is_blocked: false, phone_number: "+5511900000001" };
    expect(checarGuardasDeContato({ context: { contact: { ...contato, consent: DA_FICHA } } } as never)).toEqual({
      ok: false,
      reason: "consent_declined",
    });
    expect(checarGuardasDeContato({ context: { contact: { ...contato, consent: { marketing: { granted: true } } } } } as never).ok).toBe(true);
  });

  it("a elegibilidade das campanhas", () => {
    expect(recusouMarketing(DA_FICHA)).toBe(true);
    expect(recusouMarketing({ marketing: { granted: true } })).toBe(false);
  });

  it("a guarda da prospecção", () => {
    const base = { is_blocked: false, force_human: false, is_anonymized: false, source: "prospecting" };
    const comBase = { legitimate_interest: { ref: "base-legal-teste" } };
    expect(contactMayBeProspected({ ...base, consent: comBase }), "controle: sem recusa, a base legal deixa prospectar").toBe(true);
    expect(contactMayBeProspected({ ...base, consent: { ...comBase, ...DA_FICHA } })).toBe(false);
  });

  it("nenhuma das quatro lê `declined_at` direto (a régua é uma só) — e todas chamam `recusaRegistrada`", () => {
    for (const arquivo of LEITORES) {
      const codigo = readFileSync(join(RAIZ, arquivo), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n");
      expect(codigo, arquivo).not.toMatch(/declined_at/);
      expect(codigo, arquivo).toMatch(/recusaRegistrada\(/);
    }
  });
});
