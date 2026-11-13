/**
 * O GATEWAY DE PAGAMENTO POR ORGANIZAÇÃO — issue #4058, fatia 1.
 *
 * O que este arquivo prende, e por quê:
 *
 *  1. organização com configuração própria usa a DELA (hoje isso não existe: o
 *     provedor é lido da instalação, sem dimensão de organização);
 *  2. organização sem configuração — e organização com a configuração
 *     DESLIGADA — herda a da instalação;
 *  3. credencial de OUTRA organização nunca é usada: a linha relida é
 *     conferida, e a recusa é nomeada;
 *  4. credencial ilegível NÃO herda a da instalação (a venda do cliente cairia
 *     na conta de outra pessoa);
 *  5. desligar não apaga a linha (a cobrança já emitida referencia ela);
 *  6. o estado para a tela nunca carrega a chave — nem a da organização, nem a
 *     herdada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  provedorDaInstalacao: vi.fn(),
  chaveDoProvedor: vi.fn(),
  segredoDoWebhook: vi.fn(),
  adaptador: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/cobranca/configuracao", () => ({
  provedorDaInstalacao: deps.provedorDaInstalacao,
  chaveDoProvedor: deps.chaveDoProvedor,
  segredoDoWebhook: deps.segredoDoWebhook,
}));
vi.mock("@/lib/cobranca/provedores", () => ({ adaptador: deps.adaptador }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

/**
 * A cifra é dublê de propósito: o envelope real depende de `AI_CRED_AES_KEY` no
 * ambiente, e o que este teste mede é o CONTRATO do resolvedor (quem vence,
 * quem é recusado), não o AES. O envelope de verdade é coberto por
 * `lib/crypto/*` e pelas rotas do trunk/banco externo.
 */
vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: (plaintext: string) => ({
    // Base64 e não o texto cru: o teste de "nada em claro" procura a chave na
    // linha gravada, e um dublê que carrega o plaintext acusaria o dublê.
    ciphertext: Buffer.from(`cifrado:${Buffer.from(plaintext, "utf8").toString("base64")}`, "utf8"),
    iv: Buffer.from("iv", "utf8"),
    tag: Buffer.from("tag", "utf8"),
    last4: plaintext.slice(-4),
  }),
  decryptKey: ({ ciphertext }: { ciphertext: Buffer }) => {
    const texto = ciphertext.toString("utf8");
    if (!texto.startsWith("cifrado:")) throw new Error("envelope inválido");
    return Buffer.from(texto.slice("cifrado:".length), "base64").toString("utf8");
  },
  byteaToBuffer: (value: string) => Buffer.from(String(value), "utf8"),
  bufToBytea: (buf: Buffer) => buf.toString("utf8"),
}));

import {
  desligarGatewayDaOrganizacao,
  estadoParaTela,
  gatewayDaOrganizacao,
  guardarGatewayDaOrganizacao,
} from "@/lib/pagamentos/gateway-da-organizacao";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
// Chave com o formato REAL do Asaas (`$aact_hmlg_` + 16+): a instalação herda
// Asaas nesta bancada, e uma chave com formato de outro provedor faria o
// resolvedor recusar por modo desconhecido — defeito do fixture, não do código.
const CHAVE_DA_INSTALACAO = "$aact_hmlg_instalacao000000";
const CHAVE_DA_ORG_A = "sk_test_organizacao_a_1111";
const CHAVE_DA_ORG_B = "sk_test_organizacao_b_2222";

type Linha = Record<string, unknown>;

