/**
 * O Google Drive da agência (docs/agencia/SPEC-acervo.md).
 *
 * Reaproveita o app OAuth da Agenda (`configuracaoDoGoogle`, `renovarToken`) com
 * endereço de retorno próprio e o escopo `drive.file` — a central só enxerga o
 * que ela mesma criou no Drive. O refresh token fica cifrado em `agencia_drive`.
 *
 * Nada aqui lança para quem chama a partir de tela ou de cadastro: falha do
 * Google vira `{ ok: false, erro }` e o motivo fica em `agencia_drive.ultimo_erro`
 * (A6 — sem Drive, as telas seguem funcionando).
 */
import { configuracaoDoGoogle, type AppDoGoogleConfigurado } from "@/lib/agenda/google/config";
import { ENDERECO_DE_CONSENTIMENTO } from "@/lib/agenda/google/oauth";
import { renovarToken, trocarCodigoPorToken } from "@/lib/agenda/google/token";
import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const ESCOPOS_DO_DRIVE = ["openid", "email", "https://www.googleapis.com/auth/drive.file"] as const;
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const PASTA = "application/vnd.google-apps.folder";

export type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: string };

/** O endereço de retorno do Drive — tem de estar registrado no Google Cloud. */
export function retornoDoDrive(base: string = env.NEXT_PUBLIC_APP_URL): string {
  return `${base.replace(/\/+$/, "")}/api/v1/agencia/drive/callback`;
}

async function appDoDrive(): Promise<AppDoGoogleConfigurado | null> {
  const app = await configuracaoDoGoogle();
  return app ? { ...app, redirectUri: retornoDoDrive() } : null;
}

export async function urlDeConsentimentoDoDrive(state: string): Promise<string | null> {
  const app = await appDoDrive();
  if (!app) return null;
  const p = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    response_type: "code",
    scope: ESCOPOS_DO_DRIVE.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false",
    state,
  });
  return `${ENDERECO_DE_CONSENTIMENTO}?${p.toString()}`;
}

/** Guarda o erro legível para a tela de Configurações. */
async function anotarErro(erro: string | null): Promise<void> {
  await createAdminClient()
    .from("agencia_drive")
    .update({ ultimo_erro: erro, atualizado_em: new Date().toISOString() })
    .eq("id", true);
}

/** Troca o `code` da volta do Google e grava a conexão. */
export async function conectarComCodigo(code: string, userId: string): Promise<Resultado<{ email: string | null }>> {
  const app = await appDoDrive();
  if (!app) return { ok: false, erro: "O app do Google não está configurado em Admin › Google Agenda." };
  const t = await trocarCodigoPorToken(app, code, { agora: new Date() });
  if (!t.ok) return { ok: false, erro: `O Google recusou a conexão (${t.detalhe}).` };
  if (!t.token.scope.includes("https://www.googleapis.com/auth/drive.file")) {
    return { ok: false, erro: "A permissão do Drive não foi concedida. Marque a caixa do Google Drive na tela do Google." };
  }
  if (!t.token.refresh_token) return { ok: false, erro: "O Google não devolveu o acesso permanente. Tente conectar de novo." };

  let email: string | null = null;
  try {
    const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${t.token.access_token}` },
    });
    if (r.ok) email = ((await r.json()) as { email?: string }).email ?? null;
  } catch {
    // o e-mail é só para mostrar na tela
  }

  const cifrado = encryptKey(t.token.refresh_token);
  const { error } = await createAdminClient()
    .from("agencia_drive")
    .update({
      conta_email: email,
      refresh_token_ct: bufToBytea(cifrado.ciphertext),
      refresh_token_iv: bufToBytea(cifrado.iv),
      refresh_token_tag: bufToBytea(cifrado.tag),
      conectado_em: new Date().toISOString(),
      conectado_por: userId,
      ultimo_erro: null,
      atualizado_em: new Date().toISOString(),
    })
    .eq("id", true);
  if (error) return { ok: false, erro: "Não deu para guardar a conexão." };
  tokenEmMemoria = null;
  return { ok: true, valor: { email } };
}

export async function desconectarDrive(): Promise<void> {
  await createAdminClient()
    .from("agencia_drive")
    .update({
      conta_email: null,
      refresh_token_ct: null,
      refresh_token_iv: null,
      refresh_token_tag: null,
      conectado_em: null,
      ultimo_erro: null,
      atualizado_em: new Date().toISOString(),
    })
    .eq("id", true);
  tokenEmMemoria = null;
}

export interface EstadoDoDrive {
  conectado: boolean;
  contaEmail: string | null;
  pastaRaizId: string | null;
  ultimoErro: string | null;
}

export async function estadoDoDrive(): Promise<EstadoDoDrive> {
  const { data } = await createAdminClient()
    .from("agencia_drive")
    .select("conta_email, refresh_token_ct, pasta_raiz_id, ultimo_erro")
    .eq("id", true)
    .maybeSingle();
  const d = data as { conta_email: string | null; refresh_token_ct: unknown; pasta_raiz_id: string | null; ultimo_erro: string | null } | null;
  return {
    conectado: !!d?.refresh_token_ct,
    contaEmail: d?.conta_email ?? null,
    pastaRaizId: d?.pasta_raiz_id ?? null,
    ultimoErro: d?.ultimo_erro ?? null,
  };
}

/** Access token de curta duração, renovado quando falta 1 min para vencer. */
let tokenEmMemoria: { valor: string; expiraEm: number } | null = null;

export async function accessToken(): Promise<Resultado<string>> {
  if (tokenEmMemoria && tokenEmMemoria.expiraEm - 60_000 > Date.now()) return { ok: true, valor: tokenEmMemoria.valor };
  const { data } = await createAdminClient()
    .from("agencia_drive")
    .select("refresh_token_ct, refresh_token_iv, refresh_token_tag")
    .eq("id", true)
    .maybeSingle();
  const d = data as { refresh_token_ct: unknown; refresh_token_iv: unknown; refresh_token_tag: unknown } | null;
  if (!d?.refresh_token_ct) return { ok: false, erro: "O Google Drive não está conectado." };
  const app = await appDoDrive();
  if (!app) return { ok: false, erro: "O app do Google não está configurado em Admin › Google Agenda." };

  let refresh: string;
  try {
    refresh = decryptKey({
      ciphertext: byteaToBuffer(d.refresh_token_ct),
      iv: byteaToBuffer(d.refresh_token_iv),
      tag: byteaToBuffer(d.refresh_token_tag),
    });
  } catch {
    await anotarErro("Não deu para ler a conexão guardada. Reconecte o Google Drive.");
    return { ok: false, erro: "Reconecte o Google Drive." };
  }
  const t = await renovarToken(app, refresh, { agora: new Date() });
  if (!t.ok) {
    const erro =
      t.status === 400 || t.status === 401
        ? "O acesso ao Google Drive foi revogado ou expirou. Reconecte o Google Drive."
        : "O Google não respondeu agora. Tente de novo em alguns minutos.";
    await anotarErro(erro);
    return { ok: false, erro };
  }
  tokenEmMemoria = { valor: t.token.access_token, expiraEm: new Date(t.token.expira_em).getTime() };
  return { ok: true, valor: t.token.access_token };
}

async function chamar<T>(caminho: string, init: RequestInit & { base?: string } = {}): Promise<Resultado<T>> {
  const token = await accessToken();
  if (!token.ok) return token;
  try {
    const r = await fetch(`${init.base ?? API}${caminho}`, {
      ...init,
      headers: { Authorization: `Bearer ${token.valor}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!r.ok) {
      const corpo = await r.text().catch(() => "");
      logger.warn("agência: Drive recusou", { caminho: caminho.split("?")[0], status: r.status, corpo: corpo.slice(0, 200) });
      const erro =
        r.status === 403 && /quota|storage/i.test(corpo)
          ? "O Google Drive da agência está sem espaço."
          : r.status === 403 && /accessNotConfigured|has not been used|disabled/i.test(corpo)
            ? "A Google Drive API não está ativada no Google Cloud do app. Ative e tente de novo."
            : `O Google Drive recusou (${r.status}).`;
      await anotarErro(erro);
      return { ok: false, erro };
    }
    if (r.status === 204) return { ok: true, valor: undefined as T };
    return { ok: true, valor: (await r.json()) as T };
  } catch {
    return { ok: false, erro: "O Google Drive não respondeu agora." };
  }
}

