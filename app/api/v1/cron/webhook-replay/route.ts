/**
 * GET/POST /api/v1/cron/webhook-replay — a mensagem que não terminou de entrar
 * volta a ser tentada, pelo arquivo do webhook.
 *
 * Duas metades, cada uma com a sua regra em `lib/channels/`:
 *
 *   - o canal por QR devolve 503 quando o banco falha de forma transitória e o
 *     transporte reentrega por alguns segundos; o que não entrar nessa janela
 *     fica no arquivo marcado `transitoria:` (`reprocessar-arquivo-de-webhook.ts`);
 *   - a entrada que responde ao provedor ANTES de processar deixa a linha
 *     `received` e aceita quando a ingestão não termina — o contêiner reiniciou
 *     no meio, ou ela falhou (`reprocessar-entradas-aceitas.ts`).
 *
 * As duas rodam a cada minuto, uma depois da outra, e a falha de uma não impede
 * a outra: são filas diferentes, e o banco que recusou a primeira leitura pode
 * aceitar a segunda. As duas ficam DEPOIS do portão do piso ocioso, e por isso o
 * sinal `webhook_replay` de `lib/cron/piso-ocioso.ts` cobre as duas filas. Aqui
 * ficam só a autenticação e a auditoria.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed). Agendado no serviço `scheduler`
 * (`docker/scheduler/entrypoint.sh`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import {
  reprocessarArquivoDeWebhooks,
  type ResultadoDoReplay,
} from "@/lib/channels/reprocessar-arquivo-de-webhook";
import { reprocessarEntradasAceitas } from "@/lib/channels/reprocessar-entradas-aceitas";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Os passos que rodam DEPOIS do portão do piso ocioso, na ordem do arquivo.
 * `tests/unit/cron-passa-pelo-portao.test.ts` lê o AST e reprova se divergir:
 * passo novo aqui embaixo NÃO roda numa instalação sem trabalho no arquivo.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "const admin",
  "const agora",
  "let falhou",
  "let porQr",
  "try",
  "let aceitas",
  "try",
  "const result",
  "if (efeito(porQr) + efeito(aceitas) > 0)",
  "if (falhou)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

const VAZIO: ResultadoDoReplay = { lidas: 0, processadas: 0, ainda_falhando: 0, desistidas: 0 };

const efeito = (r: ResultadoDoReplay) => r.processadas + r.desistidas;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // #3694 (crédito: @webtecnica): sem NENHUMA linha transitória no arquivo, a
  // rodada saía vazia em 143 de 144 tiques (medido na issue). O piso ocioso
  // responde isso de um retrato em memória (lib/cron/piso-ocioso.ts), sem
  // trazer as 50 linhas com `payload_parsed` que o replay carrega. O sinal é um
  // SUPERCONJUNTO dos filtros das duas metades (não aplica o corte de espera),
  // de propósito: linha recém-arquivada nunca fica invisível para o replay.
  if (await recursoOcioso("webhook_replay")) return ok({ pulado: "recurso_ocioso" }, { requestId });

  const admin = createAdminClient();
  const agora = new Date();
  let falhou = false;

  let porQr: ResultadoDoReplay = VAZIO;
  try {
    porQr = await reprocessarArquivoDeWebhooks(admin, agora, requestId);
  } catch (err) {
    falhou = true;
    logger.error("[webhook-replay] falhou", { error: err instanceof Error ? err.message : String(err), requestId });
  }

  let aceitas: ResultadoDoReplay = VAZIO;
  try {
    aceitas = await reprocessarEntradasAceitas(admin, agora);
  } catch (err) {
    falhou = true;
    logger.error("[webhook-replay] entradas aceitas falharam", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
  }

  // O formato de antes continua no topo (é o do canal por QR); a metade nova
  // vai numa chave própria, para quem lê a auditoria saber de qual fila veio.
  const result = { ...porQr, entradas_aceitas: aceitas };

  // Rodada que não reprocessou nem desistiu de nada não é mutação e não audita.
  if (efeito(porQr) + efeito(aceitas) > 0) {
    void audit({
      action: "webhook.replay_run",
      organizationId: null,
      bypassedRls: true,
      metadata: result as unknown as Record<string, unknown>,
      requestId,
    });
  }

  if (falhou) return fail("internal_error", "Failed to replay webhooks.", 500, { requestId });
  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