/** Dublê do client de service role: uma tabela só, com as cadeias que o módulo usa. */
function banco(linhas: Linha[] = []) {
  const estado = {
    linhas: [...linhas],
    upserts: [] as Linha[],
    updates: [] as Linha[],
    filtros: [] as unknown[][],
    apagou: false,
  };

  const client = {
    from(tabela: string) {
      expect(tabela).toBe("organization_payment_gateways");
      return {
        select: () => ({
          eq: (coluna: string, valor: unknown) => {
            estado.filtros.push([coluna, valor]);
            const filtrada = () => estado.linhas.filter((l) => l[coluna] === valor);
            const resultado = { data: filtrada()[0] ?? null, error: null };
            return {
              maybeSingle: async () => resultado,
              single: async () => resultado,
              // `.update(...).eq(...).select(...)`
              then: undefined,
            };
          },
        }),
        upsert: async (payload: Linha) => {
          estado.upserts.push(payload);
          const idx = estado.linhas.findIndex(
            (l) => l.organization_id === payload.organization_id,
          );
          if (idx >= 0) estado.linhas[idx] = { ...estado.linhas[idx], ...payload };
          else estado.linhas.push(payload);
          return { error: null };
        },
        update: (payload: Linha) => ({
          eq: (coluna: string, valor: unknown) => {
            estado.filtros.push([coluna, valor]);
            estado.updates.push(payload);
            const alvo = estado.linhas.filter((l) => l[coluna] === valor);
            for (const l of alvo) Object.assign(l, payload);
            return {
              select: async () => ({ data: alvo.map((l) => ({ organization_id: l.organization_id })), error: null }),
            };
          },
        }),
        delete: () => {
          estado.apagou = true;
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };

  return { client, estado };
}

function linhaDaOrg(overrides: Linha = {}): Linha {
  return {
    organization_id: ORG_A,
    provider: "stripe",
    mode: "teste",
    api_key_encrypted: `cifrado:${Buffer.from(CHAVE_DA_ORG_A, "utf8").toString("base64")}`,
    api_key_iv: "iv",
    api_key_tag: "tag",
    api_key_last4: "1111",
    webhook_secret_encrypted: null,
    webhook_secret_iv: null,
    webhook_secret_tag: null,
    webhook_secret_last4: null,
    is_active: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.provedorDaInstalacao.mockResolvedValue("asaas");
  deps.chaveDoProvedor.mockResolvedValue(CHAVE_DA_INSTALACAO);
  deps.segredoDoWebhook.mockResolvedValue("segredo-da-instalacao");
  deps.audit.mockResolvedValue(undefined);
});

describe("gatewayDaOrganizacao", () => {
  it("organização com configuração própria usa a DELA, e a instalação não é consultada", async () => {
    const { client } = banco([linhaDaOrg()]);

    const r = await gatewayDaOrganizacao(client as never, ORG_A);

    expect(r).toEqual({
      ok: true,
      gateway: {
        provider: "stripe",
        modo: "teste",
        apiKey: CHAVE_DA_ORG_A,
        webhookSecret: null,
        origem: "organizacao",
      },
    });
    expect(deps.chaveDoProvedor).not.toHaveBeenCalled();
    expect(deps.provedorDaInstalacao).not.toHaveBeenCalled();
  });

  it("organização sem configuração herda a instalação (org nova não quebra)", async () => {
    const { client } = banco([]);

    const r = await gatewayDaOrganizacao(client as never, ORG_A);

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava herança");
    expect(r.gateway.origem).toBe("instalacao");
    expect(r.gateway.provider).toBe("asaas");
    expect(r.gateway.apiKey).toBe(CHAVE_DA_INSTALACAO);
    expect(r.gateway.webhookSecret).toBe("segredo-da-instalacao");
  });

  it("configuração DESLIGADA herda a instalação e a linha continua no banco", async () => {
    const { client, estado } = banco([linhaDaOrg({ is_active: false })]);

    const r = await gatewayDaOrganizacao(client as never, ORG_A);

    expect(r.ok && r.gateway.origem).toBe("instalacao");
    expect(estado.linhas).toHaveLength(1);
    expect(estado.apagou).toBe(false);
  });

  it("herança sem NADA configurado na instalação é `sem_gateway`, não uma chave vazia", async () => {
    deps.provedorDaInstalacao.mockResolvedValue(null);
    const { client } = banco([]);

    const r = await gatewayDaOrganizacao(client as never, ORG_A);

    expect(r).toEqual({ ok: false, erro: "sem_gateway" });
  });

  it("⭐ credencial de OUTRA organização é recusada, mesmo que a consulta a devolva", async () => {
    // Simula o defeito medido na #236: a busca devolve a linha do vizinho com o
    // `error` descartado. O filtro é por organização, então isso só acontece se
    // a consulta mudar — é exatamente o que a conferência explícita cobre.
    const { client } = banco([linhaDaOrg({ organization_id: ORG_B, api_key_encrypted: `cifrado:${Buffer.from(CHAVE_DA_ORG_B, "utf8").toString("base64")}` })]);
    const espiao = vi.spyOn(client, "from");
    espiao.mockReturnValue({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: linhaDaOrg({ organization_id: ORG_B, api_key_encrypted: `cifrado:${Buffer.from(CHAVE_DA_ORG_B, "utf8").toString("base64")}` }), error: null }) }),
      }),
    } as never);

    const r = await gatewayDaOrganizacao(client as never, ORG_A);

    expect(r).toEqual({ ok: false, erro: "credencial_de_outra_organizacao" });
    const serializado = JSON.stringify(r);
    expect(serializado).not.toContain(CHAVE_DA_ORG_B);
    expect(deps.chaveDoProvedor).not.toHaveBeenCalled();
  });

  it("credencial ilegível NÃO herda a da instalação (recusa nomeada)", async () => {
    // Envelope corrompido: `decryptKey` do dublê lança.
    const { client } = banco([linhaDaOrg({ api_key_encrypted: "corrompido" })]);

    const r = await gatewayDaOrganizacao(client as never, ORG_A);

    expect(r).toEqual({ ok: false, erro: "credencial_ilegivel" });
    expect(deps.chaveDoProvedor).not.toHaveBeenCalled();
  });

  it("erro de leitura não vira herança silenciosa", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "42501", message: "sem permissão" } }) }),
        }),
      }),
    };

    const r = await gatewayDaOrganizacao(client as never, ORG_A);

    expect(r).toEqual({ ok: false, erro: "leitura_falhou" });
    expect(deps.chaveDoProvedor).not.toHaveBeenCalled();
  });
});

