/**
 * O LOGIN DO CODEX POR PKCE — a metade do fluxo que este repositório decide.
 *
 * A issue #1639 quer um segundo caminho até a OpenAI: a ASSINATURA do ChatGPT
 * (o mesmo login do Codex), com a chave de API da organização como RESERVA
 * (`./reserva-da-assinatura.ts`). Este arquivo é o login — PKCE, com o código
 * colado em `/admin/sistema` — e nada mais: não guarda token, não escolhe
 * provedor e não chama a rede sozinho (o `fetch` é injetável, e nos testes é
 * falso).
 *
 * ─── O que é Codex aqui, e o que é contrato ────────────────────────────────
 *
 * `CLIENT_ID_DO_CODEX`, `REDIRECT_URI_DO_CODEX` e os endpoints são os do
 * CLIENTE PÚBLICO do Codex CLI, apontados por quem opera o Codex — não uma
 * integração registrada por nós, e não um contrato público da OpenAI. Os três
 * podem mudar sem aviso nosso; por isso a tela que usa isto avisa com todas as
 * letras (`app/admin/(protected)/sistema/_login-codex.tsx`).
 *
 * `REDIRECT_URI_DO_CODEX` é `http://localhost:1455/auth/callback` porque é
 * EXATAMENTE o que está na lista branca do Codex: um redirect_uri fora da lista
 * faz o authorize recusar. O navegador do administrador fica esperando nesse
 * endereço, mostra o código, e alguém cola aqui — sem servidor nosso ouvindo
 * porta nenhuma.
 *
 * ─── Por que `fetch` é parâmetro ───────────────────────────────────────────
 *
 * Nesta VPS não há credencial nenhuma, e nenhum teste pode depender de rede.
 * Injetar o `fetch` deixa a troca do `code` provável sem nunca ter sido
 * chamada de verdade: o teste devolve os dois tokens de um `Response` falso e
 * confere o corpo do POST.
 */
import { createHash, randomBytes } from "node:crypto";

/** O client_id PÚBLICO do Codex CLI — não é segredo, e é dele (não nosso). */
export const CLIENT_ID_DO_CODEX = "app_EMoamEEZ73f0CkXaXp7hrann";

export const ENDPOINT_DE_AUTORIZACAO = "https://auth.openai.com/oauth/authorize";
export const ENDPOINT_DE_TOKEN = "https://auth.openai.com/oauth/token";

/** O redirect da lista branca do Codex — porta 1455, caminho fixo. */
export const REDIRECT_URI_DO_CODEX = "http://localhost:1455/auth/callback";

/**
 * `offline_access` é o que faz o provedor devolver `refresh_token`: sem ele não
 * há renovação nenhuma, e o login venceria em horas.
 */
export const ESCOPO_DO_CODEX = "openid profile email offline_access";

/** O que a troca devolve, no formato em que é persistido (JSON). */
export interface TokensDoCodex {
  access_token: string;
  refresh_token: string;
  /** Epoch ms em que o `access_token` vence; `null` quando o provedor não disse. */
  expires_at: number | null;
}

/**
 * `fetch` no formato em que este módulo usa: URL, init, `Response`. O padrão é
 * o da plataforma, e só a ação de `/admin/sistema` o usa — teste nenhum.
 */
export type FetchDeToken = (url: string, init?: RequestInit) => Promise<Response>;

const fetchDaPlataforma: FetchDeToken = (url, init) => fetch(url, init);

/** RFC 7636 §4.1 — 43 a 128 caracteres, sem `=` nem `+`/`/`. */
export function gerarCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

/**
 * O `state` aleatório que amarra a autorização a esta tela. Não é segredo — é
 * a prova de que quem cola o código veio do link que esta instalação mostrou.
 */
export function gerarEstado(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * RFC 7636 §4.2 — `BASE64URL(SHA256(ASCII(code_verifier)))`.
 *
 * Vetor do próprio RFC (Apêndice B): `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`
 * dá `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-xM`.
 */
export function codeChallengeS256(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/** O par que o fluxo carrega da primeira tela até o campo de colagem. */
export interface SessaoPkce {
  codeVerifier: string;
  estado: string;
  url: string;
}

/**
 * `estado` vem de fora quando precisa ser CONFERIDO na volta: a tela de
 * Credenciais passa um `state` assinado com a empresa e a pessoa
 * (`emitirEstado`), e a action recusa o retorno cujo `state` não é esse.
 */
export function criarSessaoPkce(estado: string = gerarEstado()): SessaoPkce {
  const codeVerifier = gerarCodeVerifier();
  return {
    codeVerifier,
    estado,
    url: montarUrlDeAutorizacao({ codeChallenge: codeChallengeS256(codeVerifier), estado }),
  };
}

/**
 * A URL de authorize, com todos os parâmetros do PKCE. Montada como string
 * codificada, nunca por concatenação de trechos prontos: `state` e `challenge`
 * vêm de `randomBytes` e podem carregar caracteres que mudariam a leitura do
 * query.
 */
export function montarUrlDeAutorizacao(entrada: {
  codeChallenge: string;
  estado: string;
  redirectUri?: string;
}): string {
  const parametros = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID_DO_CODEX,
    redirect_uri: entrada.redirectUri ?? REDIRECT_URI_DO_CODEX,
    scope: ESCOPO_DO_CODEX,
    code_challenge: entrada.codeChallenge,
    code_challenge_method: "S256",
    state: entrada.estado,
  });
  return `${ENDPOINT_DE_AUTORIZACAO}?${parametros.toString()}`;
}