export async function criarPasta(nome: string, paiId: string | null): Promise<Resultado<{ id: string }>> {
  return chamar<{ id: string }>("/files?fields=id", {
    method: "POST",
    body: JSON.stringify({ name: nome, mimeType: PASTA, ...(paiId ? { parents: [paiId] } : {}) }),
  });
}

export async function renomear(id: string, nome: string): Promise<Resultado<{ id: string }>> {
  return chamar<{ id: string }>(`/files/${encodeURIComponent(id)}?fields=id`, { method: "PATCH", body: JSON.stringify({ name: nome }) });
}

export async function compartilhar(id: string, email: string, papel: "reader" | "writer"): Promise<Resultado<unknown>> {
  return chamar(`/files/${encodeURIComponent(id)}/permissions?sendNotificationEmail=false`, {
    method: "POST",
    body: JSON.stringify({ type: "user", role: papel, emailAddress: email }),
  });
}

export async function retirarCompartilhamento(id: string, email: string): Promise<Resultado<unknown>> {
  const lista = await chamar<{ permissions?: Array<{ id: string; emailAddress?: string }> }>(
    `/files/${encodeURIComponent(id)}/permissions?fields=permissions(id,emailAddress)`,
  );
  if (!lista.ok) return lista;
  const alvo = (lista.valor.permissions ?? []).find((p) => p.emailAddress?.toLowerCase() === email.toLowerCase());
  if (!alvo) return { ok: true, valor: null };
  return chamar(`/files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(alvo.id)}`, { method: "DELETE" });
}

export interface ArquivoDoDrive {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  webViewLink: string;
  parents?: string[];
}

export async function buscarArquivo(id: string): Promise<Resultado<ArquivoDoDrive>> {
  return chamar<ArquivoDoDrive>(`/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,webViewLink,parents`);
}

/**
 * Sessão de envio resumível (A5): o navegador manda o arquivo direto ao Google.
 * O `Origin` da central é o que libera o CORS do Google para esta sessão.
 */
export async function iniciarEnvio(p: {
  nome: string;
  mime: string;
  tamanho: number;
  pastaId: string;
  origem: string;
}): Promise<Resultado<{ urlDeEnvio: string }>> {
  const token = await accessToken();
  if (!token.ok) return token;
  try {
    const r = await fetch(`${UPLOAD}/files?uploadType=resumable&fields=id,name,mimeType,size,webViewLink,parents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.valor}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": p.mime || "application/octet-stream",
        "X-Upload-Content-Length": String(p.tamanho),
        Origin: p.origem,
      },
      body: JSON.stringify({ name: p.nome, parents: [p.pastaId] }),
    });
    const url = r.headers.get("location");
    if (!r.ok || !url) {
      logger.warn("agência: Drive recusou a sessão de envio", { status: r.status });
      return { ok: false, erro: `O Google Drive recusou o envio (${r.status}).` };
    }
    return { ok: true, valor: { urlDeEnvio: url } };
  } catch {
    return { ok: false, erro: "O Google Drive não respondeu agora." };
  }
}
