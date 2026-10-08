import { z } from "zod";

export const PROVEDOR = "nuvemshop" as const;
/** 50 e não 200: cada pedido custa ~4 consultas, e o evento precisa caber no dreno por cron. */
export const PAGINA_TAMANHO = 50;
/** A Nuvemshop entrega no máximo 10.000 itens por consulta. */
export const PAGINA_MAXIMA = 10_000 / PAGINA_TAMANHO;
export const MESES_DE_BACKFILL = 12;
export const TRAVA_MS = 15 * 60_000;
export const EVENTO_SYNC_PAGE = "nuvemshop.sync_page";

export type OrigemDoRun = "conexao" | "reconciliacao" | "manual";

export const passoDoSyncSchema = z.object({
  run_id: z.uuid(),
  janela_ini: z.iso.datetime(),
  janela_fim: z.iso.datetime(),
  alvo_fim: z.iso.datetime(),
  pagina: z.number().int().min(1),
});
export type PassoDoSync = z.infer<typeof passoDoSyncSchema>;
