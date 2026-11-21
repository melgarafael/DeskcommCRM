import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Conexão do chat no site, criada e configurada por quem administra (spec 36, F1, Task 7).
 * Molde: `app/api/v1/channels/bot/route.test.ts`. A tabela é um fake em memória com o mínimo
 * do builder que as rotas usam; o estado vive em `h`, que o `vi.hoisted` cria antes dos mocks.
 */
const h = vi.hoisted(() => {
  type Linha = Record<string, unknown>;
  type Resultado = { data: unknown; error: { code: string; message: string } | null };

  const estado = {
    ligado: true,
    papel: "admin" as "admin" | "manager",
    suporte: false,
    appUrl: "https://crm.exemplo.com.br",
    tabela: [] as Linha[],
    auditorias: [] as Linha[],
  };

  function consulta(nome: string) {
    if (nome !== "channel_sessions") throw new Error(`tabela inesperada no teste: ${nome}`);
    const filtros: Array<(l: Linha) => boolean> = [];
    let escrita: { tipo: "insert"; linha: Linha } | { tipo: "update"; patch: Linha } | null = null;
    let limite = Number.POSITIVE_INFINITY;

    const executar = (unica: boolean): Resultado => {
      if (escrita?.tipo === "insert") {
        const nova: Linha = { id: globalThis.crypto.randomUUID(), archived_at: null, ...escrita.linha };
        const repetida = estado.tabela.some(
          (l) => l.webchat_public_key === nova.webchat_public_key && l.archived_at === null,
        );
        if (repetida) return { data: null, error: { code: "23505", message: "duplicate key" } };
        estado.tabela.push(nova);
        return { data: unica ? { ...nova } : [{ ...nova }], error: null };
      }
      const alvo = estado.tabela.filter((l) => filtros.every((f) => f(l))).slice(0, limite);
      if (escrita?.tipo === "update") for (const l of alvo) Object.assign(l, escrita.patch);
      const copias = alvo.map((l) => ({ ...l }));
      if (unica) {
        return copias[0]
          ? { data: copias[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "0 linhas" } };
      }
      return { data: copias, error: null };
    };

    const builder = {
      select: () => builder,
      insert(linha: Linha) {
        escrita = { tipo: "insert", linha };
        return builder;
      },
      update(patch: Linha) {
        escrita = { tipo: "update", patch };
        return builder;
      },
      eq(coluna: string, valor: unknown) {
        filtros.push((l) => l[coluna] === valor);
        return builder;
      },
      is(coluna: string, valor: unknown) {
        filtros.push((l) => (l[coluna] ?? null) === valor);
        return builder;
      },
      order: () => builder,
      limit(n: number) {
        limite = n;
        return builder;
      },
      single: () => Promise.resolve(executar(true)),
      then(resolve: (r: Resultado) => unknown, reject: (e: unknown) => unknown) {
        return Promise.resolve(executar(false)).then(resolve, reject);
      },
    };
    return builder;
  }

  return { estado, admin: { from: consulta } };
});

