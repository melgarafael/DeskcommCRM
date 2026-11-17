/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * OAuth POR CONTATO de servidor MCP externo (migration 9095), ponta a ponta,
 * contra um stub HTTP de verdade que implementa RFC 9728 (recurso protegido),
 * RFC 8414 (metadados do AS), RFC 7591 (registro dinâmico), PKCE S256,
 * RFC 7009 (revogação) e o Streamable HTTP do MCP — no padrão do stub de ERP
 * de `../externo.test.ts`.
 *
 * Cada `describe` prova um requisito verificável do documento da feature
 * (§5 e §8): o número entre colchetes é o item.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auditSpy = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));
const logSpy = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: {
    info: (...a: unknown[]) => logSpy(...a),
    warn: (...a: unknown[]) => logSpy(...a),
    error: (...a: unknown[]) => logSpy(...a),
    debug: (...a: unknown[]) => logSpy(...a),
  },
}));

vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";

import { cifrar } from "../cifra";
import { toolIdRemoto } from "../ids";
import { bancoEmMemoria, type BancoEmMemoria } from "./banco-em-memoria.test-helper";
import { carregarServidoresDoAgenteNoTurno, type ServidorDoAgenteNoTurno } from "./carregar";
import { consumirPedido, credencialDoContato, escoposDoPedido, renovarCredencial } from "./credencial";
import { ErroDeOauth, descobrir, registrarCliente } from "./oauth";
import { TIMEOUT_DA_CHAMADA_NO_TURNO_MS, TIMEOUT_DA_DESCOBERTA_NO_TURNO_MS } from "../tempos-do-turno";
import { iniciarAutorizacao, processarRetorno } from "./retorno";
import { revogarAcessosDoContato, revogarAcessosDoServidor, revogarVencidas } from "./revogacao";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";
const ORG_Y = "0f0f0f0f-0000-4000-8000-0000000000f0";
const AGENTE = "a9e1c111-0000-4000-8000-000000000001";
const SERVIDOR = "5e5e5e5e-0000-4000-8000-000000000001";
const CONTATO_A = "c0000000-0000-4000-8000-00000000000a";
const CONTATO_B = "c0000000-0000-4000-8000-00000000000b";
const CONVERSA_A = "d0000000-0000-4000-8000-00000000000a";
const CONVERSA_B = "d0000000-0000-4000-8000-00000000000b";
const OUTRO_SERVIDOR = "5e5e5e5e-0000-4000-8000-000000000002";

// ─── O stub: MCP + authorization server no mesmo processo ──────────────────

let http: Server;
let origem = "";
let endpoint = "";
const stub = {
  anunciaS256: true,
  expiraEmSegundos: 3600,
  codigos: new Map<string, { usuario: string; challenge: string; redirect: string; escopo: string }>(),
  acessos: new Map<string, { usuario: string; escopo: string }>(),
  refreshs: new Map<string, { usuario: string; escopo: string }>(),
  revogados: [] as string[],
  chamadas: [] as Array<{ ferramenta: string; usuario: string; autorizacao: string | undefined; argumentos: unknown }>,
  refreshesFeitos: 0,
  emitidos: 0,
  fora: false,
  /** O que a metadata devolve em `issuer`/`resource`; `undefined` = o certo. */
  issuer: undefined as string | undefined,
  resource: undefined as string | undefined,
  /** O `/mcp` aceita o pedido e nunca responde. */
  trava: false,
};

function emitir(usuario: string, escopo: string) {
  stub.emitidos += 1;
  const at = `AT-MARCADOR-${usuario}-${stub.emitidos}`;
  const rt = `RT-MARCADOR-${usuario}-${stub.emitidos}`;
  stub.acessos.set(at, { usuario, escopo });
  stub.refreshs.set(rt, { usuario, escopo });
  return { access_token: at, refresh_token: rt, token_type: "Bearer", expires_in: stub.expiraEmSegundos, scope: escopo };
}

function json(res: ServerResponse, status: number, corpo: unknown, cab: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...cab });
  res.end(JSON.stringify(corpo));
}

function rpc(mensagem: any, usuario: string, _escopo: string): any {
  const { id, method, params } = mensagem;
  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "casa-stub", version: "1" } } };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          { name: "casa_ler", description: "Lê o estado da casa", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
          { name: "casa_ligar", description: "Liga um aparelho", inputSchema: { type: "object", properties: { aparelho: { type: "string" } }, required: ["aparelho"] } },
        ],
      },
    };
  }
  if (method === "tools/call") {
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `casa de ${usuario}: ${params?.name} ok` }] } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "x" } };
}

