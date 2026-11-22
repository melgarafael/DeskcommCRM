/**
 * Ponte postMessage (Spec 33, F4, tarefa 2): cada recusa e cada aceitação.
 */
import { describe, expect, it } from "vitest";

import {
  lerMensagemDoModulo,
  MENSAGENS_DO_MODULO,
  MENSAGENS_PARA_O_MODULO,
  mensagemParaOModulo,
  type MensagemParaOModulo,
} from "./ponte";

const ORIGEM = "https://modulo.exemplo.com";
const janela = { id: "janela-do-iframe" };
const esperado = { origin: ORIGEM, janela };

function ler(data: unknown, over: { origin?: string; source?: unknown } = {}) {
  return lerMensagemDoModulo(
    { origin: over.origin ?? ORIGEM, source: "source" in over ? over.source : janela, data },
    esperado,
  );
}

describe("lista fechada", () => {
  it("tem 3 mensagens de cada lado", () => {
    expect(MENSAGENS_DO_MODULO).toHaveLength(3);
    expect(MENSAGENS_PARA_O_MODULO).toHaveLength(3);
  });
});

describe("lerMensagemDoModulo — aceita", () => {
  it("module:ready", () => {
    expect(ler({ type: "module:ready" })).toEqual({ type: "module:ready" });
  });
  it("module:request-jwt", () => {
    expect(ler({ type: "module:request-jwt" })).toEqual({ type: "module:request-jwt" });
  });
  it("module:navigate com id válido", () => {
    expect(ler({ type: "module:navigate", destination: "crm_leads-2" })).toEqual({
      type: "module:navigate",
      destination: "crm_leads-2",
    });
  });
  it("destination com exatamente 64 caracteres", () => {
    const d = "a".repeat(64);
    expect(ler({ type: "module:navigate", destination: d })).not.toBeNull();
  });
});

describe("lerMensagemDoModulo — recusa", () => {
  it("origem diferente", () => {
    expect(ler({ type: "module:ready" }, { origin: "https://outro.exemplo.com" })).toBeNull();
  });
  it("origem 'null'", () => {
    expect(ler({ type: "module:ready" }, { origin: "null" })).toBeNull();
  });
  it("mesma origem, mas outra janela", () => {
    expect(ler({ type: "module:ready" }, { source: { id: "outra" } })).toBeNull();
  });
  it("source nulo", () => {
    expect(ler({ type: "module:ready" }, { source: null })).toBeNull();
  });
  it("janela esperada ausente não casa com source nulo", () => {
    expect(
      lerMensagemDoModulo(
        { origin: ORIGEM, source: null, data: { type: "module:ready" } },
        { origin: ORIGEM, janela: null },
      ),
    ).toBeNull();
  });
  it("origem esperada vazia", () => {
    expect(
      lerMensagemDoModulo(
        { origin: "", source: janela, data: { type: "module:ready" } },
        { origin: "", janela },
      ),
    ).toBeNull();
  });
  it("tipo fora da lista", () => {
    expect(ler({ type: "module:resize" })).toBeNull();
  });
  it("mensagem do host não vale vinda do módulo", () => {
    expect(ler({ type: "host:error", code: "not_allowed" })).toBeNull();
  });
  it("campo extra", () => {
    expect(ler({ type: "module:ready", extra: 1 })).toBeNull();
    expect(ler({ type: "module:navigate", destination: "crm", href: "/app" })).toBeNull();
  });
  it("navigate sem destination", () => {
    expect(ler({ type: "module:navigate" })).toBeNull();
  });
  it("navigate com href no lugar do id", () => {
    expect(ler({ type: "module:navigate", href: "/app/inbox" })).toBeNull();
  });
  it("destination com mais de 64 caracteres", () => {
    expect(ler({ type: "module:navigate", destination: "a".repeat(65) })).toBeNull();
  });
  it.each(["/app", "a/b", "a:b", "a.b", "a b", "javascript:alert(1)", "A", "", "é"])(
    "destination inválido %j",
    (d) => {
      expect(ler({ type: "module:navigate", destination: d })).toBeNull();
    },
  );
  it("destination que não é texto", () => {
    expect(ler({ type: "module:navigate", destination: 1 })).toBeNull();
  });
  it.each([null, undefined, "module:ready", 42, true, ["module:ready"]])(
    "dado que não é objeto: %j",
    (d) => {
      expect(ler(d)).toBeNull();
    },
  );
});

