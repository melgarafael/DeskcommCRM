import "server-only";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchDoServidor } from "@/lib/supabase/fetch-do-servidor";
import { urlDoSupabaseNoServidor } from "@/lib/supabase/url-do-servidor";

import { BUCKET_DOS_ENVIOS } from "./regras";

/**
 * O bucket privado dos envios (SPEC-envios, E3, E4, E7, E8). Só o servidor assina
 * envio e leitura; o navegador nunca vê a chave de serviço.
 */

const base = () => env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "");
const transporte = () => fetchDoServidor(urlDoSupabaseNoServidor(env.SUPABASE_SERVER_URL, env.NEXT_PUBLIC_SUPABASE_URL), env.NEXT_PUBLIC_SUPABASE_URL);

/** E3: a permissão de envio de UM caminho — o navegador manda em partes (TUS) com ela. */
export async function assinarEnvio(caminho: string): Promise<{ endpoint: string; assinatura: string } | null> {
  const { data, error } = await createAdminClient().storage.from(BUCKET_DOS_ENVIOS).createSignedUploadUrl(caminho);
  if (error || !data?.token) {
    logger.warn("agência: Storage recusou assinar o envio", { detalhe: error?.message });
    return null;
  }
  return { endpoint: `${base()}/storage/v1/upload/resumable/sign`, assinatura: data.token };
}

/** O objeto chegou? Devolve o tamanho e o tipo que o Storage gravou. */
export async function conferirObjeto(caminho: string): Promise<{ bytes: number; mime: string | null } | null> {
  const barra = caminho.lastIndexOf("/");
  const { data } = await createAdminClient()
    .storage.from(BUCKET_DOS_ENVIOS)
    .list(caminho.slice(0, barra), { search: caminho.slice(barra + 1), limit: 5 });
  const o = (data ?? []).find((x) => x.name === caminho.slice(barra + 1));
  if (!o) return null;
  const meta = (o.metadata ?? {}) as { size?: number; mimetype?: string };
  return { bytes: Number(meta.size ?? 0), mime: meta.mimetype ?? null };
}

/** E4: link de leitura de 3 horas, gerado a cada abertura da tela. */
export async function linksDeLeitura(caminhos: string[]): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  if (caminhos.length === 0) return mapa;
  const { data } = await createAdminClient().storage.from(BUCKET_DOS_ENVIOS).createSignedUrls(caminhos, 3 * 60 * 60);
  for (const d of data ?? []) if (d.path && d.signedUrl) mapa.set(d.path, d.signedUrl);
  return mapa;
}

/** E7/E8: apaga da VPS. Nunca lança — quem chama decide o que registrar. */
export async function apagarObjetos(caminhos: string[]): Promise<boolean> {
  if (caminhos.length === 0) return true;
  const { error } = await createAdminClient().storage.from(BUCKET_DOS_ENVIOS).remove(caminhos);
  if (error) logger.warn("agência: não deu para apagar envios do Storage", { detalhe: error.message, quantos: caminhos.length });
  return !error;
}

/** E6: um pedaço do arquivo (faixa de bytes), para a cópia ao Drive sem carregar tudo na memória. */
export async function lerFaixa(caminho: string, inicio: number, fim: number): Promise<Uint8Array> {
  const r = await transporte()(`${base()}/storage/v1/object/${BUCKET_DOS_ENVIOS}/${caminho.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: env.SUPABASE_SERVICE_ROLE_KEY, Range: `bytes=${inicio}-${fim}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (r.status !== 206 && r.status !== 200) throw new Error(`O Storage respondeu ${r.status} ao ler o envio.`);
  const corpo = new Uint8Array(await r.arrayBuffer());
  // 200 = o servidor ignorou a faixa e mandou tudo: recorta (arquivo pequeno).
  return r.status === 200 ? corpo.subarray(inicio, fim + 1) : corpo;
}
