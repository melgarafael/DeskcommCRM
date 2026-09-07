import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/system/relogio/tick — uma batida do relógio.
 *
 * Auth: sessão admin OU Bearer INTERNAL_SECRET (GitHub Actions / cron externo).
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { executarTickDoRelogio } from "@/lib/relogio/executar";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Comparação em TEMPO CONSTANTE, e não `includes()`.
 *
 * `===`/`includes` de string sai no primeiro byte diferente: medindo o tempo
 * da resposta dá para descobrir o segredo byte a byte. Numa rota que está em
 * `PUBLIC_PATHS` — ou seja, que responde a quem chegar, sem cookie — isso é
 * um oráculo aberto.
 *
 * A forma é a mesma do irmão `app/api/v1/system/agent/route.ts`, que usa o
 * MESMO segredo: `timingSafeEqual` LANÇA quando os tamanhos diferem, então o
 * curto-circuito de tamanho evita que um segredo do tamanho errado vire 500
 * em vez de 403.
 */
function bearerValido(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const provided = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  if (!provided) return false;
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  return accepted.some((expected) => {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * Via `requireRole`, e não a comparação manual de antes: ganha o gate de MFA
 * de graça — uma sessão admin `aal1` não deve conseguir disparar manualmente
 * um tick de produção só porque tem o rank. `allowPlatformAdmin` replica o
 * bypass que já existia aqui.
 */
async function sessaoAdmin(requestId: string): Promise<boolean> {
  const authz = await requireRole("admin", {
    requestId,
    resource: "system_relogio_tick",
    allowPlatformAdmin: true,
  });
  return authz.ok;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const porSegredo = bearerValido(req);
  if (!porSegredo && !(await sessaoAdmin(requestId))) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  try {
    const resultado = await executarTickDoRelogio();
    if (resultado.mexeu) {
      const user = porSegredo ? null : await loadAuthUser();
      void audit({
        action: "relogio.tick_run",
        actorUserId: user?.id,
        organizationId: null,
        bypassedRls: true,
        requestId,
        metadata: { tarefas: resultado.tarefas.map((t) => ({ id: t.id, ok: t.ok })) },
      });
    }
    return ok(resultado, { requestId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail("internal_error", detail, 500, { requestId });
  }
}

/** Alguns crons externos só sabem GET. Mesmo trabalho do POST. */
export async function GET(req: NextRequest): Promise<Response> {
  return POST(req);
}