beforeAll(async () => {
  http = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origem);
    let corpo = "";
    req.on("data", (p) => (corpo += p));
    req.on("end", () => {
      if (stub.fora) return json(res, 503, { error: "fora" });
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json(res, 200, { resource: stub.resource ?? endpoint, authorization_servers: [origem], scopes_supported: ["casa:leitura", "casa:escrita"] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(res, 200, {
          issuer: stub.issuer ?? origem,
          authorization_endpoint: `${origem}/authorize`,
          token_endpoint: `${origem}/token`,
          registration_endpoint: `${origem}/register`,
          revocation_endpoint: `${origem}/revoke`,
          ...(stub.anunciaS256 ? { code_challenge_methods_supported: ["S256"] } : { code_challenge_methods_supported: ["plain"] }),
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register-gigante") {
        // 1 MB de JSON VÁLIDO, sem content-length (chunked): só o teto de bytes o recusa.
        res.writeHead(201, { "content-type": "application/json" });
        res.write('{"client_id":"gigante","p":"');
        for (let i = 0; i < 16; i += 1) res.write("a".repeat(64 * 1024));
        return res.end('"}');
      }
      if (url.pathname === "/register-lento") {
        // Cabeçalhos na hora, corpo a conta-gotas: termina VÁLIDO só depois de 4 s.
        res.writeHead(201, { "content-type": "application/json" });
        res.write('{"client_id":"lento"');
        const gota = setInterval(() => res.write(" "), 50);
        const fim = setTimeout(() => {
          clearInterval(gota);
          res.end("}");
        }, 4000);
        res.on("close", () => {
          clearInterval(gota);
          clearTimeout(fim);
        });
        return;
      }
      if (url.pathname === "/register") {
        const r = JSON.parse(corpo);
        expect(r.token_endpoint_auth_method).toBe("none");
        return json(res, 201, { client_id: "cliente-dinamico-1", redirect_uris: r.redirect_uris });
      }
      if (url.pathname === "/authorize") {
        // O "login" do contato no terceiro: o teste diz quem é por `usuario`.
        const p = url.searchParams;
        expect(p.get("code_challenge_method")).toBe("S256");
        expect(p.get("resource")).toBe(endpoint);
        const code = `code-${stub.codigos.size + 1}`;
        stub.codigos.set(code, { usuario: p.get("usuario")!, challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")!, escopo: p.get("scope") ?? "" });
        res.writeHead(302, { location: `${p.get("redirect_uri")}?code=${code}&state=${p.get("state")}` });
        return res.end();
      }
      if (url.pathname === "/token") {
        const f = new URLSearchParams(corpo);
        if (f.get("resource") !== endpoint) return json(res, 400, { error: "invalid_target" });
        if (f.get("grant_type") === "authorization_code") {
          const c = stub.codigos.get(f.get("code") ?? "");
          const desafio = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
          if (!c || c.challenge !== desafio || c.redirect !== f.get("redirect_uri")) return json(res, 400, { error: "invalid_grant" });
          // Como o beyond-MCP: o client_id do authorize tem de voltar NO CORPO.
          if (f.get("client_id") !== "cliente-dinamico-1") return json(res, 400, { error: "invalid_grant" });
          stub.codigos.delete(f.get("code")!);
          return json(res, 200, emitir(c.usuario, c.escopo));
        }
        if (f.get("grant_type") === "refresh_token") {
          stub.refreshesFeitos += 1;
          const r = stub.refreshs.get(f.get("refresh_token") ?? "");
          if (!r) return json(res, 400, { error: "invalid_grant" });
          stub.refreshs.delete(f.get("refresh_token")!); // rotação
          return json(res, 200, emitir(r.usuario, r.escopo));
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === "/revoke") {
        const t = new URLSearchParams(corpo).get("token")!;
        stub.revogados.push(t);
        stub.acessos.delete(t);
        stub.refreshs.delete(t);
        res.writeHead(200).end();
        return;
      }
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") return void res.writeHead(405).end();
        if (stub.trava) return;
        const at = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        const acesso = stub.acessos.get(at);
        if (!acesso) {
          return json(res, 401, { error: "unauthorized" }, {
            "www-authenticate": `Bearer resource_metadata="${origem}/.well-known/oauth-protected-resource/mcp"`,
          });
        }
        const mensagens = [JSON.parse(corpo)].flat();
        const chamada = mensagens.find((m) => m.method === "tools/call");
        if (chamada) {
          stub.chamadas.push({ ferramenta: chamada.params?.name, usuario: acesso.usuario, autorizacao: req.headers.authorization, argumentos: chamada.params?.arguments });
          if (chamada.params?.name === "casa_ligar" && !acesso.escopo.includes("casa:escrita")) {
            return json(res, 403, { error: "insufficient_scope" }, {
              "www-authenticate": 'Bearer error="insufficient_scope", scope="casa:escrita"',
            });
          }
        }
        const r = mensagens.filter((m) => m.id !== undefined).map((m) => rpc(m, acesso.usuario, acesso.escopo));
        return json(res, 200, r.length === 1 ? r[0] : r, { "mcp-session-id": "s1" });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  origem = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  endpoint = `${origem}/mcp`;
});

afterAll(async () => {
  http.closeAllConnections();
  await new Promise<void>((ok) => http.close(() => ok()));
});

/** Junta de teste: o stub mora no loopback, que o guard anti-SSRF recusa. */
const saida: FetchLike = (u, i) => fetch(u, { ...i, redirect: "manual" });
const rede = { fetch: saida };

let banco: BancoEmMemoria;

async function servidorCadastrado(opcoes: { escritaDelegada?: boolean; escopos?: string[] } = {}) {
  const d = await descobrir(endpoint, rede);
  const { metodosDeAutenticacaoNoToken: _m, ...meta } = d;
  const clientId = await registrarCliente(d.registration_endpoint!, { redirectUri: `http://localhost:3000/api/v1/mcp-oauth/callback/${SERVIDOR}`, nomeDoCliente: "Cliente de teste", escopos: [] }, rede);
  return {
    id: SERVIDOR,
    organization_id: ORG,
    agent_id: AGENTE,
    nome: "Minha Casa",
    slug: "casa",
    endpoint,
    modo_autenticacao: "oauth_por_contato",
    oauth_client_id: clientId,
    oauth_metadados: { ...meta, cliente_dinamico: true, descoberto_em: new Date().toISOString() },
    escopos_pedidos: opcoes.escopos ?? ["casa:leitura"],
    escrita_delegada: opcoes.escritaDelegada ?? false,
    retencao_apos_encerramento_horas: 0,
    ativo: true,
  };
}

beforeEach(async () => {
  Object.assign(stub, { anunciaS256: true, expiraEmSegundos: 3600, refreshesFeitos: 0, fora: false, issuer: undefined, resource: undefined, trava: false });
  stub.chamadas.length = 0;
  stub.revogados.length = 0;
  auditSpy.mockClear();
  logSpy.mockClear();
  banco = bancoEmMemoria({
    ai_agent_mcp_servers: [await servidorCadastrado()],
    contacts: [
      { id: CONTATO_A, organization_id: ORG, is_anonymized: false },
      { id: CONTATO_B, organization_id: ORG, is_anonymized: false },
    ],
    // Módulo opcional `mcp_por_agente` ligado (doc 252); o desligado tem caso próprio.
    platform_config: [{ chave: "MODULO_MCP_POR_AGENTE", valor: "ligado" }],
  });
});

const TOOL_IDS = [toolIdRemoto("casa_ler", "leitura", SERVIDOR), toolIdRemoto("casa_ligar", "escrita", SERVIDOR)];

function carga(contato: string | undefined, conversa?: string) {
  return carregarServidoresDoAgenteNoTurno(banco.cliente as never, ORG, AGENTE, TOOL_IDS, {
    ...(contato ? { contatoDoTurno: contato } : {}),
    ...(conversa ? { conversaDoTurno: conversa } : {}),
    fetch: saida,
  });
}

/**
 * O navegador do contato: link curto → AS (login como `usuario`) → callback.
 * `volta` troca o que chega ao callback (o servidor do endereço, o `iss`).
 */
async function contatoAutoriza(link: string, usuario: string, volta: { servidor?: string; iss?: string } = {}) {
  const state = link.split("/").pop()!;
  const inicio = await iniciarAutorizacao(banco.cliente as never, state);
  if (!inicio.ok) throw new Error(inicio.motivo);
  const destino = new URL(inicio.destino);
  destino.searchParams.set("usuario", usuario);
  const r = await fetch(destino, { redirect: "manual" });
  const retorno = new URL(r.headers.get("location")!);
  return processarRetorno(
    banco.cliente as never,
    {
      servidor: volta.servidor ?? retorno.pathname.split("/").pop()!,
      state: retorno.searchParams.get("state"),
      code: retorno.searchParams.get("code"),
      error: null,
      iss: volta.iss ?? null,
    },
    rede,
  );
}

async function pedirLink(contato: string, conversa: string, estado: "sem_autorizacao" | "pronto" = "sem_autorizacao") {
  const [s] = await carga(contato, conversa);
  expect(s?.estado).toBe(estado);
  const pedido = await s!.pedirAcesso!();
  return pedido!.link;
}

const auth = {
  organizationId: ORG,
  role: "ai_operator",
  actor: { type: "ai_agent", id: AGENTE, role: "ai_operator" },
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000001",
  scopes: ["mcp:read", "mcp:write"],
} as unknown as McpAuthResult;

function montar(servidores: ServidorDoAgenteNoTurno[], contato?: string) {
  const supabase = banco.cliente as never;
  return pickToolsFromMcp({
    supabase,
    ctx: { organizationId: ORG, role: auth.role, actor: auth.actor, apiTokenId: auth.apiTokenId, requestId: "r1", supabase } as unknown as McpContext,
    auth,
    toolIds: TOOL_IDS,
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    servidoresDoAgente: servidores,
    ...(contato ? { contatoDoTurno: contato } : {}),
  }) as unknown as Record<string, { execute: (a: unknown) => Promise<unknown> }>;
}

// ─── Descoberta e cadastro ──────────────────────────────────────────────────

describe("módulo opcional desligado (doc 252)", () => {
  it("o turno não monta servidor do agente, nem o de chave nem o de OAuth", async () => {
    banco.tabelas.platform_config = [{ chave: "MODULO_MCP_POR_AGENTE", valor: "desligado" }];
    expect(await carga(CONTATO_A, CONVERSA_A)).toEqual([]);
    banco.tabelas.platform_config = [];
    expect(await carga(CONTATO_A, CONVERSA_A)).toEqual([]);
    expect(stub.chamadas).toEqual([]);
    // Controle: a mesma carga, com o módulo ligado, monta o servidor.
    banco.tabelas.platform_config = [{ chave: "MODULO_MCP_POR_AGENTE", valor: "ligado" }];
    expect((await carga(CONTATO_A, CONVERSA_A)).map((s) => s.estado)).toEqual(["sem_autorizacao"]);
  });
});

describe("descoberta RFC 9728 + 8414 e registro RFC 7591 [§3, 5]", () => {
  it("descobre o AS pelo 401 + resource_metadata e registra cliente público", async () => {
    const d = await descobrir(endpoint, rede);
    expect(d.authorization_endpoint).toBe(`${origem}/authorize`);
    expect(d.revocation_endpoint).toBe(`${origem}/revoke`);
    expect(d.escopos_suportados).toEqual(["casa:leitura", "casa:escrita"]);
    expect(await registrarCliente(d.registration_endpoint!, { redirectUri: "http://x/cb", nomeDoCliente: "n", escopos: [] }, rede)).toBe("cliente-dinamico-1");
  });

  it("authorization server sem S256 → cadastro recusado com sem_s256 [5]", async () => {
    stub.anunciaS256 = false;
    await expect(descobrir(endpoint, rede)).rejects.toMatchObject({ codigo: "sem_s256" });
    await expect(descobrir(endpoint, rede)).rejects.toBeInstanceOf(ErroDeOauth);
  });

  it("issuer da metadata do AS diferente do emissor pedido → metadados_divergentes (RFC 8414 §3.3)", async () => {
    stub.issuer = "https://outro-emissor.example";
    await expect(descobrir(endpoint, rede)).rejects.toMatchObject({ codigo: "metadados_divergentes" });
  });

  it("resource da metadata do recurso diferente do endpoint → metadados_divergentes (RFC 9728 §3.3)", async () => {
    stub.resource = `${origem}/outro-mcp`;
    await expect(descobrir(endpoint, rede)).rejects.toMatchObject({ codigo: "metadados_divergentes" });
    stub.resource = "https://outro-host.example/mcp";
    await expect(descobrir(endpoint, rede)).rejects.toMatchObject({ codigo: "metadados_divergentes" });
  });

  it("controle: os mesmos identificadores com barra final e esquema em maiúsculo passam", async () => {
    stub.issuer = `${origem.replace("http://", "HTTP://")}/`;
    stub.resource = `${endpoint}/`;
    expect((await descobrir(endpoint, rede)).emissor).toBe(origem);
    // O `.well-known` da raiz descreve a ORIGEM: um endpoint dentro dela é deste recurso.
    stub.resource = origem;
    expect((await descobrir(endpoint, rede)).recurso).toBe(origem);
  });

  it("escopos do pedido ficam limitados aos do cadastro (step-up não amplia)", () => {
    expect(escoposDoPedido(["a", "b"], ["b", "zzz"])).toEqual(["b"]);
    expect(escoposDoPedido(["a"], ["zzz"])).toEqual(["a"]);
    expect(escoposDoPedido(["a"], undefined)).toEqual(["a"]);
  });
});

// ─── O fluxo do critério de aceite ──────────────────────────────────────────

describe("fluxo ponta a ponta: A autoriza, B recebe o próprio link [§8.2, 8.3, §5.1]", () => {
  it("sem token: só a ferramenta sintética monta; com token de A, a chamada sai com o token DE A", async () => {
    const semToken = await carga(CONTATO_A, CONVERSA_A);
    const antes = montar(semToken, CONTATO_A);
    expect(Object.keys(antes)).toEqual(["solicitar_acesso_casa"]);

    const resposta = (await antes.solicitar_acesso_casa!.execute({})) as { texto: string; dados: { link: string } };
    expect(resposta.dados.link).toMatch(/\/api\/v1\/mcp-oauth\/iniciar\/[A-Za-z0-9_-]{43}$/);
    // O pedido nasceu amarrado ao contato E à conversa do turno.
    expect(banco.tabelas.mcp_oauth_pedidos![0]).toMatchObject({ contact_id: CONTATO_A, conversation_id: CONVERSA_A, organization_id: ORG });

    expect(await contatoAutoriza(resposta.dados.link, "alice")).toBe("autorizado");

    const comToken = await carga(CONTATO_A, CONVERSA_A);
    const depois = montar(comToken, CONTATO_A);
    expect(Object.keys(depois).sort()).toEqual(["casa__casa_ler", "casa__casa_ligar", "solicitar_acesso_casa"]);
    const lido = (await depois.casa__casa_ler!.execute({})) as { texto: string };
    expect(lido.texto).toBe("casa de alice: casa_ler ok");
    expect(stub.chamadas.at(-1)).toMatchObject({ usuario: "alice", ferramenta: "casa_ler" });
  });

  it("B, logo depois, não herda o token de A: recebe o próprio link e, autorizando, usa o próprio [5.1]", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");

    const deB = await carga(CONTATO_B, CONVERSA_B);
    expect(deB[0]?.estado).toBe("sem_autorizacao");
    expect(Object.keys(montar(deB, CONTATO_B))).toEqual(["solicitar_acesso_casa"]);

    await contatoAutoriza(await pedirLink(CONTATO_B, CONVERSA_B), "bruno");
    const ferramentasB = montar(await carga(CONTATO_B, CONVERSA_B), CONTATO_B);
    expect(((await ferramentasB.casa__casa_ler!.execute({})) as { texto: string }).texto).toBe("casa de bruno: casa_ler ok");
    expect(stub.chamadas.map((c) => c.usuario)).toEqual(["bruno"]);
  });

  it("servidor montado para A nunca monta num turno de B (defesa no montador) [5.1]", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    const deA = await carga(CONTATO_A, CONVERSA_A);
    expect(Object.keys(montar(deA, CONTATO_B))).toEqual([]);
  });

  it("turno SEM contato (operador/automação) não monta servidor oauth_por_contato [§3]", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    expect(await carga(undefined)).toEqual([]);
  });

  it("organização Y não enxerga o servidor nem a credencial de X [§8.7, 5.2]", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    const deY = await carregarServidoresDoAgenteNoTurno(banco.cliente as never, ORG_Y, AGENTE, TOOL_IDS, { contatoDoTurno: CONTATO_A, fetch: saida });
    expect(deY).toEqual([]);
    expect(await credencialDoContato(banco.cliente as never, ORG_Y, SERVIDOR, CONTATO_A)).toBeNull();
  });
});

describe("cliente público do DCR com segredo espúrio gravado (regressão, VPS 2026-11-02)", () => {
  it("o navegador preencheu o client_secret: a troca ignora o segredo e manda o client_id no corpo", async () => {
    // Medido na VPS: o Chrome autopreencheu o campo de senha `client_secret` com a
    // senha do CRM; o segredo foi gravado num cliente público (DCR, auth `none`),
    // a troca foi por Basic sem `client_id` no corpo e o AS respondeu invalid_grant.
    Object.assign(banco.tabelas.ai_agent_mcp_servers![0]!, cifrar("oauth_client_secret", "senha-do-crm-autopreenchida"));
    expect(await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice")).toBe("autorizado");
  });
});

// ─── O state ────────────────────────────────────────────────────────────────

describe("o link é de uso único, expira e o state é amarrado [5.4]", () => {
  it("state reusado, expirado ou inexistente → pedido_invalido, sem gravar credencial", async () => {
    const link = await pedirLink(CONTATO_A, CONVERSA_A);
    const state = link.split("/").pop()!;
    expect(await contatoAutoriza(link, "alice")).toBe("autorizado");
    const credenciais = banco.tabelas.contato_mcp_credenciais!.length;

    // reuso
    expect(await processarRetorno(banco.cliente as never, { servidor: SERVIDOR, state, code: "qualquer", error: null }, rede)).toBe("pedido_invalido");
    expect((await iniciarAutorizacao(banco.cliente as never, state)).ok).toBe(false);
    // inexistente
    expect(await processarRetorno(banco.cliente as never, { servidor: SERVIDOR, state: "x".repeat(43), code: "c", error: null }, rede)).toBe("pedido_invalido");
    expect(await processarRetorno(banco.cliente as never, { servidor: SERVIDOR, state: null, code: "c", error: null }, rede)).toBe("pedido_invalido");
    // expirado
    const link2 = await pedirLink(CONTATO_B, CONVERSA_B);
    const state2 = link2.split("/").pop()!;
    banco.tabelas.mcp_oauth_pedidos!.find((p) => p.id === state2)!.expira_em = new Date(Date.now() - 1000).toISOString();
    expect((await iniciarAutorizacao(banco.cliente as never, state2)).ok).toBe(false);
    expect(await processarRetorno(banco.cliente as never, { servidor: SERVIDOR, state: state2, code: "c", error: null }, rede)).toBe("pedido_invalido");

    expect(banco.tabelas.contato_mcp_credenciais!.length).toBe(credenciais);
  });

  it("dois callbacks simultâneos com o mesmo state: só um consome", async () => {
    const state = (await pedirLink(CONTATO_A, CONVERSA_A)).split("/").pop()!;
    const [x, y] = await Promise.all([consumirPedido(banco.cliente as never, state), consumirPedido(banco.cliente as never, state)]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
  });

  it("o contato nega no AS (error=access_denied) → nada gravado e o state morre", async () => {
    const state = (await pedirLink(CONTATO_A, CONVERSA_A)).split("/").pop()!;
    expect(await processarRetorno(banco.cliente as never, { servidor: SERVIDOR, state, code: null, error: "access_denied" }, rede)).toBe("recusado_pelo_contato");
    expect(banco.tabelas.contato_mcp_credenciais ?? []).toHaveLength(0);
    expect(await processarRetorno(banco.cliente as never, { servidor: SERVIDOR, state, code: "c", error: null }, rede)).toBe("pedido_invalido");
  });
});

describe("o endereço de retorno é POR SERVIDOR e o callback confere servidor e iss", () => {
  it("o authorize leva a redirect_uri DESTE servidor", async () => {
    const state = (await pedirLink(CONTATO_A, CONVERSA_A)).split("/").pop()!;
    const inicio = await iniciarAutorizacao(banco.cliente as never, state);
    expect(inicio.ok && new URL(inicio.destino).searchParams.get("redirect_uri")).toMatch(
      new RegExp(`/api/v1/mcp-oauth/callback/${SERVIDOR}$`),
    );
  });

  it("o state de um servidor que volta pelo endereço de OUTRO é recusado, sem troca do code", async () => {
    stub.codigos.clear();
    const link = await pedirLink(CONTATO_A, CONVERSA_A);
    const codigosAntes = stub.codigos.size;
    expect(await contatoAutoriza(link, "alice", { servidor: OUTRO_SERVIDOR })).toBe("pedido_invalido");
    expect(banco.tabelas.contato_mcp_credenciais ?? []).toHaveLength(0);
    // O code não foi resgatado: continua no AS, e o state morreu.
    expect(stub.codigos.size).toBe(codigosAntes + 1);
    expect(await processarRetorno(banco.cliente as never, { servidor: SERVIDOR, state: link.split("/").pop()!, code: "c", error: null }, rede)).toBe("pedido_invalido");
  });

  it("iss (RFC 9207) de outro emissor é recusado; o do emissor do servidor passa", async () => {
    expect(await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice", { iss: "https://outro-as.example" })).toBe("pedido_invalido");
    expect(banco.tabelas.contato_mcp_credenciais ?? []).toHaveLength(0);
    // Controle: o `iss` do próprio emissor (com ou sem a barra final).
    expect(await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice", { iss: `${origem}/` })).toBe("autorizado");
  });
});

describe("autorização concluída com a conversa JÁ encerrada nasce com a revogação agendada", () => {
  it("retenção 0: nasce vencida, não serve ao turno, e o cron revoga no terceiro", async () => {
    banco.tabelas.conversations = [{ id: CONVERSA_A, organization_id: ORG, contact_id: CONTATO_A, status: "open" }];
    const link = await pedirLink(CONTATO_A, CONVERSA_A);
    banco.tabelas.conversations![0]!.status = "closed"; // encerrou com o link na mão do contato
    expect(await contatoAutoriza(link, "alice")).toBe("autorizado");
    const linha = banco.tabelas.contato_mcp_credenciais![0]!;
    expect(new Date(String(linha.revogar_apos)).getTime()).toBeLessThanOrEqual(Date.now());
    expect(await credencialDoContato(banco.cliente as never, ORG, SERVIDOR, CONTATO_A)).toBeNull();
    expect(await revogarVencidas(banco.cliente as never, rede)).toMatchObject({ revogadas: 1 });
    expect(stub.revogados.some((t) => t.startsWith("RT-MARCADOR-alice"))).toBe(true);
  });

  it("com retenção de 2 h, nasce com revogar_apos = agora + 2 h; conversa aberta não agenda", async () => {
    banco.tabelas.ai_agent_mcp_servers![0]!.retencao_apos_encerramento_horas = 2;
    banco.tabelas.conversations = [
      { id: CONVERSA_A, organization_id: ORG, contact_id: CONTATO_A, status: "resolved" },
      { id: CONVERSA_B, organization_id: ORG, contact_id: CONTATO_B, status: "open" },
    ];
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    await contatoAutoriza(await pedirLink(CONTATO_B, CONVERSA_B), "bruno");
    const deA = banco.tabelas.contato_mcp_credenciais!.find((c) => c.contact_id === CONTATO_A)!;
    const deB = banco.tabelas.contato_mcp_credenciais!.find((c) => c.contact_id === CONTATO_B)!;
    const horas = (new Date(String(deA.revogar_apos)).getTime() - Date.now()) / 3_600_000;
    expect(horas).toBeGreaterThan(1.9);
    expect(horas).toBeLessThanOrEqual(2);
    expect(deB.revogar_apos).toBeNull();
  });
});

describe("saídas OAuth: prazo até o fim do corpo e teto de bytes", () => {
  it("corpo JSON acima do teto é recusado (registro_falhou), mesmo válido", async () => {
    await expect(
      registrarCliente(`${origem}/register-gigante`, { redirectUri: "http://x/cb", nomeDoCliente: "n", escopos: [] }, rede),
    ).rejects.toMatchObject({ codigo: "registro_falhou" });
  });

  it("corpo a conta-gotas não prende além do prazo da chamada", async () => {
    const inicio = Date.now();
    await expect(
      registrarCliente(`${origem}/register-lento`, { redirectUri: "http://x/cb", nomeDoCliente: "n", escopos: [] }, { ...rede, timeoutMs: 300 }),
    ).rejects.toMatchObject({ codigo: "registro_falhou" });
    expect(Date.now() - inicio).toBeLessThan(2000);
  }, 10_000);
});

// ─── Renovação ──────────────────────────────────────────────────────────────

describe("token expirado renova sem o contato perceber; corrida não corrompe [§8.4, 5.8]", () => {
  it("expirado (ou a menos de 60 s) renova antes de chamar", async () => {
    stub.expiraEmSegundos = 30; // abaixo da margem de 60 s
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    stub.expiraEmSegundos = 3600;
    const [s] = await carga(CONTATO_A, CONVERSA_A);
    expect(s?.estado).toBe("pronto");
    expect(stub.refreshesFeitos).toBe(1);
    expect(((await montar([s!], CONTATO_A).casa__casa_ler!.execute({})) as { texto: string }).texto).toBe("casa de alice: casa_ler ok");
  });

  it("duas renovações concorrentes da MESMA credencial: um refresh no AS, as duas ficam com o token vencedor", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    const servidor = (await import("./registro")).lerLinhaDoServidor(banco.tabelas.ai_agent_mcp_servers![0]!)!;
    const lida = (await credencialDoContato(banco.cliente as never, ORG, SERVIDOR, CONTATO_A))!;
    const [x, y] = await Promise.all([
      renovarCredencial(banco.cliente as never, servidor, CONTATO_A, lida, rede),
      renovarCredencial(banco.cliente as never, servidor, CONTATO_A, lida, rede),
    ]);
    expect(stub.refreshesFeitos).toBe(1);
    expect(x?.accessToken).toBeDefined();
    expect(x?.accessToken).toBe(y?.accessToken);
    const final = await credencialDoContato(banco.cliente as never, ORG, SERVIDOR, CONTATO_A);
    expect(final?.accessToken).toBe(x?.accessToken);
  });

  it("refresh com invalid_grant apaga a credencial e volta a 'sem token'", async () => {
    stub.expiraEmSegundos = 1;
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    stub.refreshs.clear(); // o AS esqueceu todos os refresh tokens
    const [s] = await carga(CONTATO_A, CONVERSA_A);
    expect(s?.estado).toBe("sem_autorizacao");
    expect(banco.tabelas.contato_mcp_credenciais).toHaveLength(0);
  });

  it("401 numa chamada: renova uma vez e repete", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    const [s] = await carga(CONTATO_A, CONVERSA_A);
    const ferramentas = montar([s!], CONTATO_A);
    stub.acessos.clear(); // o AS invalidou o access token, o refresh segue bom
    expect(((await ferramentas.casa__casa_ler!.execute({})) as { texto: string }).texto).toBe("casa de alice: casa_ler ok");
    expect(stub.refreshesFeitos).toBe(1);
  });
});

// ─── Escrita ────────────────────────────────────────────────────────────────

describe("escrita em turno com contato [§4]", () => {
  it("escrita_delegada DESLIGADA: a escrita é recusada como antes — agora com o código nomeado (#4445)", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    const r = (await montar(await carga(CONTATO_A, CONVERSA_A), CONTATO_A).casa__casa_ligar!.execute({ aparelho: "luz" })) as { motivo?: string };
    expect(r.motivo).toBe("escrita_nao_liberada");
    expect(stub.chamadas).toHaveLength(0);
  });

  it("escrita_delegada LIGADA: roda com o token do contato; sem escopo, orienta o step-up (403 insufficient_scope)", async () => {
    banco.tabelas.ai_agent_mcp_servers![0]!.escrita_delegada = true;
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    const r = (await montar(await carga(CONTATO_A, CONVERSA_A), CONTATO_A).casa__casa_ligar!.execute({ aparelho: "luz" })) as { texto: string };
    expect(r.texto).toContain("solicitar_acesso_casa");
    expect(r.texto).toContain("casa:escrita");
    expect(stub.chamadas.at(-1)).toMatchObject({ usuario: "alice", ferramenta: "casa_ligar" });
    const auditoria = auditSpy.mock.calls.map((c) => c[0] as { action?: string; metadata?: { tool_name?: string } });
    expect(auditoria.some((a) => a.action === "mcp.tool_called" && a.metadata?.tool_name === "casa__casa_ligar")).toBe(true);
  });

  it("escrita_delegada LIGADA e escopo concedido: a ação acontece na conta do contato", async () => {
    banco.tabelas.ai_agent_mcp_servers![0]!.escrita_delegada = true;
    banco.tabelas.ai_agent_mcp_servers![0]!.escopos_pedidos = ["casa:leitura", "casa:escrita"];
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    const r = (await montar(await carga(CONTATO_A, CONVERSA_A), CONTATO_A).casa__casa_ligar!.execute({ aparelho: "luz" })) as { texto: string };
    expect(r.texto).toBe("casa de alice: casa_ligar ok");
  });
});

// ─── O token não vaza e argumento não manda ────────────────────────────────

describe("o token nunca sai do servidor e argumento não troca identidade [5.3, 5.7]", () => {
  it("nenhum token marcador aparece em log, auditoria, resposta de ferramenta, banco em claro ou pedido", async () => {
    banco.tabelas.ai_agent_mcp_servers![0]!.escrita_delegada = true;
    const link = await pedirLink(CONTATO_A, CONVERSA_A);
    await contatoAutoriza(link, "alice");
    const ferramentas = montar(await carga(CONTATO_A, CONVERSA_A), CONTATO_A);
    const saidas = [
      await ferramentas.casa__casa_ler!.execute({}),
      await ferramentas.casa__casa_ligar!.execute({ aparelho: "luz" }),
      await ferramentas.solicitar_acesso_casa!.execute({}),
    ];
    const tudo = JSON.stringify({
      saidas,
      logs: logSpy.mock.calls,
      auditoria: auditSpy.mock.calls,
      banco: banco.tabelas.contato_mcp_credenciais,
      pedidos: banco.tabelas.mcp_oauth_pedidos,
    });
    expect(tudo).not.toMatch(/AT-MARCADOR|RT-MARCADOR/);
    expect(stub.chamadas.every((c) => c.autorizacao?.startsWith("Bearer AT-MARCADOR-alice"))).toBe(true);
  });

  it("argumentos com Authorization/contato não alteram cabeçalho, endpoint nem contato", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    await contatoAutoriza(await pedirLink(CONTATO_B, CONVERSA_B), "bruno");
    const ferramentas = montar(await carga(CONTATO_A, CONVERSA_A), CONTATO_A);
    await ferramentas.casa__casa_ler!.execute({ Authorization: "Bearer AT-MARCADOR-bruno-2", contact_id: CONTATO_B, endpoint: "http://10.0.0.1/" });
    expect(stub.chamadas.at(-1)?.usuario).toBe("alice");
    // O pedido de acesso também ignora qualquer contato vindo de argumento.
    await ferramentas.solicitar_acesso_casa!.execute({ contact_id: CONTATO_B, escopos: ["casa:leitura"] });
    expect(banco.tabelas.mcp_oauth_pedidos!.at(-1)?.contact_id).toBe(CONTATO_A);
  });
});

// ─── Falha do terceiro e revogação ──────────────────────────────────────────

describe("terceiro fora do ar não derruba o turno [5.9]", () => {
  it("5xx do servidor na carga → servidor fica de fora, sem exceção", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    stub.fora = true;
    await expect(carga(CONTATO_A, CONVERSA_A)).resolves.toEqual([]);
  });

  // #3957: o mesmo teto do servidor da organização (`tempos-do-turno.ts`); sem
  // ele, o default do cliente MCP (15 s por operação) estoura a folga abaixo.
  it("servidor que não responde na carga: corta no teto do turno e o turno segue sem a ferramenta", { timeout: 30_000 }, async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    stub.trava = true;
    const comeco = Date.now();
    const servidores = await carga(CONTATO_A, CONVERSA_A);
    expect(Date.now() - comeco).toBeLessThan(TIMEOUT_DA_DESCOBERTA_NO_TURNO_MS + 4_000);
    expect(servidores).toEqual([]);
    expect(Object.keys(montar(servidores, CONTATO_A))).toEqual([]);
  });

  it("servidor que trava na chamada: a ferramenta corta no teto do turno", { timeout: 30_000 }, async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    const ferramentas = montar(await carga(CONTATO_A, CONVERSA_A), CONTATO_A);
    stub.trava = true;
    const comeco = Date.now();
    await ferramentas.casa__casa_ler!.execute({});
    expect(Date.now() - comeco).toBeLessThan(TIMEOUT_DA_CHAMADA_NO_TURNO_MS + 4_000);
    expect(stub.chamadas).toEqual([]);
  });
});

