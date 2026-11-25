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

describe("configuracaoDoChatSchema: ajustes da janela (Tarefa 10a)", () => {
  it("aceita avatar_url https", () => {
    expect(
      configuracaoDoChatSchema.safeParse({ avatar_url: "https://example.com/avatar.png" }).success,
    ).toBe(true);
  });

  it("aceita avatar_url com ate 300 caracteres", () => {
    const url = "https://" + "a".repeat(288) + ".com";
    expect(url.length).toBe(300);
    expect(configuracaoDoChatSchema.safeParse({ avatar_url: url }).success).toBe(true);
  });

  it("recusa avatar_url com 301 caracteres", () => {
    const url = "https://" + "a".repeat(289) + ".com";
    expect(url.length).toBe(301);
    expect(configuracaoDoChatSchema.safeParse({ avatar_url: url }).success).toBe(false);
  });

  it("recusa avatar_url http://", () => {
    expect(
      configuracaoDoChatSchema.safeParse({ avatar_url: "http://example.com/a.png" }).success,
    ).toBe(false);
  });

  it("recusa avatar_url javascript:", () => {
    expect(
      configuracaoDoChatSchema.safeParse({ avatar_url: "javascript:alert(1)" }).success,
    ).toBe(false);
  });

  it("recusa avatar_url data:", () => {
    expect(
      configuracaoDoChatSchema.safeParse({ avatar_url: "data:image/png;base64,abc" }).success,
    ).toBe(false);
  });

  it("recusa avatar_url texto que nao e URL", () => {
    expect(configuracaoDoChatSchema.safeParse({ avatar_url: "nao e uma url" }).success).toBe(false);
  });

  it("aceita avatar_url vazio: é o pedido de tirar o avatar", () => {
    expect(configuracaoDoChatSchema.safeParse({ avatar_url: "" }).success).toBe(true);
    expect(configuracaoDoChatSchema.safeParse({ avatar_url: "http://x.com/a.png" }).success).toBe(false);
  });

  it("avatar_url ausente e valido", () => {
    expect(configuracaoDoChatSchema.safeParse({}).success).toBe(true);
  });

  it("aceita auto_abrir_segundos 0 e 120", () => {
    expect(configuracaoDoChatSchema.safeParse({ auto_abrir_segundos: 0 }).success).toBe(true);
    expect(configuracaoDoChatSchema.safeParse({ auto_abrir_segundos: 120 }).success).toBe(true);
  });

  it("recusa auto_abrir_segundos 121, -1 e 1.5", () => {
    expect(configuracaoDoChatSchema.safeParse({ auto_abrir_segundos: 121 }).success).toBe(false);
    expect(configuracaoDoChatSchema.safeParse({ auto_abrir_segundos: -1 }).success).toBe(false);
    expect(configuracaoDoChatSchema.safeParse({ auto_abrir_segundos: 1.5 }).success).toBe(false);
  });

  it("aceita som true e false", () => {
    expect(configuracaoDoChatSchema.safeParse({ som: true }).success).toBe(true);
    expect(configuracaoDoChatSchema.safeParse({ som: false }).success).toBe(true);
  });

  it("som nao booleano e recusado", () => {
    expect(configuracaoDoChatSchema.safeParse({ som: "sim" }).success).toBe(false);
    expect(configuracaoDoChatSchema.safeParse({ som: 1 }).success).toBe(false);
  });

  it("aceita ate 5 respostas rapidas de ate 80 caracteres", () => {
    expect(
      configuracaoDoChatSchema
        .safeParse({ respostas_rapidas: ["Sim", "Nao", "Talvez", "Aguarde", "Obrigado"] })
        .success,
    ).toBe(true);
    expect(
      configuracaoDoChatSchema.safeParse({ respostas_rapidas: ["a".repeat(80)] }).success,
    ).toBe(true);
  });

  it("recusa 6 respostas rapidas", () => {
    expect(
      configuracaoDoChatSchema
        .safeParse({ respostas_rapidas: ["1", "2", "3", "4", "5", "6"] })
        .success,
    ).toBe(false);
  });

  it("recusa resposta rapida com 81 caracteres", () => {
    expect(
      configuracaoDoChatSchema.safeParse({ respostas_rapidas: ["a".repeat(81)] }).success,
    ).toBe(false);
  });

  it("recusa resposta rapida vazia", () => {
    expect(
      configuracaoDoChatSchema.safeParse({ respostas_rapidas: [""] }).success,
    ).toBe(false);
  });

  it("respostas_rapidas ausente e valido", () => {
    expect(configuracaoDoChatSchema.safeParse({}).success).toBe(true);
  });
});