describe("estadoParaTela — o segredo não sai daqui", () => {
  it("configuração própria: devolve provedor, modo e last4, nunca a chave", async () => {
    const { client } = banco([linhaDaOrg()]);

    const estado = await estadoParaTela(client as never, ORG_A);

    expect(estado).toEqual({
      origem: "organizacao",
      provider: "stripe",
      modo: "teste",
      apiKeyLast4: "1111",
      webhookSecretLast4: null,
      configurada: true,
      isActive: true,
    });
    expect(JSON.stringify(estado)).not.toContain(CHAVE_DA_ORG_A);
  });

  it("herdando a instalação: nem os 4 últimos da chave da instalação aparecem", async () => {
    const { client } = banco([]);

    const estado = await estadoParaTela(client as never, ORG_A);

    expect(estado.origem).toBe("instalacao");
    expect(estado.provider).toBe("asaas");
    expect(estado.apiKeyLast4).toBeNull();
    expect(JSON.stringify(estado)).not.toContain(CHAVE_DA_INSTALACAO.slice(-4));
    expect(JSON.stringify(estado)).not.toContain(CHAVE_DA_INSTALACAO);
  });

  it("linha de OUTRA organização não vaza nem o last4 (cai para a herança)", async () => {
    const { client } = banco([linhaDaOrg({ organization_id: ORG_B, api_key_last4: "2222" })]);
    const espiao = vi.spyOn(client, "from");
    espiao.mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { organization_id: ORG_B, provider: "stripe", mode: "teste", api_key_last4: "2222", webhook_secret_last4: null, is_active: true },
            error: null,
          }),
        }),
      }),
    } as never);

    const estado = await estadoParaTela(client as never, ORG_A);

    expect(estado.apiKeyLast4).toBeNull();
    expect(estado.configurada).toBe(false);
  });
});