describe("revogação no encerramento e por LGPD [§8.5, §3]", () => {
  it("revogar_apos vencido: revoga no AS (RFC 7009), esvazia os tokens e marca revogado_em", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    const linha = banco.tabelas.contato_mcp_credenciais![0]!;
    linha.revogar_apos = new Date(Date.now() - 1000).toISOString(); // o gatilho da 9095 grava isto
    expect(await credencialDoContato(banco.cliente as never, ORG, SERVIDOR, CONTATO_A)).toBeNull();

    const r = await revogarVencidas(banco.cliente as never, rede);
    expect(r).toMatchObject({ revogadas: 1, apagadas: 0 });
    expect(stub.revogados.some((t) => t.startsWith("RT-MARCADOR-alice"))).toBe(true);
    expect(stub.revogados.some((t) => t.startsWith("AT-MARCADOR-alice"))).toBe(true);
    expect(linha.revogado_em).toEqual(expect.any(String));
    expect(linha.access_token_encrypted).toBeNull();
    expect(linha.refresh_token_encrypted).toBeNull();
    // e o próximo turno de A volta a pedir acesso
    expect((await carga(CONTATO_A, CONVERSA_A))[0]?.estado).toBe("sem_autorizacao");
  });

  it("contato anonimizado: revoga no terceiro e APAGA a linha", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    banco.tabelas.contacts!.find((c) => c.id === CONTATO_A)!.is_anonymized = true;
    banco.tabelas.contato_mcp_credenciais![0]!.revogar_apos = new Date(Date.now() - 1000).toISOString();
    expect(await revogarVencidas(banco.cliente as never, rede)).toMatchObject({ revogadas: 0, apagadas: 1 });
    expect(banco.tabelas.contato_mcp_credenciais).toHaveLength(0);
  });

  it("uma autorização nova substitui E revoga a anterior", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    // Com token, o pedido sai pelo step-up (servidor `pronto`).
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A, "pronto"), "alice");
    expect(banco.tabelas.contato_mcp_credenciais).toHaveLength(1);
    expect(stub.revogados.length).toBeGreaterThanOrEqual(1);
  });
});

