/**
 * NENHUMA CHAVE DE PROVEDOR CHEGA À TELA NEM À TELEMETRIA.
 *
 * `llm_calls.error_message` é lido pela tela de Execuções, e o texto de erro de
 * um provedor às vezes ecoa o que recebeu — inclusive o cabeçalho com a chave.
 * Dois redatores se somam: `redigirMensagemDoProvedor` (segredo) e
 * `scrubMessage` (dado do titular, e também o que vai ao Sentry e ao Jev).
 *
 * A chave do Jev (`apikey_<hex>_<hex>`) não tem `sk-` nem vem sempre depois de
 * `Bearer`, então nenhum padrão antigo a pegava solta.
 *
 * Os casos de `sk-`/`AIza`/`Bearer` estão aqui porque ESCREVER o caso do Jev
 * revelou que os quatro padrões antigos nunca casaram: o arquivo tinha o byte
 * de backspace (0x08) onde devia estar `\b`, e o regex exigia um backspace
 * antes da chave. Nenhum teste os exercitava.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as ScrubReal from "@/lib/sentry/scrub";

// O `scrubMessage` é o REAL, com um interruptor para desligá-lo: os dois
// redatores se somam, e com os dois ligados um padrão apagado de
// `redigirMensagemDoProvedor` passaria despercebido, porque o outro cobre.
const scrub = vi.hoisted(() => ({ desligado: false }));
vi.mock("@/lib/sentry/scrub", async (importOriginal) => {
  const real = await importOriginal<typeof ScrubReal>();
  return { ...real, scrubMessage: (s: string) => (scrub.desligado ? s : real.scrubMessage(s)) };
});

import { normalizarErro, redigirMensagemDoProvedor } from "@/lib/agent-engine/edge/llm/run-model-call";
import { scrubMessage } from "@/lib/sentry/scrub";

afterEach(() => {
  scrub.desligado = false;
});

// Formato real (prefixo + 36 hex + 64 hex), valores inventados.
const CHAVE_DO_JEV = `apikey_${"a1b2c3d4".repeat(4)}abcd_${"0f1e2d3c".repeat(8)}`;

describe("a chave do Jev é redigida", () => {
  it("num erro que ecoa a chave, a mensagem gravada não a contém", () => {
    const erro = Object.assign(new Error(`invalid api key: ${CHAVE_DO_JEV} (request 42)`), { status: 401 });
    const { error_message, error_code } = normalizarErro(erro);
    expect(error_message).not.toContain(CHAVE_DO_JEV);
    expect(error_message).not.toMatch(/0f1e2d3c/);
    expect(error_message).toContain("[CHAVE]");
    expect(error_code).toBe("credencial_recusada");
  });

  it("o redator de telemetria também a apaga inteira, sem deixar pedaço numérico", () => {
    const saida = scrubMessage(`falhou com ${CHAVE_DO_JEV}`);
    expect(saida).toBe("falhou com [CHAVE]");
  });

  it("o redator de SEGREDO a apaga sozinho, sem o scrub por trás", () => {
    scrub.desligado = true;
    const saida = redigirMensagemDoProvedor(`invalid api key: ${CHAVE_DO_JEV} (request 42)`);
    expect(saida).toBe("invalid api key: [CHAVE] (request 42)");
  });

  it("texto comum com a palavra apikey não é tocado", () => {
    expect(scrubMessage("faltou a apikey_ no cabeçalho")).toBe("faltou a apikey_ no cabeçalho");
  });
});

describe("as chaves dos outros provedores também", () => {
  it.each([
    ["Anthropic", "sk-ant-api03-AbCdEfGhIjKlMnOp"],
    ["OpenRouter", "sk-or-v1-0123456789abcdef"],
    ["Google", "AIzaSyA-0123456789abcdefgh"],
  ])("%s solta no texto", (_nome, chave) => {
    const saida = redigirMensagemDoProvedor(`chave recusada: ${chave}`);
    expect(saida).not.toContain(chave);
    expect(saida).toContain("[CHAVE]");
  });

  it.each([
    ["Authorization: Bearer tok_abcdefghijklmnop"],
    ["bearer tok_abcdefghijklmnop"],
    ["x-api-key=tok_abcdefghijklmnop"],
  ])("o cabeçalho ecoado: %s", (texto) => {
    // Só letras no token de propósito: com dígitos, o padrão de TELEFONE do
    // `scrubMessage` apagava o trecho e o caso passava sem este redator agir.
    const saida = redigirMensagemDoProvedor(texto);
    expect(saida).not.toContain("tok_abcdefghijklmnop");
  });
});