vi.mock("@/lib/env", () => ({
  env: {
    get NEXT_PUBLIC_APP_URL() {
      return h.estado.appUrl;
    },
  },
}));
vi.mock("@/lib/auth/require-role", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireRole: async () => {
      if (h.estado.papel !== "admin") {
        return {
          ok: false,
          response: NextResponse.json({ error: { code: "forbidden", message: "Forbidden" } }, { status: 403 }),
        };
      }
      return {
        ok: true,
        user: { id: "cccccccc-0000-4000-8000-0000000000ee" },
        org: { orgId: "cccccccc-0000-4000-8000-000000000001", role: "admin" },
      };
    },
  };
});
vi.mock("@/lib/impersonate/support", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireSupportWrite: async () =>
      h.estado.suporte
        ? NextResponse.json({ error: { code: "support_read_only", message: "Suporte" } }, { status: 403 })
        : null,
  };
});
vi.mock("@/lib/channels/webchat/modulo", () => ({
  chatNoSiteLigado: async () => h.estado.ligado,
}));
vi.mock("@/lib/audit", () => ({
  audit: async (evento: Record<string, unknown>) => {
    h.estado.auditorias.push(evento);
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));

import { GET, PATCH, POST } from "./route";
import { POST as GIRAR } from "./girar/route";

const url = "http://localhost/api/v1/channels/webchat";
const ORG = "cccccccc-0000-4000-8000-000000000001";

const criar = (corpo: unknown = {}) => POST(new NextRequest(url, { method: "POST", body: JSON.stringify(corpo) }));
const atualizar = (corpo: unknown) => PATCH(new NextRequest(url, { method: "PATCH", body: JSON.stringify(corpo) }));
const girar = () => GIRAR(new NextRequest(`${url}/girar`, { method: "POST" }));
const ler = () => GET(new NextRequest(url));
const conexao = () =>
  h.estado.tabela.find((l) => l.organization_id === ORG && l.provider === "webchat" && l.archived_at === null);
const corpoDe = async (res: Response) => (await res.json()) as { data: Record<string, unknown> };

beforeEach(() => {
  h.estado.ligado = true;
  h.estado.papel = "admin";
  h.estado.suporte = false;
  h.estado.appUrl = "https://crm.exemplo.com.br";
  h.estado.tabela.length = 0;
  h.estado.auditorias.length = 0;
});

describe("/api/v1/channels/webchat com o módulo desligado", () => {
  it("GET, POST, PATCH e girar respondem 404 e não gravam", async () => {
    h.estado.ligado = false;
    expect((await ler()).status).toBe(404);
    expect((await criar()).status).toBe(404);
    expect((await atualizar({ allowed_origins: [] })).status).toBe(404);
    expect((await girar()).status).toBe(404);
    expect(h.estado.tabela).toHaveLength(0);
    expect(h.estado.auditorias).toHaveLength(0);
  });
});

describe("/api/v1/channels/webchat com papel manager", () => {
  it("cada verbo responde 403 e não grava", async () => {
    h.estado.papel = "manager";
    expect((await ler()).status).toBe(403);
    expect((await criar()).status).toBe(403);
    expect((await atualizar({ allowed_origins: [] })).status).toBe(403);
    expect((await girar()).status).toBe(403);
    expect(h.estado.tabela).toHaveLength(0);
  });
});

describe("/api/v1/channels/webchat em acompanhamento de suporte", () => {
  it("POST, PATCH e girar respondem 403 antes do efeito", async () => {
    h.estado.suporte = true;
    expect((await criar()).status).toBe(403);
    expect(h.estado.tabela).toHaveLength(0);

    h.estado.suporte = false;
    await criar();
    h.estado.suporte = true;
    const chaveAntes = conexao()?.webchat_public_key;
    h.estado.auditorias.length = 0;
    expect((await atualizar({ allowed_origins: ["https://loja.exemplo.com.br"] })).status).toBe(403);
    expect((await girar()).status).toBe(403);
    expect(conexao()?.webchat_public_key).toBe(chaveAntes);
    expect(conexao()?.webchat_allowed_origins).toEqual([]);
    expect(h.estado.auditorias).toHaveLength(0);
  });
});

describe("POST cria a conexão", () => {
  it("nasce com nome, status WORKING, chave wck_ e audit sem a chave", async () => {
    const res = await criar();
    expect(res.status).toBe(201);
    const corpo = await corpoDe(res);
    expect(corpo.data.id).toEqual(expect.any(String));
    expect(corpo.data.public_key).toMatch(/^wck_[A-Za-z0-9_-]{43}$/);
    expect(corpo.data.allowed_origins).toEqual([]);

    const linha = conexao();
    expect(linha).toMatchObject({
      id: corpo.data.id,
      provider: "webchat",
      display_name: "Chat no site",
      status: "WORKING",
      webchat_public_key: corpo.data.public_key,
    });

    expect(h.estado.auditorias).toHaveLength(1);
    expect(h.estado.auditorias[0]).toMatchObject({
      action: "channel.webchat_created",
      resourceId: corpo.data.id,
    });
    expect(JSON.stringify(h.estado.auditorias)).not.toContain(corpo.data.public_key);
  });

  it("o segundo POST da mesma organização dá 409 e não cria outra linha", async () => {
    expect((await criar()).status).toBe(201);
    expect((await criar()).status).toBe(409);
    expect(h.estado.tabela.filter((l) => l.archived_at === null)).toHaveLength(1);
  });
});

describe("origens permitidas", () => {
  it("aceita https com host e porta, sem caminho", async () => {
    const res = await criar({ allowed_origins: ["https://loja.exemplo.com.br", "https://app.exemplo.com.br:8443"] });
    expect(res.status).toBe(201);
    expect((await corpoDe(res)).data.allowed_origins).toEqual([
      "https://loja.exemplo.com.br",
      "https://app.exemplo.com.br:8443",
    ]);
  });

  it("recusa http que não é localhost e origem com caminho", async () => {
    expect((await criar({ allowed_origins: ["http://loja.exemplo.com.br"] })).status).toBe(422);
    expect((await criar({ allowed_origins: ["https://loja.exemplo.com.br/caminho"] })).status).toBe(422);
    expect(h.estado.tabela).toHaveLength(0);
  });

  it("recusa mais de 20 origens", async () => {
    const origens = Array.from({ length: 21 }, (_, i) => `https://s${i}.exemplo.com.br`);
    expect((await criar({ allowed_origins: origens })).status).toBe(422);
  });

  it("http://localhost:3000 só é aceito com a instalação em loopback", async () => {
    expect((await criar({ allowed_origins: ["http://localhost:3000"] })).status).toBe(422);
    expect(h.estado.tabela).toHaveLength(0);

    h.estado.appUrl = "http://localhost:3000";
    expect((await criar({ allowed_origins: ["http://localhost:3000"] })).status).toBe(201);
  });
});

describe("PATCH muda domínios e configuração", () => {
  it("troca a lista, guarda a configuração em metadata.webchat e audita", async () => {
    await criar();
    h.estado.auditorias.length = 0;
    const res = await atualizar({
      allowed_origins: ["https://loja.exemplo.com.br"],
      config: { titulo: "Fale conosco", cor: "#1a4fd6", coleta: { telefone: "opcional" } },
    });
    expect(res.status).toBe(200);
    expect(conexao()?.webchat_allowed_origins).toEqual(["https://loja.exemplo.com.br"]);
    expect((conexao()?.metadata as Record<string, unknown>).webchat).toEqual({
      titulo: "Fale conosco",
      cor: "#1a4fd6",
      coleta: { telefone: "opcional" },
    });
    expect(h.estado.auditorias).toEqual([
      expect.objectContaining({ action: "channel.webchat_updated" }),
    ]);
  });

  it("config mescla com a atual: mandar só o título não apaga cor nem coleta", async () => {
    await criar();
    await atualizar({ config: { titulo: "Fale conosco", cor: "#1a4fd6", coleta: { email: "obrigatorio" } } });
    const res = await atualizar({ config: { titulo: "Atendimento" } });
    expect(res.status).toBe(200);
    expect((conexao()?.metadata as Record<string, unknown>).webchat).toEqual({
      titulo: "Atendimento",
      cor: "#1a4fd6",
      coleta: { email: "obrigatorio" },
    });
    expect((await corpoDe(res)).data.config).toEqual({
      titulo: "Atendimento",
      cor: "#1a4fd6",
      coleta: { email: "obrigatorio" },
    });
  });

  it("corpo vazio e campo fora do schema dão 422", async () => {
    await criar();
    expect((await atualizar({})).status).toBe(422);
    expect((await atualizar({ config: { cor: "vermelho" } })).status).toBe(422);
    expect((await atualizar({ config: { script: "alert(1)" } })).status).toBe(422);
  });
});

describe("PATCH pausa e retoma o chat", () => {
  const pausadoNaConexao = () => (conexao()?.metadata as Record<string, unknown>).webchat as Record<string, unknown>;

  it("pausar muda a configuração e emite os dois audits: updated e paused com o valor", async () => {
    await criar();
    h.estado.auditorias.length = 0;
    const res = await atualizar({ config: { pausado: true } });
    expect(res.status).toBe(200);
    expect(pausadoNaConexao()).toEqual({ pausado: true });
    expect(h.estado.auditorias).toEqual([
      expect.objectContaining({ action: "channel.webchat_updated" }),
      expect.objectContaining({
        action: "channel.webchat_paused",
        resourceId: conexao()?.id,
        metadata: { canal: "webchat", pausado: true },
      }),
    ]);
  });

  it("retomar grava pausado false e emite channel.webchat_paused com false", async () => {
    await criar();
    await atualizar({ config: { pausado: true } });
    h.estado.auditorias.length = 0;
    expect((await atualizar({ config: { pausado: false } })).status).toBe(200);
    expect(pausadoNaConexao()).toEqual({ pausado: false });
    expect(h.estado.auditorias).toEqual([
      expect.objectContaining({ action: "channel.webchat_updated" }),
      expect.objectContaining({ action: "channel.webchat_paused", metadata: { canal: "webchat", pausado: false } }),
    ]);
  });

  it("pausar de novo, já pausado, NÃO emite channel.webchat_paused", async () => {
    await criar();
    await atualizar({ config: { pausado: true } });
    h.estado.auditorias.length = 0;
    expect((await atualizar({ config: { pausado: true } })).status).toBe(200);
    expect(h.estado.auditorias).toEqual([expect.objectContaining({ action: "channel.webchat_updated" })]);
  });

  it("retomar um chat que nunca foi pausado NÃO emite channel.webchat_paused", async () => {
    await criar();
    h.estado.auditorias.length = 0;
    expect((await atualizar({ config: { pausado: false } })).status).toBe(200);
    expect(h.estado.auditorias.map((e) => e.action)).toEqual(["channel.webchat_updated"]);
  });

  it("mudar só a aparência não emite channel.webchat_paused e mantém a pausa", async () => {
    await criar();
    await atualizar({ config: { pausado: true } });
    h.estado.auditorias.length = 0;
    expect((await atualizar({ config: { titulo: "Atendimento" } })).status).toBe(200);
    expect(pausadoNaConexao()).toEqual({ pausado: true, titulo: "Atendimento" });
    expect(h.estado.auditorias.map((e) => e.action)).toEqual(["channel.webchat_updated"]);
  });

  it("pausado que não é booleano dá 422 e não grava", async () => {
    await criar();
    expect((await atualizar({ config: { pausado: "sim" } })).status).toBe(422);
    expect(conexao()?.metadata).toEqual({});
    expect(h.estado.auditorias).toHaveLength(1);
  });

  it("em acompanhamento de suporte, pausar dá 403 antes do efeito e sem audit", async () => {
    await criar();
    h.estado.auditorias.length = 0;
    h.estado.suporte = true;
    expect((await atualizar({ config: { pausado: true } })).status).toBe(403);
    expect(conexao()?.metadata).toEqual({});
    expect(h.estado.auditorias).toHaveLength(0);
  });

  it("o audit de pausa não leva a chave pública", async () => {
    await criar();
    const chave = conexao()?.webchat_public_key as string;
    await atualizar({ config: { pausado: true } });
    expect(JSON.stringify(h.estado.auditorias)).not.toContain(chave);
  });
});

describe("girar a chave", () => {
  it("troca a chave, invalida a antiga e audita sem mostrar nenhuma das duas", async () => {
    await criar();
    const antiga = conexao()?.webchat_public_key as string;
    h.estado.auditorias.length = 0;

    const res = await girar();
    expect(res.status).toBe(200);
    const nova = ((await corpoDe(res)).data.public_key as string);
    expect(nova).toMatch(/^wck_/);
    expect(nova).not.toBe(antiga);
    expect(conexao()?.webchat_public_key).toBe(nova);
    expect(h.estado.auditorias).toEqual([
      expect.objectContaining({ action: "channel.webchat_key_rotated" }),
    ]);
    expect(JSON.stringify(h.estado.auditorias)).not.toContain(nova);
    expect(JSON.stringify(h.estado.auditorias)).not.toContain(antiga);
  });

  it("sem conexão, responde 404", async () => {
    expect((await girar()).status).toBe(404);
  });
});

describe("GET", () => {
  it("sem conexão, diz que não há; com conexão, devolve a chave pública e a configuração", async () => {
    expect((await corpoDe(await ler())).data.connected).toBe(false);
    await criar({ allowed_origins: ["https://loja.exemplo.com.br"] });
    const corpo = (await corpoDe(await ler())).data;
    expect(corpo).toMatchObject({
      connected: true,
      display_name: "Chat no site",
      status: "WORKING",
      allowed_origins: ["https://loja.exemplo.com.br"],
      config: {},
    });
    expect(corpo.public_key).toBe(conexao()?.webchat_public_key);
  });
});