describe("guardarGatewayDaOrganizacao", () => {
  const pedidoBase = {
    organizationId: ORG_A,
    userId: "u-1",
    provider: "stripe" as const,
    isActive: true,
  };

  it("confere a chave NO PROVEDOR antes de gravar e cifra o que grava", async () => {
    const { client, estado } = banco([]);
    const testarChave = vi.fn().mockResolvedValue({ ok: true, modo: "teste" });
    deps.adaptador.mockReturnValue({ testarChave });

    const r = await guardarGatewayDaOrganizacao({
      ...pedidoBase,
      admin: client as never,
      apiKey: CHAVE_DA_ORG_A,
    });

    expect(r).toEqual({ ok: true });
    // A chave conferida é a da ORGANIZAÇÃO, não a da instalação.
    const opcoes = deps.adaptador.mock.calls.at(0)?.[1] as { chave: () => Promise<string | null> };
    await expect(opcoes.chave()).resolves.toBe(CHAVE_DA_ORG_A);
    expect(deps.chaveDoProvedor).not.toHaveBeenCalled();

    const gravado = estado.upserts[0]!;
    expect(gravado).toMatchObject({
      organization_id: ORG_A,
      provider: "stripe",
      mode: "teste",
      api_key_last4: "1111",
      is_active: true,
    });
    // Nunca plaintext em disco.
    expect(JSON.stringify(gravado)).not.toContain(CHAVE_DA_ORG_A);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pagamento.gateway_configurado", organizationId: ORG_A }),
    );
  });

  it("chave recusada pelo provedor vira erro NOMEADO e nada é gravado", async () => {
    const { client, estado } = banco([]);
    deps.adaptador.mockReturnValue({ testarChave: vi.fn().mockResolvedValue({ ok: false, motivo: "chave_invalida" }) });

    const r = await guardarGatewayDaOrganizacao({
      ...pedidoBase,
      admin: client as never,
      apiKey: "sk_test_errada",
    });

    expect(r).toEqual({ ok: false, erro: "credencial_invalida" });
    expect(estado.upserts).toHaveLength(0);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("provedor fora do ar é erro nomeado, distinto de chave inválida", async () => {
    const { client, estado } = banco([]);
    deps.adaptador.mockReturnValue({ testarChave: vi.fn().mockResolvedValue({ ok: false, motivo: "provedor_fora" }) });

    const r = await guardarGatewayDaOrganizacao({ ...pedidoBase, admin: client as never, apiKey: "sk_test_x" });

    expect(r).toEqual({ ok: false, erro: "provedor_fora" });
    expect(estado.upserts).toHaveLength(0);
  });

  it("trocar de provedor sem chave nova é recusado (não emparelha chave e provedor)", async () => {
    const { client, estado } = banco([linhaDaOrg({ provider: "stripe" })]);

    const r = await guardarGatewayDaOrganizacao({
      ...pedidoBase,
      provider: "asaas",
      admin: client as never,
    });

    expect(r).toEqual({ ok: false, erro: "credencial_obrigatoria" });
    expect(estado.upserts).toHaveLength(0);
  });

  it("atualizar sem chave nova mantém a credencial já cifrada", async () => {
    const { client, estado } = banco([linhaDaOrg()]);

    const r = await guardarGatewayDaOrganizacao({
      ...pedidoBase,
      admin: client as never,
      isActive: false,
    });

    expect(r).toEqual({ ok: true });
    expect(estado.upserts[0]).toMatchObject({
      api_key_encrypted: `cifrado:${Buffer.from(CHAVE_DA_ORG_A, "utf8").toString("base64")}`,
      api_key_last4: "1111",
      mode: "teste",
      is_active: false,
    });
    // Sem chave digitada, o provedor não é chamado.
    expect(deps.adaptador).not.toHaveBeenCalled();
  });
});

describe("desligarGatewayDaOrganizacao", () => {
  it("desliga sem apagar: update de `is_active`, nunca delete", async () => {
    const { client, estado } = banco([linhaDaOrg()]);

    const r = await desligarGatewayDaOrganizacao(client as never, ORG_A, "u-1");

    expect(r).toEqual({ ok: true });
    expect(estado.apagou).toBe(false);
    expect(estado.updates[0]).toMatchObject({ is_active: false, updated_by: "u-1" });
    expect(estado.linhas[0]).toMatchObject({
      api_key_encrypted: `cifrado:${Buffer.from(CHAVE_DA_ORG_A, "utf8").toString("base64")}`,
      is_active: false,
    });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pagamento.gateway_desligado", organizationId: ORG_A }),
    );
  });

  it("desligar quem já herda é idempotente (nenhum audit de fantasia)", async () => {
    const { client } = banco([]);

    const r = await desligarGatewayDaOrganizacao(client as never, ORG_A, "u-1");

    expect(r).toEqual({ ok: true });
    expect(deps.audit).not.toHaveBeenCalled();
  });
});
