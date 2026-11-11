/**
 * GET /api/v1/cron/storage-redaction
 *
 * Drains the LGPD `storage_redaction_queue` (one batch per call). Designed
 * to run from a scheduled cron (Vercel Cron / external cron) every few
 * minutes. Idempotent: rows transition pending → deleted | failed | skipped.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (fail-closed when
 * secret missing). Mirrors `app/api/v1/cron/kb-conversations-batch/route.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { drainStorageRedactionQueue } from "@/lib/lgpd/storage-redaction-queue";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO (#3773), na ordem do arquivo.
 *
 * O portão abaixo é saída antecipada da ROTA INTEIRA: em instalação ociosa a
 * rota sai antes de tudo isto. `tests/unit/cron-passa-pelo-portao.test.ts` lê o
 * AST deste arquivo e reprova quando o que está de fato abaixo do portão diverge
 * desta lista — passo novo que não roda na instalação parada não pode nascer
 * sem alguém ver.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "const url",
  "const limitParam",
  "const limit",
  "const stats",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // O PISO OCIOSO (#3731): A fila de redação de objeto é a única entrada da rodada.
  // A saída vem antes de qualquer consulta da rodada, e o portão responde de um
  // retrato em memória (`lib/cron/piso-ocioso.ts`): esta rota ia ao PostgREST a
  // cada batida só para descobrir que a fila está vazia.
  if (await recursoOcioso("redacao_de_storage")) return ok({ pulado: "recurso_ocioso" }, { requestId });

  const url = new URL(req.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const stats = await drainStorageRedactionQueue({ limit });

  return ok(stats, { requestId });
}
