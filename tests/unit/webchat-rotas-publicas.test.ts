/**
 * As rotas públicas do chat no site (spec 36, F1, Task 8): `sessao` e `mensagens`.
 *
 * O visitante não tem sessão. Quem autoriza é a chave (em `sessao`) e o token de
 * visitante (em `mensagens`). A organização e a conexão saem do banco, nunca do corpo.
 * O banco é um dublê que filtra as colunas que a rota pede, como o cliente real.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as mensagens } from "@/app/api/v1/webchat/mensagens/route";
import { POST as sessao } from "@/app/api/v1/webchat/sessao/route";
import { assinarTokenDeVisitante, lerTokenDeVisitante } from "@/lib/channels/webchat/token";

const h = vi.hoisted(() => ({
  banco: null as unknown,
  moduloLigado: true,
  contador: new Map<string, number>(),
  consultas: 0,
  ingerir: vi.fn(),
  atendimento: vi.fn(
    async (..._args: unknown[]): Promise<{ estado: string; abreEm: string | null; aviso: string | null }> => ({
      estado: "aberto",
      abreEm: null,
      aviso: null,
    }),
  ),
  logErro: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => h.logErro(...args),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.example.com" } }));
vi.mock("@/lib/webhooks/url-publica", () => ({ enderecoDaPropriaMaquina: () => false }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco }));
vi.mock("@/lib/http/ip-do-cliente", () => ({ ipDoCliente: () => "203.0.113.7" }));
vi.mock("@/lib/channels/webchat/modulo", () => ({ chatNoSiteLigado: async () => h.moduloLigado }));
vi.mock("@/lib/channels/webchat/atendimento", () => ({
  carregarAtendimento: (...args: unknown[]) => h.atendimento(...args),
}));
vi.mock("@/lib/channels/webchat/ingest", () => ({
  ingerirMensagemDoChat: (...args: unknown[]) => h.ingerir(...args),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (bucket: string, limit: number, windowSec: number) => {
    const count = (h.contador.get(bucket) ?? 0) + 1;
    h.contador.set(bucket, count);
    return { allowed: count <= limit, count, limit, window_sec: windowSec };
  },
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const CS = "11111111-1111-4111-8111-111111111111";
const OUTRA_CS = "33333333-3333-4333-8333-333333333333";
const VISITANTE = "44444444-4444-4444-8444-444444444444";
const CHAVE = `wck_${"A".repeat(43)}`;
const DIA_EM_MS = 24 * 60 * 60 * 1000;

type Cenario = "ok" | "inexistente" | "arquivada" | "org_suspensa" | "modulo_desligado";

/** Banco que filtra por `eq` e `is`, como o cliente real, e devolve a primeira linha. */
function bancoFalso(tabelas: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(nome: string) {
      h.consultas += 1;
      const filtros: Array<(linha: Record<string, unknown>) => boolean> = [];
      const consulta = {
        select: () => consulta,
        eq: (coluna: string, valor: unknown) => {
          filtros.push((linha) => linha[coluna] === valor);
          return consulta;
        },
        is: (coluna: string, valor: null) => {
          filtros.push((linha) => (linha[coluna] ?? null) === valor);
          return consulta;
        },
        maybeSingle: async () => {
          const achadas = (tabelas[nome] ?? []).filter((linha) => filtros.every((f) => f(linha)));
          return { data: achadas[0] ?? null, error: null };
        },
      };
      return consulta;
    },
  };
}

function cenario(opcao: Cenario, metadata: Record<string, unknown> = {}): void {
  const conexao = {
    id: CS,
    organization_id: ORG,
    provider: "webchat",
    webchat_public_key: CHAVE,
    archived_at: null,
    metadata,
  };
  const linhas =
    opcao === "inexistente"
      ? []
      : [opcao === "arquivada" ? { ...conexao, archived_at: "2026-11-01T00:00:00Z" } : conexao];
  h.banco = bancoFalso({
    channel_sessions: linhas,
    organizations: [{ id: ORG, status: opcao === "org_suspensa" ? "suspended" : "active" }],
  });
  h.moduloLigado = opcao !== "modulo_desligado";
}

function pedido(rota: "sessao" | "mensagens", corpo: unknown, token?: string): Request {
  return pedidoBruto(rota, JSON.stringify(corpo), token);
}

