/**
 * OAuth 2.1 + PKCE de um servidor MCP externo, conforme a especificação de
 * autorização do MCP (2025-06-18): descoberta (RFC 9728 + RFC 8414, com o
 * fallback OIDC), registro dinâmico de cliente (RFC 7591), troca do `code`,
 * renovação e revogação (RFC 7009), sempre com `resource` (RFC 8707).
 *
 * ── Toda saída passa pelo MESMO guard anti-SSRF ──────────────────────────────
 *
 * `fetchDeSaida` (de `../chamada.ts`): prova textual da URL, resolução de DNS
 * sem faixa privada e `redirect: "manual"` dentro de uma allowlist que só tem
 * os hosts que a própria descoberta encontrou. Um 3xx para fora dela falha
 * fechado. `fetch` injetável é JUNTA DE TESTE (o stub mora em `127.0.0.1`,
 * que o guard recusa) — quem chama em produção não passa nada.
 *
 * ── O que nunca sai daqui ────────────────────────────────────────────────────
 *
 * Token, `code`, `code_verifier` e `client_secret` não vão para log, erro nem
 * retorno textual. `ErroDeOauth` carrega um CÓDIGO (vocabulário fechado), e o
 * texto de erro do authorization server é descartado — ele é de terceiro e
 * pode ecoar o que recebeu.
 */
import { randomBytes } from "node:crypto";

import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { codeChallengeS256, gerarCodeVerifier } from "@/lib/ai/pontos/pkce-da-assinatura";

import { NOME_DO_CLIENTE_MCP, fetchDeSaida } from "../chamada";
import type { MetadadosOauth } from "./registro";

export type CodigoDeErroOauth =
  | "descoberta_falhou"
  | "sem_s256"
  | "metadados_divergentes"
  | "sem_cliente"
  | "registro_falhou"
  | "invalid_grant"
  | "recusado"
  | "rede";

export class ErroDeOauth extends Error {
  override readonly name = "ErroDeOauth";
  constructor(readonly codigo: CodigoDeErroOauth) {
    super(`oauth:${codigo}`);
  }
}

export interface OpcoesDeRede {
  /** JUNTA DE TESTE — substitui o guard anti-SSRF. Produção nunca passa. */
  fetch?: FetchLike;
  timeoutMs?: number;
}

const TIMEOUT_PADRAO_MS = 10_000;
/** Teto do corpo JSON de qualquer resposta OAuth (metadados, registro, token). */
export const TETO_DO_CORPO_BYTES = 64 * 1024;

function saida(urls: readonly string[], opcoes?: OpcoesDeRede): FetchLike {
  return opcoes?.fetch ?? fetchDeSaida(urls);
}

/**
 * O prazo vale até o FIM da leitura do corpo: `AbortSignal.timeout` continua
 * armado depois que os cabeçalhos chegam, e o abort cancela o stream — um
 * corpo a conta-gotas não prende a requisição nem o turno.
 */
async function pedir(
  url: string,
  init: RequestInit,
  opcoes?: OpcoesDeRede,
): Promise<Response> {
  try {
    return await saida([url], opcoes)(url, {
      ...init,
      signal: AbortSignal.timeout(opcoes?.timeoutMs ?? TIMEOUT_PADRAO_MS),
    });
  } catch {
    throw new ErroDeOauth("rede");
  }
}

/** JSON com teto de bytes; corpo grande demais, cortado ou inválido = `null`. */
async function json(resposta: Response): Promise<unknown> {
  const declarado = Number(resposta.headers.get("content-length") ?? "0");
  const leitor = resposta.body?.getReader();
  if (!leitor) return null;
  if (declarado > TETO_DO_CORPO_BYTES) {
    await leitor.cancel().catch(() => undefined);
    return null;
  }
  const pedacos: Uint8Array[] = [];
  let recebido = 0;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      recebido += value.byteLength;
      if (recebido > TETO_DO_CORPO_BYTES) {
        await leitor.cancel().catch(() => undefined);
        return null;
      }
      pedacos.push(value);
    }
    return JSON.parse(Buffer.concat(pedacos).toString("utf8"));
  } catch {
    return null;
  }
}

// ─── Descoberta ──────────────────────────────────────────────────────────────