describe("revogação: rodadas sobrepostas, orçamento, troca de origem e exclusão do contato", () => {
  it("duas rodadas do cron ao mesmo tempo: uma chamada ao terceiro por token e UMA auditoria", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    banco.tabelas.contato_mcp_credenciais![0]!.revogar_apos = new Date(Date.now() - 1000).toISOString();
    auditSpy.mockClear();
    const [x, y] = await Promise.all([revogarVencidas(banco.cliente as never, rede), revogarVencidas(banco.cliente as never, rede)]);
    expect(x.revogadas + y.revogadas).toBe(1);
    expect(stub.revogados).toHaveLength(2); // refresh + access, uma vez cada
    const revogacoes = auditSpy.mock.calls.filter((c) => (c[0] as { action?: string }).action === "contact.mcp_acesso_revogado");
    expect(revogacoes).toHaveLength(1);
  });

  it("orçamento esgotado: a rodada para e o que não coube fica para a próxima", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    banco.tabelas.contato_mcp_credenciais![0]!.revogar_apos = new Date(Date.now() - 1000).toISOString();
    expect(await revogarVencidas(banco.cliente as never, { ...rede, orcamentoMs: 0 })).toMatchObject({ revogadas: 0, apagadas: 0 });
    expect(stub.revogados).toHaveLength(0);
    expect(await revogarVencidas(banco.cliente as never, rede)).toMatchObject({ revogadas: 1 });
  });

  it("acessos de um servidor: revoga com a configuração que os emitiu, apaga as linhas e os pedidos pendentes", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    await pedirLink(CONTATO_B, CONVERSA_B); // pedido pendente de B
    const servidor = (await import("./registro")).lerLinhaDoServidor(banco.tabelas.ai_agent_mcp_servers![0]!)!;
    expect(await revogarAcessosDoServidor(banco.cliente as never, servidor, rede)).toBe(1);
    expect(stub.revogados.some((t) => t.startsWith("RT-MARCADOR-alice"))).toBe(true);
    expect(banco.tabelas.contato_mcp_credenciais).toHaveLength(0);
    expect(banco.tabelas.mcp_oauth_pedidos).toHaveLength(0);
  });

  it("antes de excluir o contato: revoga no terceiro e apaga; outra organização não alcança", async () => {
    await contatoAutoriza(await pedirLink(CONTATO_A, CONVERSA_A), "alice");
    expect(await revogarAcessosDoContato(banco.cliente as never, ORG_Y, CONTATO_A, rede)).toBe(0);
    expect(banco.tabelas.contato_mcp_credenciais).toHaveLength(1);
    expect(stub.revogados).toHaveLength(0);

    expect(await revogarAcessosDoContato(banco.cliente as never, ORG, CONTATO_A, rede)).toBe(1);
    expect(stub.revogados.some((t) => t.startsWith("RT-MARCADOR-alice"))).toBe(true);
    expect(banco.tabelas.contato_mcp_credenciais).toHaveLength(0);
    expect(auditSpy.mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({ action: "contact.mcp_acesso_revogado", metadata: expect.objectContaining({ motivo: "exclusao_do_contato" }) }),
    );
  });
});

// Garantia de que a fixture abre a cifra que o código grava.
it("a fixture usa a mesma cifra do produto", () => {
  expect(Object.keys(cifrar("x", "y"))).toEqual(["x_encrypted", "x_iv", "x_tag"]);
});
