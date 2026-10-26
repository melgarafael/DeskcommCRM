import "server-only";

import type { Formato, Rede } from "./regras";
import { ehVideo } from "./regras";

/**
 * Publicar na Meta (docs/agencia/SPEC-publicacoes.md, P5–P7). O token vai no
 * cabeçalho, nunca na URL (CLAUDE.md › API key em query string).
 *
 * NÃO PROVADO com conta real: o teste não tem conexão Meta com
 * `instagram_content_publish` / `pages_manage_posts`. Os caminhos seguem a
 * documentação da Graph API v21.0 (container + media_publish no Instagram;
 * /photos na página do Facebook).
 */

const GRAPH = "https://graph.facebook.com/v21.0";
const ESPERA_DO_VIDEO_MS = 90_000;

export interface AlvoDaMeta {
  facebookPageId: string | null;
  instagramBusinessId: string | null;
  token: string;
}

export interface PedidoDePublicacao {
  rede: Rede;
  formato: Formato;
  midiaUrl: string;
  legenda: string | null;
}

export type ResultadoDaMeta = { ok: true; postId: string; postUrl: string | null } | { ok: false; erro: string };

type Fetch = typeof fetch;

async function chamar(f: Fetch, caminho: string, token: string, corpo?: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await f(`${GRAPH}/${caminho}`, {
    method: corpo ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(corpo ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: corpo ? new URLSearchParams(corpo).toString() : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || json.error) {
    const e = json.error as { message?: string } | undefined;
    throw new Error(e?.message ? `A Meta recusou: ${e.message}`.slice(0, 400) : `A Meta respondeu ${r.status}.`);
  }
  return json;
}

const espera = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function noInstagram(f: Fetch, igId: string, token: string, p: PedidoDePublicacao): Promise<ResultadoDaMeta> {
  const video = ehVideo(p.midiaUrl);
  const corpo: Record<string, string> = video ? { video_url: p.midiaUrl } : { image_url: p.midiaUrl };
  if (p.formato === "reels") corpo.media_type = "REELS";
  if (p.formato === "story") corpo.media_type = "STORIES";
  if (p.legenda && p.formato !== "story") corpo.caption = p.legenda.slice(0, 2200);
  const container = String((await chamar(f, `${igId}/media`, token, corpo)).id ?? "");
  if (!container) return { ok: false, erro: "A Meta não devolveu o container da mídia." };

  // Vídeo é processado pela Meta antes de poder publicar.
  if (video) {
    const limite = Date.now() + ESPERA_DO_VIDEO_MS;
    for (;;) {
      const s = String((await chamar(f, `${container}?fields=status_code`, token)).status_code ?? "");
      if (s === "FINISHED") break;
      if (s === "ERROR" || s === "EXPIRED") return { ok: false, erro: "A Meta não conseguiu processar o vídeo (formato, tamanho ou duração)." };
      if (Date.now() > limite) return { ok: false, erro: "A Meta ainda processava o vídeo depois de 90 s; agende de novo." };
      await espera(5_000);
    }
  }
  const postId = String((await chamar(f, `${igId}/media_publish`, token, { creation_id: container })).id ?? "");
  if (!postId) return { ok: false, erro: "A Meta não devolveu o id do post." };
  let postUrl: string | null = null;
  try {
    const link = (await chamar(f, `${postId}?fields=permalink`, token)).permalink;
    postUrl = typeof link === "string" && link.startsWith("https://") ? link : null;
  } catch {
    // Publicado; só o link não veio.
  }
  return { ok: true, postId, postUrl };
}

async function noFacebook(f: Fetch, pageId: string, token: string, p: PedidoDePublicacao): Promise<ResultadoDaMeta> {
  // Publicar na página pede o token DA PÁGINA; a conexão pode guardar o do usuário.
  let tokenDaPagina = token;
  try {
    const t = (await chamar(f, `${pageId}?fields=access_token`, token)).access_token;
    if (typeof t === "string" && t) tokenDaPagina = t;
  } catch {
    // Já era o token da página.
  }
  const r = await chamar(f, `${pageId}/photos`, tokenDaPagina, { url: p.midiaUrl, ...(p.legenda ? { caption: p.legenda.slice(0, 5000) } : {}) });
  const postId = String(r.post_id ?? r.id ?? "");
  if (!postId) return { ok: false, erro: "A Meta não devolveu o id do post." };
  let postUrl: string | null = null;
  try {
    const link = (await chamar(f, `${postId}?fields=permalink_url`, tokenDaPagina)).permalink_url;
    postUrl = typeof link === "string" && link.startsWith("https://") ? link : null;
  } catch {
    // Publicado; só o link não veio.
  }
  return { ok: true, postId, postUrl };
}

export async function publicarNaMeta(alvo: AlvoDaMeta, p: PedidoDePublicacao, f: Fetch = fetch): Promise<ResultadoDaMeta> {
  try {
    if (p.rede === "instagram") {
      if (!alvo.instagramBusinessId) return { ok: false, erro: "A conexão Meta do cliente não tem conta do Instagram." };
      return await noInstagram(f, alvo.instagramBusinessId, alvo.token, p);
    }
    if (p.rede === "facebook") {
      if (!alvo.facebookPageId) return { ok: false, erro: "A conexão Meta do cliente não tem página do Facebook." };
      if (ehVideo(p.midiaUrl)) return { ok: false, erro: "Vídeo no Facebook ainda é só à mão." };
      return await noFacebook(f, alvo.facebookPageId, alvo.token, p);
    }
    return { ok: false, erro: "Essa rede ainda é só à mão." };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message.slice(0, 400) : "Falha ao falar com a Meta." };
  }
}