/** O valor de um parâmetro do `WWW-Authenticate` (`resource_metadata`, `scope`, `error`). */
export function parametroDoDesafio(desafio: string | null, nome: string): string | null {
  if (!desafio) return null;
  const re = new RegExp(`(?:^|[\\s,])${nome}\\s*=\\s*(?:"([^"]*)"|([^\\s,]+))`, "i");
  const m = desafio.match(re);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

const RecursoProtegidoSchema = z.object({
  resource: z.url().optional(),
  authorization_servers: z.array(z.url()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});

const ServidorDeAutorizacaoSchema = z.object({
  issuer: z.url().optional(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  registration_endpoint: z.url().optional(),
  revocation_endpoint: z.url().optional(),
  scopes_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

/** Os endereços `.well-known` de RFC 9728 §3.1 para um endpoint MCP. */
function candidatosDeRecursoProtegido(endpoint: string): string[] {
  const u = new URL(endpoint);
  const caminho = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  const lista = [`${u.origin}/.well-known/oauth-protected-resource${caminho}`];
  if (caminho !== "") lista.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return lista;
}

/** RFC 8414 §3.1 (inserção do path) e o fallback OIDC. */
function candidatosDeServidorDeAutorizacao(emissor: string): string[] {
  const u = new URL(emissor);
  const caminho = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return [
    `${u.origin}/.well-known/oauth-authorization-server${caminho}`,
    `${u.origin}/.well-known/openid-configuration${caminho}`,
    ...(caminho !== "" ? [`${u.origin}${caminho}/.well-known/openid-configuration`] : []),
  ];
}

/** Esquema e host em minúsculo (o `URL` já faz) e sem a barra final, como o `iss` em `retorno.ts`. */
function identificadorNormalizado(u: string): string {
  return new URL(u).href.replace(/\/+$/, "");
}

async function primeiroQueResponde<T>(
  urls: readonly string[],
  schema: z.ZodType<T>,
  opcoes?: OpcoesDeRede,
): Promise<T | null> {
  for (const url of urls) {
    let resposta: Response;
    try {
      resposta = await pedir(url, { method: "GET", headers: { Accept: "application/json" } }, opcoes);
    } catch {
      continue;
    }
    if (!resposta.ok) continue;
    const lido = schema.safeParse(await json(resposta));
    if (lido.success) return lido.data;
  }
  return null;
}

/**
 * Pergunta ao endpoint MCP, sem token, onde mora o authorization server.
 *
 * Um `initialize` JSON-RPC sem credencial: o servidor protegido responde 401
 * com `WWW-Authenticate: Bearer resource_metadata="..."`. Sem o cabeçalho, os
 * endereços `.well-known` do próprio host (RFC 9728 §3.1).
 */
async function urlsDoRecursoProtegido(endpoint: string, opcoes?: OpcoesDeRede): Promise<string[]> {
  const candidatos = candidatosDeRecursoProtegido(endpoint);
  try {
    const resposta = await pedir(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: NOME_DO_CLIENTE_MCP, version: "0.1.0" },
          },
        }),
      },
      opcoes,
    );
    const indicado = parametroDoDesafio(resposta.headers.get("www-authenticate"), "resource_metadata");
    if (indicado) return [indicado, ...candidatos];
  } catch {
    // Endpoint mudo: os `.well-known` ainda podem responder.
  }
  return candidatos;
}

/**
 * A descoberta inteira, para o cadastro e para o "Testar conexão".
 *
 * Recusa (com código) o authorization server que não anuncia `S256` em
 * `code_challenge_methods_supported`: sem ele não há PKCE que o cliente público
 * possa provar, e o cadastro não acontece.
 */