/**
 * O QUE A PESSOA COLOU — o endereço em que o navegador parou
 * (`http://localhost:1455/auth/callback?code=…&state=…`). Ninguém escuta essa
 * porta, então a página não abre; o que serve é o endereço da barra.
 *
 * Devolve `code` e `state` só quando os DOIS vieram: sem o `state` não há como
 * provar que o retorno nasceu do link desta tela, para esta pessoa — e um
 * retorno de login de OUTRA conta, colado por engano ou por indução, ligaria à
 * empresa uma conta ChatGPT alheia (login CSRF). Código solto é recusado.
 * Aceita também só a parte depois do `?`.
 */
export function lerRetornoColado(texto: string): { code: string; state: string } | null {
  const limpo = texto.trim();
  const inicio = limpo.indexOf("?");
  const consulta = inicio >= 0 ? limpo.slice(inicio + 1) : limpo.includes("=") ? limpo : "";
  if (consulta === "") return null;
  const parametros = new URLSearchParams(consulta.split("#")[0]);
  const code = parametros.get("code")?.trim() ?? "";
  const state = parametros.get("state")?.trim() ?? "";
  if (code === "" || state === "") return null;
  return { code, state };
}

/** Por que a troca falhou — na linguagem que a renovação usa. */
export type MotivoDeFalhaDeToken =
  /** O refresh_token foi revogado: não adianta tentar de novo. */
  | "refresh_token_revoked"
  /** O provedor recusou (código usado, verifier errado, grant inválido). */
  | "recusado"
  /** Sem resposta: rede, DNS, timeout. */
  | "rede";

export class ErroDeToken extends Error {
  constructor(
    readonly motivo: MotivoDeFalhaDeToken,
    readonly status: number | null,
    detalhe?: string,
  ) {
    super(detalhe ?? `falha na troca de token (${status ?? "sem resposta"})`);
    this.name = "ErroDeToken";
  }
}

/**
 * O corpo de erro do provedor, traduzido. `refresh_token_revoked` é o único
 * que muda o DESTINO: ele vira `MotivoDeQueda` e a chamada cai na reserva
 * (`./reserva-da-assinatura.ts`), sem nova tentativa.
 */
export function classificarFalhaDeToken(
  status: number | null,
  corpo: unknown,
): MotivoDeFalhaDeToken {
  if (status === null) return "rede";
  const erro = (corpo as { error?: unknown; error_description?: unknown } | null) ?? {};
  const texto = `${String(erro.error ?? "")} ${String(erro.error_description ?? "")}`.toLowerCase();
  if (texto.includes("revoked") || texto.includes("revog")) return "refresh_token_revoked";
  return "recusado";
}

async function trocar(entrada: {
  corpo: Record<string, string>;
  fetchImpl: FetchDeToken;
}): Promise<TokensDoCodex> {
  let resposta: Response;
  try {
    resposta = await entrada.fetchImpl(ENDPOINT_DE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(entrada.corpo).toString(),
    });
  } catch (erro) {
    throw new ErroDeToken("rede", null, erro instanceof Error ? erro.message : String(erro));
  }

  let corpo: unknown = null;
  try {
    corpo = await resposta.json();
  } catch {
    corpo = null;
  }
  const dados = corpo as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  } | null;
  if (
    !resposta.ok ||
    typeof dados?.access_token !== "string" ||
    typeof dados.refresh_token !== "string"
  ) {
    throw new ErroDeToken(
      classificarFalhaDeToken(resposta.ok ? 400 : resposta.status, corpo),
      resposta.status,
    );
  }
  const segundos = typeof dados.expires_in === "number" ? dados.expires_in : null;
  return {
    access_token: dados.access_token,
    refresh_token: dados.refresh_token,
    expires_at: segundos === null ? null : Date.now() + segundos * 1000,
  };
}

/**
 * O `code` que o navegador deixou em `localhost:1455` por access_token e
 * refresh_token. `fetchImpl` é injetável: nos testes é falso, e nesta instalação
 * ninguém chamou este caminho ainda.
 */
export function trocarCodigoPorTokens(entrada: {
  code: string;
  codeVerifier: string;
  redirectUri?: string;
  fetchImpl?: FetchDeToken;
}): Promise<TokensDoCodex> {
  return trocar({
    fetchImpl: entrada.fetchImpl ?? fetchDaPlataforma,
    corpo: {
      grant_type: "authorization_code",
      code: entrada.code,
      redirect_uri: entrada.redirectUri ?? REDIRECT_URI_DO_CODEX,
      client_id: CLIENT_ID_DO_CODEX,
      code_verifier: entrada.codeVerifier,
    },
  });
}

/** A renovação propriamente dita: um POST novo, com o refresh_token atual. */
export function renovarPorRefreshToken(entrada: {
  refreshToken: string;
  fetchImpl?: FetchDeToken;
}): Promise<TokensDoCodex> {
  return trocar({
    fetchImpl: entrada.fetchImpl ?? fetchDaPlataforma,
    corpo: {
      grant_type: "refresh_token",
      refresh_token: entrada.refreshToken,
      client_id: CLIENT_ID_DO_CODEX,
    },
  });
}
