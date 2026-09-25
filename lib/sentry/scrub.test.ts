import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { scrubMessage, scrubUrl, sentryScrubHooks } from "./scrub";

// Issue #100. O que estes testes travam: com `tracesSampleRate: 1` e sem
// `beforeSendTransaction`/`beforeSendSpan`/`beforeBreadcrumb`, a URL crua saía do
// servidor do self-hoster em 6 campos (transaction, request.url, url.full,
// http.url, url.path, http.target). As rotas de webhook por tenant têm CREDENCIAL
// no path, e na instalação padrão esse token é a credencial inteira da rota,
// porque a exigência de assinatura nasce desligada.

const TOKEN = "wht_9f3a1c8b2e4d6a0f";

describe("scrubUrl", () => {
  it("redige o token das rotas em que ele é credencial, inclusive canal novo", () => {
    for (const path of [
      `/api/v1/webhooks/in/${TOKEN}`,
      `/api/v1/webhooks/canal-qualquer/${TOKEN}`,
      `/team/accept-invite/${TOKEN}`,
    ]) {
      const out = scrubUrl(`https://crm.exemplo.com${path}`);
      expect(out).not.toContain(TOKEN);
      expect(out).toContain("[TOKEN]");
    }
  });

  it("NÃO redige os segmentos [id], que são UUID e servem pra depurar", () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const out = scrubUrl(`https://crm.exemplo.com/api/v1/ai/agents/${uuid}/runs`);
    // Redigir tudo cegamente tornaria o Sentry inútil — o oposto do objetivo.
    expect(out).toContain(uuid);
  });

  it("apaga o VALOR da query preservando a CHAVE", () => {
    const out = scrubUrl("https://crm.exemplo.com/api/v1/leads?cursor=abc123&limit=50");
    expect(out).toContain("cursor=[REDACTED]");
    expect(out).toContain("limit=[REDACTED]");
    expect(out).not.toContain("abc123");
  });

  it("redige query CRUA, sem `?` na frente — é assim que vem em request.query_string", () => {
    // Regressão: a primeira versão exigia `?` ou `&` antes da chave, e a assinatura
    // sobrevivia neste campo. Só apareceu ao rodar o envelope inteiro.
    expect(scrubUrl("sig=ASSINATURA123&t=9")).toBe("sig=[REDACTED]&t=[REDACTED]");
  });

  it("não estraga texto que não é query", () => {
    expect(scrubUrl("GET https://crm.exemplo.com/api/v1/leads")).toBe(
      "GET https://crm.exemplo.com/api/v1/leads",
    );
  });

  it("pega o token mesmo com query junto", () => {
    const out = scrubUrl(`https://crm.exemplo.com/api/v1/webhooks/in/${TOKEN}?sig=deadbeef`);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("deadbeef");
  });
});

