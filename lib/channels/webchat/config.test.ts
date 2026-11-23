/**
 * `configuracaoDoChatSchema` aceita a pausa do chat (`pausado`), booleana (F2, Task 7).
 */
import { describe, expect, it, vi } from "vitest";

import { configuracaoDoChatSchema } from "@/lib/channels/webchat/config";

vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.example.com" } }));
vi.mock("@/lib/webhooks/url-publica", () => ({ enderecoDaPropriaMaquina: () => false }));

describe("configuracaoDoChatSchema: pausado", () => {
  it("aceita pausado verdadeiro e falso", () => {
    expect(configuracaoDoChatSchema.safeParse({ pausado: true }).success).toBe(true);
    expect(configuracaoDoChatSchema.safeParse({ pausado: false }).success).toBe(true);
  });

  it("recusa pausado que não é booleano", () => {
    expect(configuracaoDoChatSchema.safeParse({ pausado: "sim" }).success).toBe(false);
    expect(configuracaoDoChatSchema.safeParse({ pausado: 1 }).success).toBe(false);
  });

  it("pausado é opcional: a configuração sem ele continua válida", () => {
    expect(configuracaoDoChatSchema.safeParse({ titulo: "Oi" }).success).toBe(true);
  });
});

describe("configuracaoDoChatSchema: formato e posicao", () => {
  it("aceita formato e posicao validos", () => {
    expect(
      configuracaoDoChatSchema.safeParse({ formato: "painel", posicao: "esquerda" }).success,
    ).toBe(true);
  });

  it("aceita somente formato", () => {
    expect(configuracaoDoChatSchema.safeParse({ formato: "pagina" }).success).toBe(true);
  });

  it("aceita somente posicao", () => {
    expect(configuracaoDoChatSchema.safeParse({ posicao: "esquerda" }).success).toBe(true);
  });

  it("recusa formato fora da lista", () => {
    expect(configuracaoDoChatSchema.safeParse({ formato: "invalido" }).success).toBe(false);
  });

  it("recusa posicao fora da lista", () => {
    expect(configuracaoDoChatSchema.safeParse({ posicao: "centro" }).success).toBe(false);
  });

  it("formato e posicao sao opcionais: ausente continua valido", () => {
    expect(configuracaoDoChatSchema.safeParse({ pausado: true }).success).toBe(true);
  });
});
