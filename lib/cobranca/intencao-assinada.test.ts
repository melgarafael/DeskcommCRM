import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { criarIntencaoDeContratacao, verificarIntencaoDeContratacao, VALIDADE_DA_INTENCAO_MS } from "./intencao-assinada";
const U = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222";
const OUTRO = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-10-27T12:00:00Z");
beforeEach(() => vi.stubEnv("INTERNAL_SECRET", "segredo-controlado-so-para-qa"));
afterEach(() => vi.unstubAllEnvs());
describe("a intenção que autoriza continuação automática", () => {
  it("recibo válido permanece ligado à pessoa, plano e nonce", () => {
    const p = criarIntencaoDeContratacao(U, P, NOW)!;
    expect(verificarIntencaoDeContratacao(p, U, P, NOW + 1)).toEqual(p);
    expect(verificarIntencaoDeContratacao({ ...p }, U, P, NOW + 1)?.nonce).toBe(p.nonce);
  });
  it.each([
    { usuario_id: OUTRO }, { organization_id: OUTRO }, { plano_id: OUTRO }, { nonce: OUTRO },
    { emitida_em: NOW + 1 }, { expira_em: NOW + VALIDADE_DA_INTENCAO_MS + 1 },
    { assinatura: "0".repeat(64) }, { versao: 2 },
  ])("INSERT de audit adulterado não autoriza (%j)", delta => {
    expect(verificarIntencaoDeContratacao({ ...criarIntencaoDeContratacao(U, P, NOW), ...delta }, U, P, NOW + 10)).toBeNull();
  });
  it("não transfere autorização entre usuários ou planos", () => {
    const p = criarIntencaoDeContratacao(U, P, NOW);
    expect(verificarIntencaoDeContratacao(p, OUTRO, P, NOW)).toBeNull();
    expect(verificarIntencaoDeContratacao(p, U, OUTRO, NOW)).toBeNull();
  });
  it("futuro, expiração e outro segredo fecham sem lançar", () => {
    const p = criarIntencaoDeContratacao(U, P, NOW);
    expect(verificarIntencaoDeContratacao(p, U, P, NOW - 1)).toBeNull();
    expect(verificarIntencaoDeContratacao(p, U, P, NOW + VALIDADE_DA_INTENCAO_MS + 1)).toBeNull();
    expect(verificarIntencaoDeContratacao(p, U, P, NOW, "outra-chave")).toBeNull();
  });
  it.each([null, "texto", {}, { versao: 1, assinatura: "x" }])("recibo malformado (%j) não concede autoridade", v => {
    expect(verificarIntencaoDeContratacao(v, U, P, NOW)).toBeNull();
  });
  it("não há segredo público ou chave de fallback", () => {
    const p = criarIntencaoDeContratacao(U, P, NOW);
    vi.stubEnv("INTERNAL_SECRET", "");
    expect(criarIntencaoDeContratacao(U, P, NOW)).toBeNull();
    expect(verificarIntencaoDeContratacao(p, U, P, NOW)).toBeNull();
  });
});
