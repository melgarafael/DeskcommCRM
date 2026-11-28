/**
 * OAuth da Microsoft (plataforma de identidade v2.0): consentimento, troca do
 * código e renovação.
 *
 * Só LEITURA da agenda (`Calendars.Read`): esta fatia não escreve no Outlook, e
 * pedir escrita sem usar seria pedir mais do que se precisa.
 *
 * Nada aqui lança: rede e recusa viram um desfecho nomeado.
 */
import type { AppDaMicrosoft } from "./config";

export const ESCOPOS_DA_MICROSOFT = [
  "openid",
  "profile",
  "offline_access",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Calendars.Read",
] as const;

const PRAZO_MS = 10_000;

const endereco = (app: AppDaMicrosoft, passo: "authorize" | "token") =>
  `https://login.microsoftonline.com/${encodeURIComponent(app.tenant)}/oauth2/v2.0/${passo}`;

export function urlDeConsentimento(
  app: AppDaMicrosoft,
  opcoes: { state: string; contaSugerida?: string | null },
): string {
  const url = new URL(endereco(app, "authorize"));
  url.search = new URLSearchParams({
    client_id: app.clientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: app.redirectUri,
    scope: ESCOPOS_DA_MICROSOFT.join(" "),
    state: opcoes.state,
    // A pessoa ESCOLHE a conta: a sessão aberta no navegador pode ser a pessoal.
    prompt: "select_account",
    ...(opcoes.contaSugerida ? { login_hint: opcoes.contaSugerida } : {}),
  }).toString();
  return url.toString();
}

/** A volta com `error=`: quem precisa agir — a pessoa, a TI dela, ou ninguém. */
export function desfechoDaRecusa(erro: string, descricao: string | null): string {
  // 90094 / 65001 / 900941: o diretório exige aprovação do administrador.
  if (/AADSTS(90094|900941|65001)|admin[_ ]consent|consent_required/i.test(`${erro} ${descricao ?? ""}`))
    return "precisa_do_administrador";
  if (erro === "access_denied") return "conexao_cancelada";
  return "recusada";
}

export interface TokenDaMicrosoft {
  accessToken: string;
  /** A Microsoft devolve um novo a cada renovação; ausente = manter o atual. */
  refreshToken: string | null;
  expiraEm: string;
  escopos: string[];
}

export type LeituraDoToken =
  | { ok: true; token: TokenDaMicrosoft }
  | { ok: false; motivo: "reautenticar" | "credencial" | "transitorio"; detalhe: string };

export function lerRespostaDoToken(bruto: unknown, status: number, agora: Date): LeituraDoToken {
  const r = (bruto ?? {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && typeof r.access_token === "string" && r.access_token) {
    const segundos = Number(r.expires_in);
    return {
      ok: true,
      token: {
        accessToken: r.access_token,
        refreshToken: typeof r.refresh_token === "string" && r.refresh_token ? r.refresh_token : null,
        expiraEm: new Date(
          agora.getTime() + (Number.isFinite(segundos) && segundos > 0 ? segundos : 3600) * 1000,
        ).toISOString(),
        escopos: typeof r.scope === "string" ? r.scope.split(/\s+/).filter(Boolean) : [],
      },
    };
  }
  const codigo = typeof r.error === "string" ? r.error : `http_${status}`;
  // Só o CÓDIGO: a descrição da Microsoft carrega e-mail e ids de rastreio.
  if (codigo === "invalid_grant" || codigo === "interaction_required")
    return { ok: false, motivo: "reautenticar", detalhe: codigo };
  if (codigo === "invalid_client" || codigo === "unauthorized_client")
    return { ok: false, motivo: "credencial", detalhe: codigo };
  return { ok: false, motivo: "transitorio", detalhe: codigo };
}

export function temPermissaoDeAgenda(escopos: readonly string[]): boolean {
  return escopos.some((e) => /(^|\/)Calendars\.Read(Write)?$/i.test(e));
}

async function pedirToken(
  app: AppDaMicrosoft,
  campos: Record<string, string>,
  agora: Date,
  buscar: typeof fetch,
): Promise<LeituraDoToken> {
  try {
    const resposta = await buscar(endereco(app, "token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        scope: ESCOPOS_DA_MICROSOFT.join(" "),
        ...campos,
      }).toString(),
      signal: AbortSignal.timeout(PRAZO_MS),
      cache: "no-store",
    });
    const corpo: unknown = await resposta.json().catch(() => null);
    return lerRespostaDoToken(corpo, resposta.status, agora);
  } catch {
    return { ok: false, motivo: "transitorio", detalhe: "sem_resposta" };
  }
}

export function trocarCodigo(
  app: AppDaMicrosoft,
  code: string,
  opcoes: { agora: Date; buscar?: typeof fetch },
): Promise<LeituraDoToken> {
  return pedirToken(
    app,
    { grant_type: "authorization_code", code, redirect_uri: app.redirectUri },
    opcoes.agora,
    opcoes.buscar ?? fetch,
  );
}

export function renovar(
  app: AppDaMicrosoft,
  refreshToken: string,
  opcoes: { agora: Date; buscar?: typeof fetch },
): Promise<LeituraDoToken> {
  return pedirToken(
    app,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    opcoes.agora,
    opcoes.buscar ?? fetch,
  );
}
