/**
 * Consumidor de `catalog_product.photos_import_requested`: traz para o bucket
 * as fotos de UM produto que ainda estão em link externo.
 *
 * Quem emite é a sincronização do catálogo da Meta
 * (`app/api/v1/products/integrations/meta/sync/route.ts`), um evento por
 * produto — baixar ~2.000 fotos dentro do clique estouraria o tempo da
 * requisição. Roda no laço do worker e no cron do event_log.
 *
 * Grava com "compare-and-set": só troca `fotos` se o produto não mudou desde a
 * leitura (`updated_at`, que o gatilho da tabela renova a cada edição). Se alguém mexeu na galeria nesse meio-tempo, desiste sem estragar nada
 * (o arquivo baixado fica no bucket e a próxima sincronização o reaproveita).
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { BUCKET_DAS_FOTOS, TAMANHO_MAXIMO_DA_FOTO } from "@/lib/catalogo/fotos";
import { ehFotoExterna, trazerFotosParaOArmazenamento } from "@/lib/catalogo/fotos-externas";
import { createAdminClient } from "@/lib/supabase/admin";

export const EVENTO_DE_FOTOS_EXTERNAS = "catalog_product.photos_import_requested";
export const CATALOGO_FOTOS_EXTERNAS_HANDLER_KEY = "catalogo-fotos-externas.v1";

async function baixar(url: string): Promise<Uint8Array | null> {
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), 20_000);
  try {
    const resp = await fetch(url, {
      signal: controle.signal,
      redirect: "follow",
      // Pedir JPG/PNG: CDN que negocia formato manda WEBP para quem aceita.
      headers: { Accept: "image/jpeg,image/png;q=0.9", "User-Agent": "Mozilla/5.0 (DeskcommCRM catalogo)" },
    });
    if (!resp.ok) return null;
    const declarado = Number(resp.headers.get("content-length") ?? 0);
    if (declarado > TAMANHO_MAXIMO_DA_FOTO) return null;
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return bytes.length > TAMANHO_MAXIMO_DA_FOTO ? null : bytes;
  } catch {
    return null;
  } finally {
    clearTimeout(prazo);
  }
}

export const catalogoFotosExternasHandler: EventHandler = {
  key: CATALOGO_FOTOS_EXTERNAS_HANDLER_KEY,
  naOrgParada: "pula",
  events: [EVENTO_DE_FOTOS_EXTERNAS],
  async handle(row): Promise<HandlerResult> {
    const key = CATALOGO_FOTOS_EXTERNAS_HANDLER_KEY;
    try {
      const produtoId = typeof row.payload.product_id === "string" ? row.payload.product_id : row.entity_id;
      if (!produtoId) return { consumer_key: key, status: "skipped", detail: "sem_produto" };
      const admin = createAdminClient();
      const { data: produto, error } = await admin
        .from("catalog_products")
        .select("id, fotos, updated_at")
        .eq("organization_id", row.organization_id)
        .eq("id", produtoId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const lido = produto as { fotos?: string[]; updated_at?: string } | null;
      const fotos = (lido?.fotos ?? []) as string[];
      if (!produto || !fotos.some(ehFotoExterna)) {
        return { consumer_key: key, status: "skipped", detail: "nada_a_baixar" };
      }

      const bucket = admin.storage.from(BUCKET_DAS_FOTOS);
      const trazidas = await trazerFotosParaOArmazenamento(
        {
          baixar,
          async subir(caminho, bytes, tipo) {
            const { error: erroUp } = await bucket.upload(caminho, bytes, { contentType: tipo, upsert: true });
            return !erroUp;
          },
        },
        { orgId: row.organization_id, produtoId, fotos },
      );
      if (trazidas.baixadas === 0 && trazidas.fotos.length === fotos.length) {
        return { consumer_key: key, status: "skipped", detail: `falhas=${trazidas.falhas}` };
      }

      const { data: gravado, error: erroGrava } = await admin
        .from("catalog_products")
        .update({ fotos: trazidas.fotos })
        .eq("organization_id", row.organization_id)
        .eq("id", produtoId)
        .eq("updated_at", lido?.updated_at ?? "")
        .select("id");
      if (erroGrava) throw new Error(erroGrava.message);
      return {
        consumer_key: key,
        status: gravado && gravado.length > 0 ? "ok" : "skipped",
        detail: `baixadas=${trazidas.baixadas} falhas=${trazidas.falhas}${gravado?.length ? "" : " galeria_mudou"}`,
      };
    } catch (err) {
      return { consumer_key: key, status: "error", detail: err instanceof Error ? err.message : String(err) };
    }
  },
};
