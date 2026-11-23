/**
 * `GET /chat/<chave>` (F2, Task 3): a janela que o visitante abre. Chave inexistente, conexão
 * arquivada, organização suspensa e módulo desligado saem com o MESMO 404 e o mesmo corpo.
 * O banco é um dublê que filtra as colunas que a rota pede, como o cliente real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/chat/[chave]/route";
import { PAGINA_INDISPONIVEL } from "@/lib/channels/webchat/janela-html";

const h = vi.hoisted(() => ({
  banco: null as unknown,
  moduloLigado: true,
  contador: new Map<string, number>(),
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
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({
    nome: "Loja Exemplo",
    logoUrl: null,
    accent: "#506d48",
    accentFg: "#ffffff",
    origens: { nome: "padrao", cor: "padrao" },
  }),
}));
vi.mock("@/lib/legal/controlador-do-chat", () => ({
  lerControladorDoChat: async () => ({
    razaoSocial: "Loja Exemplo Ltda",
    politicaUrl: "https://loja.example.com/privacidade",
  }),
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
const CHAVE = `wck_${"A".repeat(43)}`;

type Cenario = "ok" | "inexistente" | "arquivada" | "org_suspensa" | "modulo_desligado";

/** Banco que filtra por `eq` e `is`, como o cliente real, e devolve a primeira linha. */
function bancoFalso(tabelas: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(nome: string) {
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
    webchat_allowed_origins: ["https://cliente.example.com"],
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

function pedido(chave: string): [Request, { params: Promise<{ chave: string }> }] {
  return [
    new Request(`https://crm.example.com/chat/${chave}`, { method: "GET" }),
    { params: Promise.resolve({ chave }) },
  ];
}

async function resposta(chave: string): Promise<{ status: number; body: unknown }> {
  const res = await GET(...pedido(chave));
  return { status: res.status, body: await res.text() };
}

describe("GET /chat/<chave>", () => {
  beforeEach(() => {
    h.contador.clear();
    h.logErro.mockClear();
    cenario("ok");
  });

  it("chave inexistente, conexão arquivada, organização suspensa e módulo desligado dão o mesmo 404", async () => {
    const respostas: Array<{ status: number; body: unknown }> = [];
    for (const caso of ["inexistente", "arquivada", "org_suspensa", "modulo_desligado"] as const) {
      h.contador.clear();
      cenario(caso);
      respostas.push(await resposta(CHAVE));
    }
    const primeira = respostas[0];
    expect(primeira).toBeDefined();
    expect(primeira!.status).toBe(404);
    for (const r of respostas) expect(r).toEqual(primeira);
  });

  it("chave malformada dá o mesmo 404 de chave inexistente, sem consultar o banco", async () => {
    const consultado = vi.fn();
    h.banco = { from: consultado };
    const malformada = await resposta("wck_com espaco");
    expect(malformada).toEqual({
      status: 404,
      body: PAGINA_INDISPONIVEL,
    });
    expect(consultado).toHaveBeenCalledTimes(0);
  });

  it("com a conexão ativa responde 200 em HTML, sem negociar cache, e sem X-Frame-Options", async () => {
    const res = await GET(...pedido(CHAVE));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    const html = await res.text();
    expect(html).toContain('<script src="/webchat-janela.js" defer></script>');
  });

  it("o CSP da resposta traz as origens da conexão em frame-ancestors", async () => {
    const res = await GET(...pedido(CHAVE));
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors https://cliente.example.com;",
    );
  });

  it("chat pausado dá o mesmo 404 e o mesmo corpo de chave inexistente", async () => {
    cenario("inexistente");
    const inexistente = await resposta(CHAVE);
    cenario("ok", { webchat: { pausado: true } });
    const pausado = await resposta(CHAVE);
    expect(pausado.status).toBe(404);
    expect(pausado).toEqual(inexistente);
  });

  it("módulo desligado dá 404 mesmo com a chave correta", async () => {
    cenario("modulo_desligado");
    const r = await resposta(CHAVE);
    expect(r.status).toBe(404);
  });

  it("erro inesperado do banco vira 500 registrado, sem a chave no log", async () => {
    h.banco = {
      from: () => {
        throw new Error("falha de teste");
      },
    };
    const r = await resposta(CHAVE);
    expect(r.status).toBe(500);
    expect(h.logErro).toHaveBeenCalled();
    expect(JSON.stringify(h.logErro.mock.calls)).not.toContain(CHAVE);
  });
});
