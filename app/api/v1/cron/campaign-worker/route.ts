/**
 * GET/POST /api/v1/cron/campaign-worker — uma rodada de campanha.
 *
 * A lógica inteira mora em `lib/campanhas/rodada.ts`; esta rota só autentica,
 * chama e audita **quando houve efeito**. Rodada que não enviou, não pulou, não
 * concluiu e não promoveu nada não é mutação e não ocupa linha de auditoria —
 * mesmo critério de `asaas-reconcile` e `attendant-heartbeat`, e o que
 * `tests/unit/cron-audita-so-quando-ha-efeito.test.ts` varre no AST.
 *
 * No máximo uma mensagem por NÚMERO por rodada: o ritmo é o produto, e quem
 * dispara em rajada queima o número. Ver o cabeçalho de `lib/campanhas/rodada.ts`.
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O agendamento
 * vive no serviço `scheduler` do `docker-compose.prod.yml`
 * (`docker/scheduler/entrypoint.sh`) e em `vercel.ts`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

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
 * Em runtime a constante não serve para nada — o `void` existe só para o lint
 * não acusar variável sem uso.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "const r",
  "if (r.enviadas > 0 || r.pulados > 0 || r.concluidas > 0 || r.promovidas > 0)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // O PISO OCIOSO (#3731): instalação sem campanha em `running`/`scheduled` não
  // tem o que esta rodada faça. A saída vem antes da primeira consulta da
  // rodada; o portão responde de um retrato em memória.
  if (await recursoOcioso("campanhas")) return ok({ pulado: "recurso_ocioso" }, { requestId });

  const r = await rodarUmaRodadaDeCampanha(createAdminClient());

  if (r.enviadas > 0 || r.pulados > 0 || r.concluidas > 0 || r.promovidas > 0) {
    void audit({
      action: "cron.campaign_worker",
      requestId,
      bypassedRls: true,
      metadata: {
        enviadas: r.enviadas,
        pulados: r.pulados,
        concluidas: r.concluidas,
        promovidas: r.promovidas,
        detalhe: r.detalhe,
      },
    });
  }

  return ok(r, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