describe("mensagemParaOModulo — aceita", () => {
  it("host:context", () => {
    const m: MensagemParaOModulo = {
      type: "host:context",
      path: "/app/m/comanda",
      locale: "pt-BR",
      theme: "dark",
      brand: { name: "Minha Marca", primary_color: "#112233" },
    };
    expect(JSON.parse(mensagemParaOModulo(m))).toEqual(m);
  });
  it("host:context com marca só com nome", () => {
    const m: MensagemParaOModulo = {
      type: "host:context",
      path: "/",
      locale: "en",
      theme: "light",
      brand: { name: "X" },
    };
    expect(JSON.parse(mensagemParaOModulo(m))).toEqual(m);
  });
  it("host:jwt", () => {
    const m: MensagemParaOModulo = {
      type: "host:jwt",
      jwt: "a.b.c",
      expires_at: "2026-11-05T12:00:00Z",
    };
    expect(JSON.parse(mensagemParaOModulo(m))).toEqual(m);
  });
  it.each(["rate_limited", "jwt_unavailable", "not_allowed", "context_invalid"] as const)(
    "host:error %s",
    (code) => {
      expect(JSON.parse(mensagemParaOModulo({ type: "host:error", code }))).toEqual({
        type: "host:error",
        code,
      });
    },
  );
});

describe("mensagemParaOModulo — lança", () => {
  const base = {
    type: "host:context",
    path: "/a",
    locale: "pt-BR",
    theme: "light",
    brand: { name: "M" },
  };
  const lanca = (m: unknown) => () => mensagemParaOModulo(m as MensagemParaOModulo);

  it("acima de 8 KB", () => {
    expect(
      lanca({ type: "host:jwt", jwt: "x".repeat(9000), expires_at: "2026-11-05T12:00:00Z" }),
    ).toThrow(/8 KB/);
  });
  it("path que não começa com /", () => {
    expect(lanca({ ...base, path: "app" })).toThrow();
  });
  it("path com mais de 512 caracteres", () => {
    expect(lanca({ ...base, path: "/" + "a".repeat(512) })).toThrow();
  });
  it("path com exatamente 512 caracteres passa", () => {
    expect(lanca({ ...base, path: "/" + "a".repeat(511) })).not.toThrow();
  });
  it("theme fora de light|dark", () => {
    expect(lanca({ ...base, theme: "sepia" })).toThrow();
  });
  it("marca com URL de imagem (campo extra)", () => {
    expect(lanca({ ...base, brand: { name: "M", logo_url: "https://x/y.png" } })).toThrow();
  });
  it("marca com nome acima de 80", () => {
    expect(lanca({ ...base, brand: { name: "m".repeat(81) } })).toThrow();
  });
  it("cor primária acima de 32", () => {
    expect(lanca({ ...base, brand: { name: "M", primary_color: "c".repeat(33) } })).toThrow();
  });
  it("código de erro fora da lista", () => {
    expect(lanca({ type: "host:error", code: "boom" })).toThrow();
  });
  it("tipo fora da lista", () => {
    expect(lanca({ type: "host:resize" })).toThrow();
  });
  it("campo extra", () => {
    expect(lanca({ type: "host:error", code: "not_allowed", extra: 1 })).toThrow();
  });
  it("mensagem de módulo não sai pelo host", () => {
    expect(lanca({ type: "module:ready" })).toThrow();
  });
});
