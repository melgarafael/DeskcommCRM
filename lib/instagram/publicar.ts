/**
 * As chamadas de rede que efetivamente publicam no Instagram: cria o
 * container de mídia, espera a Meta processar, publica, busca o link
 * público. Nenhuma lança — mesma razão de `token.ts`: quem chama precisa de
 * um motivo legível pra devolver ao agente (e daí para o lead), não uma
 * stack trace.
 *
 * Fluxo documentado pela Meta (Content Publishing API): POST .../media cria
 * o container: `image_url` (feed) ou `video_url` + `media_type=REELS`
 * (reels); o container processa de forma assíncrona — sobretudo vídeo — e só
 * fica publicável quando `status_code` vira `FINISHED`; POST .../media_publish
 * com `creation_id` publica de fato.
 */
import { graphVersion } from "@/lib/graph-version";

/** A versão da Graph API tem um lugar só: `lib/graph-version.ts`. */
function graphBase(): string {
  return `https://graph.instagram.com/${graphVersion()}`;
}
const PRAZO_MS = 15_000;

async function chamar(url: URL, init?: RequestInit): Promise<{ status: number; corpo: unknown }> {
  const resposta = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(PRAZO_MS),
    cache: "no-store",
  });
  const corpo = await resposta.json().catch(() => null);
  return { status: resposta.status, corpo };
}

function mensagemDeErro(corpo: unknown): string | null {
  const registro = corpo as { error?: { message?: string; error_user_msg?: string } } | null;
  return registro?.error?.error_user_msg ?? registro?.error?.message ?? null;
}

export type ResultadoContainer =
  | { ok: true; containerId: string }
  | { ok: false; motivo: string };

export async function criarContainer(args: {
  igUserId: string;
  accessToken: string;
  destino: "feed" | "reels" | "stories";
  mediaUrl: string;
  mediaTipo: "image" | "video";
  /** Ignorada para `stories` — a API do Instagram não aceita legenda em story. */
  caption: string;
}): Promise<ResultadoContainer> {
  const url = new URL(`${graphBase()}/${args.igUserId}/media`);
  const campos: Record<string, string> = { access_token: args.accessToken };
  if (args.destino !== "stories") campos.caption = args.caption;
  if (args.mediaTipo === "video") campos.video_url = args.mediaUrl;
  else campos.image_url = args.mediaUrl;
  if (args.destino === "reels") campos.media_type = "REELS";
  else if (args.destino === "stories") campos.media_type = "STORIES";
  const body = new URLSearchParams(campos);

  const { status, corpo } = await chamar(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const erro = mensagemDeErro(corpo);
  if (erro) return { ok: false, motivo: erro };

  const id = (corpo as { id?: string } | null)?.id;
  if (status !== 200 || typeof id !== "string" || !id) {
    return { ok: false, motivo: `HTTP ${status} sem id de container na resposta` };
  }
  return { ok: true, containerId: id };
}

export type StatusDoContainer = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

export type ResultadoStatus =
  | { ok: true; status: StatusDoContainer }
  | { ok: false; motivo: string };

export async function statusDoContainer(args: {
  containerId: string;
  accessToken: string;
}): Promise<ResultadoStatus> {
  const url = new URL(`${graphBase()}/${args.containerId}`);
  url.searchParams.set("fields", "status_code");
  url.searchParams.set("access_token", args.accessToken);

  const { corpo } = await chamar(url);
  const erro = mensagemDeErro(corpo);
  if (erro) return { ok: false, motivo: erro };

  const status = (corpo as { status_code?: string } | null)?.status_code;
  if (!status) return { ok: false, motivo: "resposta sem status_code" };
  return { ok: true, status: status as StatusDoContainer };
}

/**
 * Espera o container sair de `IN_PROGRESS`. Vídeo (reels) pode levar de
 * segundos a poucos minutos — a Meta não dá estimativa, só recomenda poll
 * periódico. 5s de intervalo, até 24 tentativas (~2min): acima disso, é
 * melhor devolver "ainda processando" e deixar o operador tentar publicar de
 * novo do que segurar o turno do agente por mais tempo.
 */
export async function esperarContainerPronto(
  args: { containerId: string; accessToken: string },
  opcoes: { tentativas?: number; intervaloMs?: number } = {},
): Promise<ResultadoStatus> {
  const tentativas = opcoes.tentativas ?? 24;
  const intervaloMs = opcoes.intervaloMs ?? 5000;

  for (let i = 0; i < tentativas; i++) {
    const leitura = await statusDoContainer(args);
    if (!leitura.ok) return leitura;
    if (leitura.status === "FINISHED" || leitura.status === "PUBLISHED") return leitura;
    if (leitura.status === "ERROR" || leitura.status === "EXPIRED") {
      return { ok: false, motivo: `processamento terminou como ${leitura.status}` };
    }
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  return { ok: false, motivo: "ainda_processando" };
}

export type ResultadoPublicar =
  | { ok: true; mediaId: string }
  | { ok: false; motivo: string };

export async function publicarContainer(args: {
  igUserId: string;
  containerId: string;
  accessToken: string;
}): Promise<ResultadoPublicar> {
  const url = new URL(`${graphBase()}/${args.igUserId}/media_publish`);
  const body = new URLSearchParams({
    creation_id: args.containerId,
    access_token: args.accessToken,
  });

  const { status, corpo } = await chamar(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const erro = mensagemDeErro(corpo);
  if (erro) return { ok: false, motivo: erro };

  const id = (corpo as { id?: string } | null)?.id;
  if (status !== 200 || typeof id !== "string" || !id) {
    return { ok: false, motivo: `HTTP ${status} sem id de mídia na resposta` };
  }
  return { ok: true, mediaId: id };
}

export async function permalinkDoMedia(args: {
  mediaId: string;
  accessToken: string;
}): Promise<string | null> {
  const url = new URL(`${graphBase()}/${args.mediaId}`);
  url.searchParams.set("fields", "permalink");
  url.searchParams.set("access_token", args.accessToken);

  const { corpo } = await chamar(url);
  const permalink = (corpo as { permalink?: string } | null)?.permalink;
  return typeof permalink === "string" ? permalink : null;
}
