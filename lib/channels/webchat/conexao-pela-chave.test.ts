/**
 * `conexaoPelaChave` devolve a lista de origens que podem abrir a janela (F2, Task 3).
 * O dublê registra as colunas pedidas e filtra por `eq`/`is`, como o cliente real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { conexaoPelaChave, conexaoPeloId } from "@/lib/channels/webchat/conexao-pela-chave";

const h = vi.hoisted(() => ({
  moduloLigado: true,
  colunasPedidas: [] as string[],
}));

vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.example.com" } }));
vi.mock("@/lib/webhooks/url-publica", () => ({ enderecoDaPropriaMaquina: () => false }));
vi.mock("@/lib/channels/webchat/modulo", () => ({ chatNoSiteLigado: async () => h.moduloLigado }));

const ORG = "22222222-2222-4222-8222-222222222222";
const CS = "11111111-1111-4111-8111-111111111111";
const CHAVE = `wck_${"A".repeat(43)}`;

function bancoCom(conexao: Record<string, unknown> | null) {
  return {
    from(tabela: string) {
      const filtros: Array<(linha: Record<string, unknown>) => boolean> = [];
      const consulta = {
        select: (colunas: string) => {
          if (tabela === "channel_sessions") h.colunasPedidas.push(colunas);
          return consulta;
        },
        eq: (coluna: string, valor: unknown) => {
          filtros.push((linha) => linha[coluna] === valor);
          return consulta;
        },
        is: (coluna: string, valor: null) => {
          filtros.push((linha) => (linha[coluna] ?? null) === valor);
          return consulta;
        },
        maybeSingle: async () => {
          if (tabela === "organizations") {
            return { data: { status: "active" }, error: null };
          }
          const linha = conexao && filtros.every((f) => f(conexao)) ? conexao : null;
          return { data: linha, error: null };
        },
      };
      return consulta;
    },
  } as never;
}

const conexaoBase = {
  id: CS,
  organization_id: ORG,
  provider: "webchat",
  webchat_public_key: CHAVE,
  archived_at: null,
  metadata: {},
};

describe("conexaoPelaChave: origens da conexão", () => {
  beforeEach(() => {
    h.moduloLigado = true;
    h.colunasPedidas.length = 0;
  });

  it("devolve as origens da coluna webchat_allowed_origins", async () => {
    const r = await conexaoPelaChave(
      bancoCom({ ...conexaoBase, webchat_allowed_origins: ["https://a.example.com", "https://b.example.com"] }),
      CHAVE,
    );
    expect(r?.allowedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("pede a coluna de origens na consulta da conexão", async () => {
    await conexaoPelaChave(bancoCom({ ...conexaoBase, webchat_allowed_origins: [] }), CHAVE);
    expect(h.colunasPedidas.join(",")).toContain("webchat_allowed_origins");
  });

  it("coluna ausente ou nula vira lista vazia, sem derrubar a leitura", async () => {
    const r = await conexaoPelaChave(bancoCom({ ...conexaoBase, webchat_allowed_origins: null }), CHAVE);
    expect(r?.allowedOrigins).toEqual([]);
    const s = await conexaoPelaChave(bancoCom({ ...conexaoBase }), CHAVE);
    expect(s?.allowedOrigins).toEqual([]);
  });

  it("não muda o resto do retorno: id, organização e configuração seguem como antes", async () => {
    const r = await conexaoPelaChave(
      bancoCom({ ...conexaoBase, webchat_allowed_origins: ["https://a.example.com"], metadata: { webchat: { titulo: "Oi" } } }),
      CHAVE,
    );
    expect(r).toEqual({
      id: CS,
      organizationId: ORG,
      config: { titulo: "Oi" },
      allowedOrigins: ["https://a.example.com"],
    });
  });

  it("chave inexistente continua devolvendo null", async () => {
    expect(await conexaoPelaChave(bancoCom(null), CHAVE)).toBeNull();
  });
});

describe("conexaoPelaChave e conexaoPeloId: chat pausado", () => {
  beforeEach(() => {
    h.moduloLigado = true;
  });

  it("chat pausado devolve null pela chave e pelo id, o mesmo caso de chave inexistente", async () => {
    const pausada = { ...conexaoBase, metadata: { webchat: { pausado: true } } };
    expect(await conexaoPelaChave(bancoCom(pausada), CHAVE)).toBeNull();
    expect(await conexaoPeloId(bancoCom(pausada), CS)).toBeNull();
  });

  it("chat pausado com configuração inválida (chave estranha) continua pausado: a pausa não falha aberta", async () => {
    const pausadaComLixo = {
      ...conexaoBase,
      metadata: { webchat: { pausado: true, chave_estranha: 1, titulo: "x".repeat(200) } },
    };
    expect(await conexaoPelaChave(bancoCom(pausadaComLixo), CHAVE)).toBeNull();
    expect(await conexaoPeloId(bancoCom(pausadaComLixo), CS)).toBeNull();
  });

  it("pausado false segue entregando a conexão", async () => {
    const retomada = { ...conexaoBase, metadata: { webchat: { pausado: false } } };
    expect(await conexaoPelaChave(bancoCom(retomada), CHAVE)).toEqual({
      id: CS,
      organizationId: ORG,
      config: { pausado: false },
      allowedOrigins: [],
    });
  });
});
