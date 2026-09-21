import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";
import type { StudioItem } from "./schema";

export async function listItems(org: string, id?: string) {
  const { rows } = await getRequestPool().query<StudioItem>(
    `select id,kind,status,input,caption,answer,sources,asset_path,error,created_at,updated_at
     from instagram_studio_items where organization_id=$1 ${id ? "and id=$2" : `and (kind='reference' or id in (select id from instagram_studio_items where organization_id=$1 and kind <> 'reference' order by created_at desc limit 100))`} order by created_at desc`,
    id ? [org, id] : [org],
  );
  return Promise.all(
    rows.map(async (row) => {
      if (
        row.status === "generating" &&
        Date.now() - new Date(row.updated_at).getTime() > 600_000
      ) {
        row = {
          ...row,
          status: "failed",
          error:
            "A geração foi interrompida. Seu pedido foi preservado; confira a biblioteca antes de gerar novamente.",
        };
      }
      if (!row.asset_path) return row;
      const { data, error } = await createAdminClient()
        .storage.from("whatsapp-media")
        .createSignedUrl(row.asset_path, 3600);
      return { ...row, image_url: error ? null : data.signedUrl };
    }),
  );
}