export async function descobrir(
  endpoint: string,
  opcoes?: OpcoesDeRede,
): Promise<Omit<MetadadosOauth, "cliente_dinamico" | "descoberto_em" | "ferramentas_vistas"> & {
  metodosDeAutenticacaoNoToken: string[];
}> {
  const recurso = await primeiroQueResponde(
    await urlsDoRecursoProtegido(endpoint, opcoes),
    RecursoProtegidoSchema,
    opcoes,
  );
  if (!recurso) throw new ErroDeOauth("descoberta_falhou");
  // RFC 9728 §3.3: a metadata tem de ser DESTE recurso. A régua é a do SDK do
  // MCP (mesma origem, endpoint dentro do caminho do `resource`), e não a
  // igualdade: o `.well-known` da raiz, que `candidatosDeRecursoProtegido`
  // também consulta, descreve legitimamente a ORIGEM.
  if (
    recurso.resource &&
    !checkResourceAllowed({
      requestedResource: identificadorNormalizado(endpoint),
      configuredResource: identificadorNormalizado(recurso.resource),
    })
  ) {
    throw new ErroDeOauth("metadados_divergentes");
  }
  const emissor = recurso.authorization_servers[0]!;
  const as = await primeiroQueResponde(candidatosDeServidorDeAutorizacao(emissor), ServidorDeAutorizacaoSchema, opcoes);
  if (!as) throw new ErroDeOauth("descoberta_falhou");
  // RFC 8414 §3.3: `issuer` idêntico ao identificador em que o `.well-known` foi inserido.
  if (as.issuer && identificadorNormalizado(as.issuer) !== identificadorNormalizado(emissor)) {
    throw new ErroDeOauth("metadados_divergentes");
  }
  if (!(as.code_challenge_methods_supported ?? []).includes("S256")) throw new ErroDeOauth("sem_s256");

  return {
    recurso: recurso.resource ?? endpoint,
    emissor,
    authorization_endpoint: as.authorization_endpoint,
    token_endpoint: as.token_endpoint,
    ...(as.registration_endpoint ? { registration_endpoint: as.registration_endpoint } : {}),
    ...(as.revocation_endpoint ? { revocation_endpoint: as.revocation_endpoint } : {}),
    escopos_suportados: recurso.scopes_supported ?? as.scopes_supported ?? [],
    metodosDeAutenticacaoNoToken: as.token_endpoint_auth_methods_supported ?? [],
  };
}

/**
 * Os hosts com que este servidor pode falar: o MCP e os do authorization server
 * descobertos. É a allowlist das saídas de token e revogação, e o que a tela
 * mostra ao admin.
 */
export function hostsDoServidor(endpoint: string, m: MetadadosOauth | null): string[] {
  const urls = [endpoint];
  if (m) urls.push(m.authorization_endpoint, m.token_endpoint, m.registration_endpoint ?? "", m.revocation_endpoint ?? "");
  return [...new Set(urls.filter(Boolean).map((u) => new URL(u).host))];
}

// ─── Registro dinâmico (RFC 7591) ────────────────────────────────────────────

const RespostaDeRegistroSchema = z.object({ client_id: z.string().min(1) });

/** Cliente PÚBLICO (`token_endpoint_auth_method: none`) — o PKCE é a prova. */
export async function registrarCliente(
  registrationEndpoint: string,
  entrada: { redirectUri: string; nomeDoCliente: string; escopos: readonly string[] },
  opcoes?: OpcoesDeRede,
): Promise<string> {
  const resposta = await pedir(
    registrationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        redirect_uris: [entrada.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_name: entrada.nomeDoCliente.slice(0, 120),
        ...(entrada.escopos.length > 0 ? { scope: entrada.escopos.join(" ") } : {}),
      }),
    },
    opcoes,
  );
  if (!resposta.ok) throw new ErroDeOauth("registro_falhou");
  const lido = RespostaDeRegistroSchema.safeParse(await json(resposta));
  if (!lido.success) throw new ErroDeOauth("registro_falhou");
  return lido.data.client_id;
}

// ─── PKCE e URL de autorização ───────────────────────────────────────────────

/** O `state` de um pedido: 256 bits, base64url (43 caracteres). */
export function novoState(): string {
  return randomBytes(32).toString("base64url");
}

export { gerarCodeVerifier, codeChallengeS256 };