describe("scrubMessage", () => {
  it("substitui CPF, telefone e e-mail", () => {
    const out = scrubMessage("falha para 123.456.789-01, +55 11 98765-4321, joao@exemplo.com");
    expect(out).toContain("[CPF]");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("[EMAIL]");
    expect(out).not.toContain("123.456.789-01");
    expect(out).not.toContain("joao@exemplo.com");
  });

  // O mesmo texto vai ao Sentry e ao Jev, e a tela do Jev promete ao admin que
  // o telefone sai apagado. O padrão antigo exigia o DDD colado ao número, sem
  // parênteses: `(11) 98765-4321` e `98765-4321` — os jeitos mais comuns de
  // escrever — saíam inteiros. O critério é o número sumir, não o rótulo: 11
  // dígitos seguidos o padrão de CPF pega antes, e isso também serve.
  it("apaga telefone nos jeitos em que se escreve no Brasil", () => {
    for (const tel of [
      "(11) 98765-4321",
      "(11)98765-4321",
      "(11) 3456-7890",
      "11 98765-4321",
      "11 98765 4321",
      "11987654321",
      "5511987654321",
      "+55 11 98765-4321",
      "+55 (11) 98765-4321",
      "98765-4321",
      "98765 4321",
      "3456-7890",
      "11-98765-4321",
      "11.98765.4321",
      "(11)-98765-4321",
      "98765.4321",
      "(11) 9 8765-4321",
      "+55 (11) 9 8765-4321",
    ]) {
      const out = scrubMessage(`meu zap ${tel}, obrigado`);
      expect(out, tel).not.toMatch(/\d{3}/);
      expect(out, tel).toMatch(/^meu zap .*\[(PHONE|CPF)\], obrigado$/);
    }
  });

  // A tela do Jev promete apagar o CPF. Quem digita rápido não segue a máscara.
  it("apaga CPF com qualquer separador entre os blocos", () => {
    for (const cpf of [
      "123.456.789-09",
      "123 456 789 09",
      "123.456.789.09",
      "123-456-789-09",
      "123.456.789 09",
      "12345678909",
    ]) {
      const out = scrubMessage(`meu cpf ${cpf}, obrigado`);
      expect(out, cpf).not.toMatch(/\d{3}/);
      expect(out, cpf).toMatch(/^meu cpf \[(PHONE|CPF)\], obrigado$/);
    }
  });

  it("dois telefones na mesma frase saem os dois", () => {
    expect(scrubMessage("98765-4321 ou (21) 3456-7890")).toBe("[PHONE] ou [PHONE]");
  });

  it("o número colado em texto também sai", () => {
    // 11 dígitos seguidos o CPF pega antes; o critério é o número sumir.
    expect(scrubMessage("zap11987654321 ok")).toMatch(/^zap\[(PHONE|CPF)\] ok$/);
  });

  // Regressão: uma borda de letra/hífen nos padrões (posta para poupar UUID)
  // deixava sair inteiro o número grudado justamente nos rótulos que alguém
  // digita colado — e hexadecimal (`cpf`, `fone`, `doc`) e hífen estão entre eles.
  it("apaga CPF e telefone grudados no rótulo, inclusive por hífen", () => {
    for (const [texto, rotulo] of [
      ["cpf12345678909", "cpf"],
      ["CPF123.456.789-09", "CPF"],
      ["doc12345678909", "doc"],
      ["fone11987654321", "fone"],
      ["telefone11987654321", "telefone"],
      ["tel-11987654321", "tel-"],
      ["lead-123.456.789-09", "lead-"],
    ] as const) {
      const out = scrubMessage(texto);
      expect(out, texto).not.toMatch(/\d{3}/);
      expect(out, texto).toMatch(new RegExp(`^${rotulo}\\[(PHONE|CPF)\\]$`));
    }
    expect(scrubMessage("12345678909-joao")).toMatch(/^\[(PHONE|CPF)\]-joao$/);
  });

  it("apaga o CPF e poupa o UUID na mesma frase", () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const out = scrubMessage(`cpf12345678909 no agente ${uuid}`);
    expect(out).toMatch(/^cpf\[(PHONE|CPF)\] no agente /);
    expect(out).toContain(uuid);
  });

  // Um UUID fixo passa por sorte: sem a proteção do UUID, 141 destes 5.000
  // saíam alterados, sempre num trecho só de dígitos. Por isso milhares,
  // gerados de forma determinística (sha256 do índice) — a mesma amostra em
  // toda execução, e uma falha reproduzível pelo índice.
  it("não come pedaço de UUID — em milhares deles", () => {
    const alterados: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const h = createHash("sha256").update(`uuid-${i}`).digest("hex");
      const variante = "89ab"[parseInt(h[16]!, 16) % 4];
      const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variante}${h.slice(17, 20)}-${h.slice(20, 32)}`;
      const texto = `agente ${uuid} falhou`;
      if (scrubMessage(texto) !== texto) alterados.push(`${i}: ${uuid} -> ${scrubMessage(texto)}`);
    }
    expect(alterados.slice(0, 5)).toEqual([]);
  });

  it("não come pedaço de hora nem de data", () => {
    expect(scrubMessage("em 2026-09-23T18:46:39Z")).toBe("em 2026-09-23T18:46:39Z");
  });
});

describe("sentryScrubHooks", () => {
  const urlComToken = `https://crm.exemplo.com/api/v1/webhooks/in/${TOKEN}?sig=deadbeef`;

  it("limpa header sensível por padrão, inclusive de integração que ainda não existe", () => {
    const event = sentryScrubHooks.beforeSend({
      request: {
        url: urlComToken,
        headers: {
          authorization: "Bearer segredo",
          "x-canal-novo-api-key": "chave-de-integracao-futura",
          "x-algum-token": "outro-segredo",
          "content-type": "application/json",
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(event.request?.headers).not.toHaveProperty("authorization");
    // O ponto do padrão: header de integração nova já nasce coberto.
    expect(event.request?.headers).not.toHaveProperty("x-canal-novo-api-key");
    expect(event.request?.headers).not.toHaveProperty("x-algum-token");
    expect(event.request?.headers).toHaveProperty("content-type");
    expect(JSON.stringify(event)).not.toContain(TOKEN);
  });

  it("beforeSendTransaction limpa os atributos de trace — o canal que não tinha guarda", () => {
    const event = sentryScrubHooks.beforeSendTransaction({
      transaction: `GET /api/v1/webhooks/in/${TOKEN}`,
      request: { url: urlComToken },
      contexts: {
        trace: {
          data: {
            "url.full": urlComToken,
            "http.url": urlComToken,
            "url.path": `/api/v1/webhooks/in/${TOKEN}`,
            "http.target": `/api/v1/webhooks/in/${TOKEN}?sig=deadbeef`,
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // O teste que importa: o token não sobrevive em NENHUM campo do envelope.
    expect(JSON.stringify(event)).not.toContain(TOKEN);
    expect(JSON.stringify(event)).not.toContain("deadbeef");
  });

  it("beforeSendSpan limpa description e data", () => {
    const span = sentryScrubHooks.beforeSendSpan({
      description: `GET ${urlComToken}`,
      data: { "url.full": urlComToken },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(JSON.stringify(span)).not.toContain(TOKEN);
  });

  it("beforeBreadcrumb limpa a URL — o README prometia isso sem mecanismo", () => {
    const crumb = sentryScrubHooks.beforeBreadcrumb({
      message: `fetch ${urlComToken}`,
      data: { url: urlComToken },
    });
    expect(JSON.stringify(crumb)).not.toContain(TOKEN);
  });
});
