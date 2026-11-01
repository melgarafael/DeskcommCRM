import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { ok, fail } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { createAdminClient } from "@/lib/supabase/admin";
import { tickProspecting } from "@/lib/prospecting/worker";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO (#3773), na ordem do arquivo.
 *
 * O `if (await recursoOcioso(...))` desta rota é saída antecipada da ROTA
 * INTEIRA: o que vier depois dele não roda em instalação ociosa. Esta lista é a
 * declaração do que roda ali — `tests/unit/cron-passa-pelo-portao.test.ts` lê o
 * AST deste arquivo e reprova, com arquivo e linha, quando o que está de fato
 * abaixo do portão divergir dela. Passo novo abaixo do portão entra aqui, e só
 * depois de a pessoa ver que ele NÃO roda na instalação parada, que é o caso
 * comum. O #3650 mediu o custo de não haver essa cerca: três passos novos na
 * `historico-import` ficaram fora do sinal do portão e o autor teve de alargá-lo
 * à mão.
 *
 * Aqui o `try` é UM passo só: o que está DENTRO dele não entra nesta lista (ver
 * o limite registrado no cabeçalho do teste da cerca).
 *
 * Em runtime a constante não serve para nada — o `void` existe só para o lint
 * não acusar variável sem uso.
 */
const PASSOS_DEPOIS_DO_PORTAO = ["try"] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function handle(req: NextRequest) {
  const requestId = randomUUID();
  if (!autorizaCron(req))
    return fail("forbidden", "Credencial de execução inválida.", 403, { requestId });
  // O PISO OCIOSO (#3731). Sem campanha de prospecção na instalação — o caso
  // comum de quem nunca ligou o recurso —, a rodada saía do banco com a mesma
  // resposta a cada minuto. A saída fica ANTES de qualquer consulta da rodada;
  // o portão responde de um retrato em memória (ver lib/cron/piso-ocioso.ts).
  if (await recursoOcioso("prospeccao")) return ok({ pulado: "recurso_ocioso" }, { requestId });
  try {
    return ok(await tickProspecting(getRequestPool(), createAdminClient()), { requestId });
  } catch (err) {
    // O `catch` era SEM PARÂMETRO: o objeto do erro não ficava de fora do log,
    // ele era DESCARTADO — não existia em variável nenhuma. Num cron, que roda
    // sozinho e sem ninguém olhando, isso significava que a prospecção da
    // instalação inteira podia parar e a única evidência ser um 500 numa
    // resposta que ninguém lê.
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[prospecting.cron] tickProspecting lançou", { error: detalhe, requestId });
    // O detalhe vai na resposta, como o routing-worker faz: quem chama o cron à
    // mão para investigar merece ler a causa, não uma frase genérica.
    return fail("internal_error", detalhe, 500, { requestId });
  }
}
export const GET = handle;
export const POST = handle;