function pedidoBruto(rota: "sessao" | "mensagens", corpo: string, token?: string): Request {
  return new Request(`https://crm.example.com/api/v1/webchat/${rota}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: corpo,
  });
}

function tokenDeVisitante(agora = new Date(), cs = CS, vis = VISITANTE): string {
  return assinarTokenDeVisitante({ channelSessionId: cs, visitanteId: vis, agora });
}

async function resposta(res: Response): Promise<{ status: number; body: unknown }> {
  return { status: res.status, body: await res.json() };
}

beforeAll(() => {
  process.env.INTERNAL_SECRET = "segredo-de-teste-do-chat-no-site";
});

describe("POST /api/v1/webchat/sessao", () => {
  beforeEach(() => {
    h.contador.clear();
    h.consultas = 0;
    h.logErro.mockClear();
    h.atendimento.mockClear();
    cenario("ok");
  });

  it("devolve data.atendimento em snake_case (estado, abre_em, aviso) com o horário do agente", async () => {
    h.atendimento.mockResolvedValueOnce({
      estado: "fechado",
      abreEm: "2026-11-25T11:00:00.000Z",
      aviso: "Voltamos amanhã.",
    });
    const r = await resposta(await sessao(pedido("sessao", { chave: CHAVE })));
    expect(r.status).toBe(200);
    expect((r.body as { data: { atendimento: unknown } }).data.atendimento).toEqual({
      estado: "fechado",
      abre_em: "2026-11-25T11:00:00.000Z",
      aviso: "Voltamos amanhã.",
    });
  });

  it("se a leitura do horário lança, a sessão segue 200 com atendimento aberto", async () => {
    h.atendimento.mockRejectedValueOnce(new Error("falha de teste"));
    const r = await resposta(await sessao(pedido("sessao", { chave: CHAVE })));
    expect(r.status).toBe(200);
    expect((r.body as { data: { atendimento: unknown } }).data.atendimento).toEqual({
      estado: "aberto",
      abre_em: null,
      aviso: null,
    });
    expect((r.body as { data: { token: unknown } }).data.token).toEqual(expect.any(String));
  });

  it("o horário é lido com a organização e a conexão da linha da chave, nunca do corpo", async () => {
    await sessao(pedido("sessao", { chave: CHAVE }));
    expect(h.atendimento).toHaveBeenCalledWith(expect.anything(), ORG, CS, expect.any(Date));
  });

  it("o 31º pedido do mesmo IP, com chaves diferentes, dá 429 e não consulta o banco", async () => {
    for (let i = 0; i < 30; i++) {
      await sessao(pedido("sessao", { chave: `wck_${String(i).padStart(43, "x")}` }));
    }
    const consultasAntes = h.consultas;
    const r = await sessao(pedido("sessao", { chave: `wck_${"y".repeat(43)}` }));
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("60");
    expect(h.consultas).toBe(consultasAntes);
  });

  it("corpo de 9 KB dá 413, antes de qualquer consulta", async () => {
    const r = await sessao(pedido("sessao", { chave: CHAVE, pad: "x".repeat(9 * 1024) }));
    expect(r.status).toBe(413);
    expect(h.consultas).toBe(0);
  });

  it("JSON que não lê dá 422", async () => {
    const r = await sessao(pedidoBruto("sessao", "{nao-e-json"));
    expect(r.status).toBe(422);
  });

  it("erro inesperado do banco vira 500 registrado, sem a chave no log", async () => {
    h.banco = {
      from: () => {
        throw new Error("falha de teste");
      },
    };
    const r = await sessao(pedido("sessao", { chave: CHAVE }));
    expect(r.status).toBe(500);
    expect(h.logErro).toHaveBeenCalled();
    expect(JSON.stringify(h.logErro.mock.calls)).not.toContain(CHAVE);
  });

  it("com a conexão ativa, responde 200 com token e visitante", async () => {
    const r = await resposta(await sessao(pedido("sessao", { chave: CHAVE })));
    expect(r.status).toBe(200);
  });

  it("chave inexistente, conexão arquivada, organização suspensa e módulo desligado dão o mesmo 404", async () => {
    const respostas: Array<{ status: number; body: unknown }> = [];
    for (const caso of ["inexistente", "arquivada", "org_suspensa", "modulo_desligado"] as const) {
      h.contador.clear();
      cenario(caso);
      respostas.push(await resposta(await sessao(pedido("sessao", { chave: CHAVE }))));
    }
    const primeira = respostas[0];
    expect(primeira).toBeDefined();
    expect(primeira!.status).toBe(404);
    for (const r of respostas) expect(r).toEqual(primeira);
  });

  it("chat pausado dá o mesmo 404 e o mesmo corpo de chave inexistente", async () => {
    h.contador.clear();
    cenario("inexistente");
    const inexistente = await resposta(await sessao(pedido("sessao", { chave: CHAVE })));
    h.contador.clear();
    cenario("ok", { webchat: { pausado: true } });
    const pausado = await resposta(await sessao(pedido("sessao", { chave: CHAVE })));
    expect(pausado.status).toBe(404);
    expect(pausado).toEqual(inexistente);
  });

  it("retomar o chat (pausado false) volta a abrir a janela da sessão", async () => {
    cenario("ok", { webchat: { pausado: false } });
    const r = await resposta(await sessao(pedido("sessao", { chave: CHAVE })));
    expect(r.status).toBe(200);
  });

  it("sem token devolve um token novo, para um visitante novo", async () => {
    const r = await resposta(await sessao(pedido("sessao", { chave: CHAVE })));
    const dados = (r.body as { data: { token: string; visitante_id: string } }).data;
    const lido = lerTokenDeVisitante(dados.token, new Date());
    expect(lido.ok).toBe(true);
    if (lido.ok) {
      expect(lido.channelSessionId).toBe(CS);
      expect(lido.visitanteId).toBe(dados.visitante_id);
    }
  });

  it("com token válido da mesma conexão devolve o mesmo visitante_id", async () => {
    const r = await resposta(await sessao(pedido("sessao", { chave: CHAVE }, tokenDeVisitante())));
    expect((r.body as { data: { visitante_id: string } }).data.visitante_id).toBe(VISITANTE);
  });

  it("com token de outra conexão devolve um visitante novo", async () => {
    const outra = tokenDeVisitante(new Date(), OUTRA_CS, VISITANTE);
    const r = await resposta(await sessao(pedido("sessao", { chave: CHAVE }, outra)));
    expect((r.body as { data: { visitante_id: string } }).data.visitante_id).not.toBe(VISITANTE);
  });

  it("recusa corpo com campo fora do schema: a organização nunca vem do pedido", async () => {
    const r = await resposta(
      await sessao(pedido("sessao", { chave: CHAVE, organization_id: randomUUID() })),
    );
    expect(r.status).toBe(422);
  });
});

describe("POST /api/v1/webchat/mensagens", () => {
  beforeEach(() => {
    h.contador.clear();
    h.consultas = 0;
    h.logErro.mockClear();
    cenario("ok");
    h.ingerir.mockReset();
    h.ingerir.mockImplementation(async (_banco: unknown, p: { mensagemId: string }) => ({
      status: "ingested",
      conversationId: "conversa-de-teste",
      messageId: p.mensagemId,
    }));
  });

  it("sem Authorization dá 401", async () => {
    const r = await resposta(await mensagens(pedido("mensagens", { mensagem_id: randomUUID(), texto: "oi" })));
    expect(r.status).toBe(401);
    expect(h.ingerir).not.toHaveBeenCalled();
  });

  it("INTERNAL_SECRET ausente dá 500 (defeito de configuração), não 401, e registra", async () => {
    const antes = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = "";
    try {
      const r = await mensagens(
        pedido("mensagens", { mensagem_id: randomUUID(), texto: "oi" }, "abc.def"),
      );
      expect(r.status).toBe(500);
      expect(h.logErro).toHaveBeenCalled();
    } finally {
      process.env.INTERNAL_SECRET = antes;
    }
  });

  it("corpo de 9 KB dá 413", async () => {
    const r = await mensagens(
      pedido("mensagens", { mensagem_id: randomUUID(), texto: "x".repeat(9 * 1024) }, tokenDeVisitante()),
    );
    expect(r.status).toBe(413);
    expect(h.ingerir).not.toHaveBeenCalled();
  });

  it("erro inesperado vira 500 registrado, sem o token nem o texto no log", async () => {
    h.banco = {
      from: () => {
        throw new Error("falha de teste");
      },
    };
    const r = await mensagens(
      pedido("mensagens", { mensagem_id: randomUUID(), texto: "segredo-do-visitante" }, tokenDeVisitante()),
    );
    expect(r.status).toBe(500);
    const registro = JSON.stringify(h.logErro.mock.calls);
    expect(registro).not.toContain("segredo-do-visitante");
    expect(registro).not.toContain(tokenDeVisitante().split(".")[0]);
  });

  it("aceita emoji composto (U+200D) e o texto sai como enviado", async () => {
    const r = await mensagens(
      pedido("mensagens", { mensagem_id: randomUUID(), texto: "👨‍👩 oi" }, tokenDeVisitante()),
    );
    expect(r.status).toBe(201);
  });

  it.each(["", "   ", "a".repeat(2001), "oi\u0000tudo", "oi‮tudo", "oi\u0085tudo", "oi⁦x"])(
    "texto inválido (%j) dá 422 e nada é gravado",
    async (texto) => {
      const r = await resposta(
        await mensagens(pedido("mensagens", { mensagem_id: randomUUID(), texto }, tokenDeVisitante())),
      );
      expect(r.status).toBe(422);
      expect(h.ingerir).not.toHaveBeenCalled();
    },
  );

  it("responde 201 e grava com a organização e a conexão do banco, não do corpo", async () => {
    const r = await resposta(
      await mensagens(pedido("mensagens", { mensagem_id: randomUUID(), texto: "  oi  " }, tokenDeVisitante())),
    );
    expect(r.status).toBe(201);
    expect(h.ingerir).toHaveBeenCalledTimes(1);
    expect(h.ingerir).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        channelSessionId: CS,
        visitanteId: VISITANTE,
        texto: "oi",
      }),
    );
  });

  it("o 21º envio em um minuto dá 429 com Retry-After", async () => {
    let ultima: Response | null = null;
    for (let i = 0; i < 21; i++) {
      ultima = await mensagens(
        pedido("mensagens", { mensagem_id: randomUUID(), texto: `mensagem ${i}` }, tokenDeVisitante()),
      );
    }
    expect(ultima?.status).toBe(429);
    expect(ultima?.headers.get("Retry-After")).toBe("60");
  });

  it("com token que vence em menos de 7 dias, a resposta traz token_novo", async () => {
    const quase = tokenDeVisitante(new Date(Date.now() - 25 * DIA_EM_MS));
    const r = await resposta(
      await mensagens(pedido("mensagens", { mensagem_id: randomUUID(), texto: "oi" }, quase)),
    );
    expect(r.status).toBe(201);
    expect((r.body as { data: { token_novo?: string } }).data.token_novo).toEqual(expect.any(String));
  });

  it("com token comum, a resposta não traz token_novo", async () => {
    const r = await resposta(
      await mensagens(pedido("mensagens", { mensagem_id: randomUUID(), texto: "oi" }, tokenDeVisitante())),
    );
    expect((r.body as { data: Record<string, unknown> }).data).not.toHaveProperty("token_novo");
  });

  it("recusa corpo com organization_id: a organização nunca vem do pedido", async () => {
    const r = await resposta(
      await mensagens(
        pedido(
          "mensagens",
          { mensagem_id: randomUUID(), texto: "oi", organization_id: randomUUID() },
          tokenDeVisitante(),
        ),
      ),
    );
    expect(r.status).toBe(422);
    expect(h.ingerir).not.toHaveBeenCalled();
  });

  it("chave inexistente, conexão arquivada, organização suspensa e módulo desligado dão o mesmo 404", async () => {
    const respostas: Array<{ status: number; body: unknown }> = [];
    for (const caso of ["inexistente", "arquivada", "org_suspensa", "modulo_desligado"] as const) {
      h.contador.clear();
      cenario(caso);
      respostas.push(
        await resposta(
          await mensagens(pedido("mensagens", { mensagem_id: randomUUID(), texto: "oi" }, tokenDeVisitante())),
        ),
      );
    }
    const primeira = respostas[0];
    expect(primeira).toBeDefined();
    expect(primeira!.status).toBe(404);
    for (const r of respostas) expect(r).toEqual(primeira);
    expect(h.ingerir).not.toHaveBeenCalled();
  });

  it("chat pausado dá o mesmo 404 de chave inexistente e a mensagem não chega à ingestão", async () => {
    h.contador.clear();
    cenario("inexistente");
    const inexistente = await resposta(
      await mensagens(pedido("mensagens", { mensagem_id: randomUUID(), texto: "oi" }, tokenDeVisitante())),
    );
    h.contador.clear();
    cenario("ok", { webchat: { pausado: true } });
    const pausado = await resposta(
      await mensagens(pedido("mensagens", { mensagem_id: randomUUID(), texto: "oi" }, tokenDeVisitante())),
    );
    expect(pausado.status).toBe(404);
    expect(pausado).toEqual(inexistente);
    expect(h.ingerir).not.toHaveBeenCalled();
  });

  it("recusa da ingestão vira 422 genérico, sem dizer qual campo falta", async () => {
    h.ingerir.mockResolvedValueOnce({
      status: "recusada",
      motivo: "campo_obrigatorio",
      conversationId: null,
      messageId: null,
    });
    const r = await resposta(
      await mensagens(pedido("mensagens", { mensagem_id: randomUUID(), texto: "oi" }, tokenDeVisitante())),
    );
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: { code: "validation_failed", message: "Dados inválidos." } });
    expect(JSON.stringify(r.body)).not.toContain("campo_obrigatorio");
  });

  it("o aceite vai à ingestão com a hora do servidor; a hora enviada é ignorada", async () => {
    const antes = Date.now();
    await mensagens(
      pedido(
        "mensagens",
        { mensagem_id: randomUUID(), texto: "oi", aceite: { versao: "v1", em: "2000-01-01T00:00:00.000Z" } },
        tokenDeVisitante(),
      ),
    );
    const p = h.ingerir.mock.calls[0]![1] as { aceite?: { versao: string; em: string } };
    expect(p.aceite?.versao).toBe("v1");
    const em = Date.parse(p.aceite!.em);
    expect(em).toBeGreaterThanOrEqual(antes);
    expect(em).toBeLessThanOrEqual(Date.now());
  });

  it("sem aceite no corpo, a ingestão não recebe aceite", async () => {
    await mensagens(pedido("mensagens", { mensagem_id: randomUUID(), texto: "oi" }, tokenDeVisitante()));
    const p = h.ingerir.mock.calls[0]![1] as Record<string, unknown>;
    expect(p).not.toHaveProperty("aceite");
  });

  it("o contato chega aparado e a coleta da conexão segue junto para a ingestão", async () => {
    cenario("ok", { webchat: { coleta: { nome: "obrigatorio", telefone: "oculto", email: "opcional" } } });
    await mensagens(
      pedido(
        "mensagens",
        {
          mensagem_id: randomUUID(),
          texto: "oi",
          aceite: { versao: "v1" },
          contato: { nome: "  Ana Souza ", telefone: "+55 (11) 99999-9999", email: " ana@example.com " },
        },
        tokenDeVisitante(),
      ),
    );
    expect(h.ingerir.mock.calls[0]![1]).toMatchObject({
      contato: { nome: "Ana Souza", telefone: "+5511999999999", email: "ana@example.com" },
      coleta: { nome: "obrigatorio", telefone: "oculto", email: "opcional" },
    });
  });

  it.each([{ nome: "x".repeat(121) }, { nome: "Ana\u202Egpj.exe" }, { nome: "Ana\u0000" }])(
    "contato inválido (%j) dá 422 e nada é ingerido",
    async (contato) => {
      const r = await resposta(
        await mensagens(
          pedido("mensagens", { mensagem_id: randomUUID(), texto: "oi", aceite: { versao: "v1" }, contato }, tokenDeVisitante()),
        ),
      );
      expect(r.status).toBe(422);
      expect(h.ingerir).not.toHaveBeenCalled();
    },
  );

  it("telefone sem + em campo opcional não recusa: chega à ingestão vazio, e o e-mail inválido também", async () => {
    const r = await resposta(
      await mensagens(
        pedido(
          "mensagens",
          {
            mensagem_id: randomUUID(),
            texto: "oi",
            aceite: { versao: "v1" },
            contato: { telefone: "11999999999", email: "nao-e-email" },
          },
          tokenDeVisitante(),
        ),
      ),
    );
    expect(r.status).toBe(201);
    expect(h.ingerir.mock.calls[0]![1]).toMatchObject({ contato: { telefone: "", email: "" } });
  });

  it("telefone sem + em campo obrigatório chega vazio: quem recusa é a ingestão", async () => {
    cenario("ok", { webchat: { coleta: { telefone: "obrigatorio" } } });
    await mensagens(
      pedido(
        "mensagens",
        { mensagem_id: randomUUID(), texto: "oi", aceite: { versao: "v1" }, contato: { telefone: "11999999999" } },
        tokenDeVisitante(),
      ),
    );
    expect(h.ingerir.mock.calls[0]![1]).toMatchObject({
      contato: { telefone: "" },
      coleta: { telefone: "obrigatorio" },
    });
  });

  it("campo oculto com formato inválido não dá 422: a ingestão o ignora", async () => {
    cenario("ok", { webchat: { coleta: { telefone: "oculto", email: "oculto" } } });
    const r = await resposta(
      await mensagens(
        pedido(
          "mensagens",
          {
            mensagem_id: randomUUID(),
            texto: "oi",
            aceite: { versao: "v1" },
            contato: { telefone: "abc", email: "nao-e-email" },
          },
          tokenDeVisitante(),
        ),
      ),
    );
    expect(r.status).toBe(201);
  });
});
