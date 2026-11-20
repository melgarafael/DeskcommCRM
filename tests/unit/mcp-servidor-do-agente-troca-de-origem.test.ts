/**
 * Servidor MCP do agente em `oauth_por_contato` (#3857): os tokens de contato
 * pertencem à configuração que os emitiu. Editar o servidor trocando a ORIGEM
 * (endereço, modo ou `client_id`) revoga e apaga esses acessos com a
 * configuração ANTIGA, antes de gravar a nova — o próximo turno não pode
 * mandar o token ao host novo. Trocar só o nome não mexe em nada.
 *
 * E o servidor novo registra no DCR o endereço de retorno DELE (por servidor),
 * com o id que a tela reservou — e com o nome visível da organização
 * (`display_name`) no `client_name`: a tabela não tem `name`, e ler `name`
 * mandava "Marca —" com o nome vazio à tela de consentimento do terceiro.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoEmMemoria, type BancoEmMemoria } from "@/lib/mcp/servidor-externo/do-agente/banco-em-memoria.test-helper";
import type { Tables } from "@/lib/database.types";
import type * as Oauth from "@/lib/mcp/servidor-externo/do-agente/oauth";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";
const AGENTE = "a9e1c111-0000-4000-8000-000000000001";
const SERVIDOR = "5e5e5e5e-0000-4000-8000-000000000001";
const ID_NOVO = "5e5e5e5e-0000-4000-8000-0000000000aa";
const ANTIGO = "https://mcp-antigo.example.com/mcp";

let banco: BancoEmMemoria;
/** O endpoint gravado no banco no instante em que a revogação foi chamada. */
const revogacoes: Array<{ servidorEndpoint: string; noBanco: unknown }> = [];
const registros: Array<{ redirectUri: string; nomeDoCliente: string }> = [];
/** A linha com o tipo de PRODUÇÃO: um nome de coluna inventado não compila. */
const ORGANIZACAO: Pick<Tables<"organizations">, "id" | "display_name" | "legal_name"> = {
  id: ORG,
  display_name: "Clínica Sorriso",
  legal_name: "Sorriso Odontologia Ltda",
};

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "u1", support: null }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: "admin" }),
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco.cliente }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Marca" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/mcp/servidor-externo/do-agente/revogacao", () => ({
  revogarAcessosDoServidor: async (_db: unknown, servidor: { endpoint: string }) => {
    revogacoes.push({ servidorEndpoint: servidor.endpoint, noBanco: banco.tabelas.ai_agent_mcp_servers![0]!.endpoint });
    return 1;
  },
}));
vi.mock("@/lib/mcp/servidor-externo/do-agente/oauth", async (original) => ({
  ...(await original<typeof Oauth>()),
  descobrir: async (endpoint: string) => {
    const o = new URL(endpoint).origin;
    return {
      recurso: endpoint,
      emissor: o,
      authorization_endpoint: `${o}/authorize`,
      token_endpoint: `${o}/token`,
      registration_endpoint: `${o}/register`,
      revocation_endpoint: `${o}/revoke`,
      escopos_suportados: [],
      metodosDeAutenticacaoNoToken: ["none"],
    };
  },
  registrarCliente: async (_url: string, entrada: { redirectUri: string; nomeDoCliente: string }) => {
    registros.push({ redirectUri: entrada.redirectUri, nomeDoCliente: entrada.nomeDoCliente });
    return "cliente-novo";
  },
}));

import { salvarServidorMcpDoAgente } from "@/app/actions/agents/servidoresMcpDoAgente";

function entrada(p: Partial<{ nome: string; endpoint: string; modo: string; oauthClientId: string }> = {}) {
  return { nome: "Casa", endpoint: ANTIGO, modo: "oauth_por_contato", ...p };
}

beforeEach(() => {
  revogacoes.length = 0;
  registros.length = 0;
  const o = new URL(ANTIGO).origin;
  banco = bancoEmMemoria({
    ai_agents: [{ id: AGENTE, organization_id: ORG }],
    organizations: [{ ...ORGANIZACAO }],
    ai_agent_mcp_servers: [
      {
        id: SERVIDOR,
        organization_id: ORG,
        agent_id: AGENTE,
        nome: "Casa",
        slug: "casa",
        endpoint: ANTIGO,
        modo_autenticacao: "oauth_por_contato",
        oauth_client_id: "cliente-antigo",
        oauth_metadados: {
          recurso: ANTIGO,
          emissor: o,
          authorization_endpoint: `${o}/authorize`,
          token_endpoint: `${o}/token`,
          revocation_endpoint: `${o}/revoke`,
          cliente_dinamico: false,
          descoberto_em: new Date().toISOString(),
        },
        escopos_pedidos: [],
        escrita_delegada: false,
        retencao_apos_encerramento_horas: 0,
        ativo: true,
      },
    ],
  });
});

describe("editar a origem dos tokens revoga os acessos com a configuração antiga, antes de gravar", () => {
  it("endereço novo: revoga com o endereço ANTIGO, ainda gravado no banco", async () => {
    const r = await salvarServidorMcpDoAgente(AGENTE, SERVIDOR, entrada({ endpoint: "https://mcp-novo.example.com/mcp" }));
    expect(r.ok).toBe(true);
    expect(revogacoes).toEqual([{ servidorEndpoint: ANTIGO, noBanco: ANTIGO }]);
    expect(banco.tabelas.ai_agent_mcp_servers![0]!.endpoint).toBe("https://mcp-novo.example.com/mcp");
  });

  it("client_id novo ou saída do modo OAuth também revogam", async () => {
    await salvarServidorMcpDoAgente(AGENTE, SERVIDOR, entrada({ oauthClientId: "outro-cliente" }));
    expect(revogacoes).toHaveLength(1);
    banco.tabelas.ai_agent_mcp_servers![0]!.oauth_client_id = "cliente-antigo";
    await salvarServidorMcpDoAgente(AGENTE, SERVIDOR, entrada({ modo: "nenhuma" }));
    expect(revogacoes).toHaveLength(2);
  });

  it("controle: trocar só o nome não revoga nada", async () => {
    const r = await salvarServidorMcpDoAgente(AGENTE, SERVIDOR, entrada({ nome: "Casa Nova", oauthClientId: "cliente-antigo" }));
    expect(r.ok).toBe(true);
    expect(revogacoes).toEqual([]);
  });
});

describe("servidor novo: o DCR registra o endereço de retorno DESTE servidor", () => {
  it("com o id reservado pela tela, que vira o id do servidor", async () => {
    const r = await salvarServidorMcpDoAgente(AGENTE, null, entrada({ nome: "Outro", endpoint: "https://mcp-novo.example.com/mcp" }), ID_NOVO);
    expect(r.ok && r.data.id).toBe(ID_NOVO);
    expect(registros).toEqual([
      {
        redirectUri: expect.stringMatching(new RegExp(`/api/v1/mcp-oauth/callback/${ID_NOVO}$`)),
        nomeDoCliente: "Marca — Clínica Sorriso",
      },
    ]);
    expect(r.ok && r.data.redirectUri).toBe(registros[0]!.redirectUri);
  });
});