export function montarUrlDeAutorizacao(entrada: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  escopos: readonly string[];
  recurso: string;
}): string {
  const url = new URL(entrada.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", entrada.clientId);
  url.searchParams.set("redirect_uri", entrada.redirectUri);
  url.searchParams.set("state", entrada.state);
  url.searchParams.set("code_challenge", codeChallengeS256(entrada.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (entrada.escopos.length > 0) url.searchParams.set("scope", entrada.escopos.join(" "));
  url.searchParams.set("resource", entrada.recurso);
  return url.toString();
}

// ─── Token ───────────────────────────────────────────────────────────────────

const RespostaDeTokenSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer"),
  expires_in: z.coerce.number().int().positive().optional(),
  refresh_token: z.string().min(1).max(16_384).optional(),
  scope: z.string().optional(),
});

export interface TokensDoContato {
  accessToken: string;
  refreshToken: string | null;
  expiraEm: Date | null;
  escopos: string[];
}

export interface ClienteOauth {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | null;
  /** `token_endpoint_auth_methods_supported` do AS — decide basic × post. */
  metodos?: readonly string[];
  recurso: string;
}

function corpoECabecalhos(
  cliente: ClienteOauth,
  campos: Record<string, string>,
): { body: string; headers: Record<string, string> } {
  const params = new URLSearchParams({ ...campos, resource: cliente.recurso });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  // O AS diz que só aceita cliente público (`none`)? Então segredo não sai, nem
  // que exista: Basic sem `client_id` no corpo vira invalid_grant num AS público.
  const metodos = cliente.metodos ?? [];
  const aceitaSegredo =
    metodos.length === 0 || metodos.includes("client_secret_basic") || metodos.includes("client_secret_post");
  if (cliente.clientSecret && aceitaSegredo) {
    const soPost = (cliente.metodos ?? []).includes("client_secret_post") &&
      !(cliente.metodos ?? []).includes("client_secret_basic");
    if (soPost) {
      params.set("client_id", cliente.clientId);
      params.set("client_secret", cliente.clientSecret);
    } else {
      const par = `${encodeURIComponent(cliente.clientId)}:${encodeURIComponent(cliente.clientSecret)}`;
      headers.Authorization = "Basic" + " " + Buffer.from(par).toString("base64");
    }
  } else {
    params.set("client_id", cliente.clientId);
  }
  return { body: params.toString(), headers };
}

async function pedirToken(
  cliente: ClienteOauth,
  campos: Record<string, string>,
  escoposAnteriores: readonly string[],
  opcoes?: OpcoesDeRede,
): Promise<TokensDoContato> {
  const { body, headers } = corpoECabecalhos(cliente, campos);
  const resposta = await pedir(cliente.tokenEndpoint, { method: "POST", headers, body }, opcoes);
  const corpo = await json(resposta);
  if (!resposta.ok) {
    const erro = (corpo as { error?: unknown } | null)?.error;
    throw new ErroDeOauth(erro === "invalid_grant" ? "invalid_grant" : "recusado");
  }
  const lido = RespostaDeTokenSchema.safeParse(corpo);
  if (!lido.success) throw new ErroDeOauth("recusado");
  return {
    accessToken: lido.data.access_token,
    refreshToken: lido.data.refresh_token ?? null,
    expiraEm: lido.data.expires_in ? new Date(Date.now() + lido.data.expires_in * 1000) : null,
    escopos: lido.data.scope ? lido.data.scope.split(/\s+/).filter(Boolean) : [...escoposAnteriores],
  };
}

export function trocarCodigo(
  cliente: ClienteOauth,
  entrada: { code: string; codeVerifier: string; redirectUri: string; escopos: readonly string[] },
  opcoes?: OpcoesDeRede,
): Promise<TokensDoContato> {
  return pedirToken(
    cliente,
    {
      grant_type: "authorization_code",
      code: entrada.code,
      code_verifier: entrada.codeVerifier,
      redirect_uri: entrada.redirectUri,
    },
    entrada.escopos,
    opcoes,
  );
}

/** Renova. Sem `refresh_token` novo na resposta, o antigo continua valendo (RFC 6749 §6). */
export async function renovar(
  cliente: ClienteOauth,
  refreshToken: string,
  escopos: readonly string[],
  opcoes?: OpcoesDeRede,
): Promise<TokensDoContato> {
  const novos = await pedirToken(cliente, { grant_type: "refresh_token", refresh_token: refreshToken }, escopos, opcoes);
  return novos.refreshToken ? novos : { ...novos, refreshToken };
}

/**
 * RFC 7009 — melhor esforço. `true` quando o AS confirmou (200), `false` em
 * qualquer outro desfecho; quem chama apaga o token local de qualquer jeito.
 */
export async function revogar(
  cliente: Omit<ClienteOauth, "tokenEndpoint"> & { revocationEndpoint: string },
  token: string,
  dica: "refresh_token" | "access_token",
  opcoes?: OpcoesDeRede,
): Promise<boolean> {
  const { body, headers } = corpoECabecalhos(
    { ...cliente, tokenEndpoint: cliente.revocationEndpoint },
    { token, token_type_hint: dica },
  );
  try {
    const resposta = await pedir(cliente.revocationEndpoint, { method: "POST", headers, body }, opcoes);
    return resposta.ok;
  } catch {
    return false;
  }
}
