/**
 * GET/POST /api/v1/cron/risk-watcher — wave 7, peça 5 (o ciclo).
 *
 * O OBSERVADOR DA TRAVESSIA. Antes desta wave, `classifyRisk` só rodava dentro
 * de rotas de LEITURA: "esfriando" não existia até alguém abrir a tela. Um radar
 * que só enxerga quando observado não é mecanismo anti-morte — é a mesma morte,
 * com testemunha opcional. Esta rota é o que faz o estado acontecer sozinho.
 *
 * Para cada organização com negócio aberto, compara o bucket ATUAL com o
 * GRAVADO. Só escreve quando muda, e a travessia que conta para um humano vira
 * linha na timeline (`lead_cooled` / `lead_reactivated`).
 *
 * ⚠️ NÃO TOCA `crm_leads` — nem direto, nem pelo trigger: os tipos que ele emite
 * estão fora da lista positiva da 0079. É isso que impede o produtor de apagar o
 * próprio estado ao registrá-lo, e que impede um worker de segundo plano de
 * invalidar o arrasto em voo do usuário (o 409 fantasma da 0075). Provado com
 * hash de (id, updated_at) de todos os leads antes e depois da passada.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 *
 * DEPLOY: não há `vercel.json` neste repo (self-host). Esta rota é agendada no
 * serviço `scheduler` do `docker-compose.prod.yml`, a cada 15 min — cadência
 * grossa de propósito, porque a menor janela de estágio é medida em HORAS.
 *
 * ⚠️ Esta nota já pediu o agendamento no futuro do verbo ("o kit PRECISA
 * agendar") e ficou assim por meses: a rota existia, tinha teste e tinha doc, e
 * NINGUÉM A CHAMAVA num self-host — nada esfriava sozinho, nenhuma proposta
 * nascia, e o modo de falha era silencioso ("nada esfriou" é indistinguível de
 * "nada esfriou ainda"). Pedido em comentário não é agendamento. Hoje a garantia
 * é mecânica: `tests/unit/cron-routes-scheduled.test.ts` compara o diretório de
 * rotas com o crontab e fica VERMELHO se alguma rota ficar órfã dos dois lados.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { venceReativacoes } from "@/lib/leads/reactivation";
import { observaTravessias } from "@/lib/leads/risk-worker";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/** Teto de orgs por invocação — a próxima passada pega o resto. */
const ORG_LIMIT = 50;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("crm_leads")
    .select("organization_id")
    .eq("status", "open");
  if (error) {
    logger.error("[risk-watcher] query failed", { error: error.message, requestId });
    return fail("internal_error", "Failed to list organizations.", 500, { requestId });
  }

  const orgs = [
    ...new Set(((rows ?? []) as Array<{ organization_id: string }>).map((r) => r.organization_id)),
  ].slice(0, ORG_LIMIT);

  let travessias = 0;
  let esfriaram = 0;
  let reativaram = 0;
  let falhas = 0;
  // Gravações de estado que falharam. O observador parou de abortar a org na
  // primeira linha ruim e passou a CONTAR a falha — e contagem que ninguém soma
  // é o silêncio que o `continue` prometia evitar: a org some de
  // `organizations_com_erro` e nada ocupa o lugar dela.
  let gravacoesFalhas = 0;
  let propostas = 0;
  let vencidas = 0;
  const comErro: string[] = [];

  for (const org of orgs) {
    try {
      const r = await observaTravessias(admin, org);
      travessias += r.travessias;
      esfriaram += r.esfriaram;
      reativaram += r.reativaram;
      falhas += r.falhasDeAtividade;
      gravacoesFalhas += r.falhasDeGravacao;
      propostas += r.propostas;

      // O VENCIMENTO RODA NO MESMO TICK, depois da travessia. Se morasse num
      // cron separado, a proposta poderia vencer em silêncio até o outro rodar
      // — e o buraco entre os dois seria exatamente onde a demanda morre.
      const v = await venceReativacoes(admin, org, new Date());
      vencidas += v.vencidas;
      falhas += v.falhasDeAtividade;
    } catch (e) {
      // Uma org que falha NÃO derruba as outras. Sem isto, um tenant com dado
      // estranho congelaria o radar de todos os demais — e o sintoma seria
      // "ninguém esfria mais", que é indistinguível de "está tudo em dia".
      comErro.push(org);
      logger.error("[risk-watcher] org falhou", {
        organizationId: org,
        error: e instanceof Error ? e.message : String(e),
        requestId,
      });
    }
  }

  if (falhas > 0) {
    logger.warn("[risk-watcher] travessias sem linha na timeline", { falhas, requestId });
  }
  if (gravacoesFalhas > 0) {
    logger.warn("[risk-watcher] travessias sem estado gravado", { gravacoesFalhas, requestId });
  }

  return ok(
    {
      organizations: orgs.length,
      travessias,
      esfriaram,
      reativaram,
      propostas_criadas: propostas,
      propostas_vencidas: vencidas,
      atividades_falhas: falhas,
      gravacoes_falhas: gravacoesFalhas,
      organizations_com_erro: comErro.length,
    },
    { requestId },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
