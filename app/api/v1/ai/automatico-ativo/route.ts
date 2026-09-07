/**
 * GET /api/v1/ai/automatico-ativo — existe atendimento automático nesta org?
 *
 * ## Por que uma rota só para isto
 *
 * O selo de comando do Inbox dizia "Automático atendendo" em toda conversa sem
 * dono e sem trava — **sem saber se existe algum automático**. Numa instalação
 * que ainda não configurou agente nenhum (o estado de todo primeiro deploy), a
 * tela afirmava que o robô estava cuidando de conversas que ninguém estava
 * respondendo. É a frase tranquilizadora que a doutrina proíbe, e ela cai
 * justamente na primeira impressão, que é P0.
 *
 * `GET /api/v1/ai/agents` responderia, mas exige `manager+` — e quem vive no
 * Inbox é o `agent`. Alargar aquela rota exporia prompt, guardrails e modelo a
 * quem não precisa. Esta devolve UM booleano: o mínimo que a tela precisa para
 * parar de afirmar o que não sabe.
 *
 * O predicado é `agenteAtende` (`lib/ai/agents/no-ar.ts`), a MESMA régua que o
 * worker legado e a tela usam — e não `published_version_id` sozinho: o motor
 * moderno exige versão publicada, mas o worker legado responde sem ela, e
 * perguntar só pela versão diria "não há automático" numa org onde há.
 *
 * Este parágrafo já disse "o mesmo predicado que o worker usa: `is_active` +
 * não arquivado", e isso VENCEU quando o worker parou de escolher por
 * `is_active` — a rota seguiu contando agente pausado como automático de pé,
 * afirmando "IA atendendo" logo depois de o dono pausar. É por isso que os dois
 * lados agora importam a mesma função em vez de descreverem um ao outro.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { agenteAtende } from "@/lib/ai/agents/no-ar";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  // `head: true` + `count` não serve mais: a régua olha quatro colunas por
  // linha, e uma contagem no banco não sabe respondê-la sem duplicar a regra em
  // SQL — que é como ela se desencontrou da primeira vez.
  const { data, error } = await supabase
    .from("ai_agents")
    .select("kind, is_active, paused_at, published_version_id, archived_at")
    .eq("organization_id", authz.org.orgId)
    .is("archived_at", null);

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok({ ativo: (data ?? []).some(agenteAtende) }, { requestId });
}
