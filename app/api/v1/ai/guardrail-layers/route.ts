import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET/PUT /api/v1/ai/guardrail-layers — as duas verificações que custam dinheiro.
 *
 * A cadeia que confere a mensagem antes de sair tem dez verificações. Oito são
 * determinísticas, custam zero e **não são escolha de ninguém** — por isso não
 * existem aqui: uma rota que aceitasse desligá-las seria a porta para queimar o
 * número do cliente por um PUT, mesmo que a tela não oferecesse o botão.
 *
 * As duas que consultam um modelo custam por mensagem, e aí há escolha real.
 *
 * ═══ AUSÊNCIA DE LINHA NÃO É "DESLIGADO" ═══
 *
 * O GET devolve `null` para a camada que a organização nunca escolheu, e o
 * `padraoDoAmbiente` ao lado. É o que permite a tela dizer "ligada — vem da
 * configuração do servidor" em vez de mostrar um interruptor desligado que
 * mentiria sobre o estado real.
 *
 * ═══ CLIENT DE SESSÃO, NÃO SERVICE ROLE ═══
 *
 * `org_guardrail_layers` tem `tenant_isolation_org_guardrail_layers_all` via
 * `fn_user_org_ids()` (migration 0142), então a RLS já faz a tenancy. Usar
 * service role aqui trocaria uma garantia do banco por um filtro manual — a
 * vizinhança do anti-pattern 10 do CLAUDE.md. O filtro por `organization_id`
 * continua explícito no SQL porque o usuário pode pertencer a mais de uma
 * organização, e a RLS deixaria passar as duas.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { CAMADAS_SEMANTICAS } from "@/lib/agent-engine/guardrails/camadas-da-org";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * O padrão do ambiente, como o servidor web consegue enxergá-lo.
 *
 * ⚠️ O worker é OUTRO processo, com o SEU `.env` — este valor é a melhor leitura
 * disponível aqui, não a verdade absoluta do motor. A tela usa isto só para
 * dizer de onde a decisão vem quando a organização não escolheu; assim que ela
 * escolhe, a linha vence e a ambiguidade acaba. Prometer mais que isso seria
 * inventar precisão.
 */
function padraoDoAmbiente(): Record<string, boolean> {
  return {
    promessa_semantica: process.env.PROMISE_SEMANTIC_ENABLED === "true",
    jailbreak: (process.env.JAILBREAK_CLASSIFIER_MODEL ?? "") !== "",
  };
}

export async function GET(): Promise<Response> {
  const authz = await requireRole("manager", { resource: "ai_guardrail_layers" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const db = await createClient();
  const { data, error } = await db
    .from("org_guardrail_layers")
    .select("layer, enabled")
    .eq("organization_id", org.orgId);

  if (error) return fail("read_failed", error.message, 500);

  const escolhido = new Map((data ?? []).map((r) => [r.layer as string, r.enabled as boolean]));
  const padrao = padraoDoAmbiente();

  return ok({
    camadas: CAMADAS_SEMANTICAS.map((layer) => ({
      layer,
      /** `null` = a organização não escolheu; vale o ambiente. */
      escolha: escolhido.get(layer) ?? null,
      padraoDoAmbiente: padrao[layer] ?? false,
      efetivo: escolhido.get(layer) ?? padrao[layer] ?? false,
    })),
    podeEditar: roleAtLeast(org.role, "admin"),
  });
}

const corpoDoPut = z.object({
  // Só as camadas que TÊM escolha. Um valor fora da lista não é "desconhecido":
  // é alguém tentando desligar pela API o que a tela não oferece.
  layer: z.enum(CAMADAS_SEMANTICAS),
  enabled: z.boolean(),
});

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("admin", { resource: "ai_guardrail_layers" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = corpoDoPut.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", "corpo inválido", 422, { details: parsed.error.issues });
  }
  const corpo = parsed.data;

  const db = await createClient();
  const { data: gravado, error } = await db
    .from("org_guardrail_layers")
    .upsert(
      {
        organization_id: org.orgId,
        layer: corpo.layer,
        enabled: corpo.enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,layer" },
    )
    .select("layer, enabled")
    .maybeSingle();

  if (error) return fail("save_failed", error.message, 500);
  if (!gravado) {
    // Upsert que casa zero linhas devolve sucesso no PostgREST — a tela diria
    // "salvo" sem nada ter sido gravado. Mesmo cuidado da rota de provedores.
    return fail("save_failed", "nada foi gravado — verifique as permissões da organização", 500);
  }

  void audit({
    action: "ai.guardrail_layer_changed",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "org_guardrail_layers",
    // A chave é (organização, camada) — não há uuid a referenciar, e mandar o
    // nome da camada numa coluna uuid é o defeito que já custou duas trilhas de
    // auditoria neste repo.
    resourceId: null,
    metadata: { layer: corpo.layer, enabled: corpo.enabled },
  });

  return ok(gravado);
}
