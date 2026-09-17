/**
 * GET/POST /api/v1/tags/vocabulario — o vocabulário de etiquetas da organização
 * ativa, e as três operações que faltavam nele (issue #852, fatia S4).
 *
 * ── Por que manager, e não agent ─────────────────────────────────────────────
 *
 * A leitura é inofensiva, mas a escrita REESCREVE o vocabulário de todo mundo da
 * organização, inclusive as regras `add_tag` dos agentes — é decisão de
 * configuração, não de atendimento. Mesmo gate do roteamento de filas
 * (`settings_routing`), que também é configuração de organização.
 *
 * ── Por que a rota existe, se o Inbox já lê `GET /conversation-tags` ─────────
 *
 * São perguntas diferentes. `conversation-tags` responde "que etiqueta eu posso
 * oferecer neste atendimento" (vocabulário + o que está em uso). Esta responde
 * "onde esta etiqueta está, com que peso, e o que acontece se eu mexer nela" —
 * com uso por tabela e o número de regras de agente que ainda escrevem o nome.
 * A tela de Tags precisa das duas informações antes de deixar renomear: sem
 * elas, renomear é aposta.
 *
 * ── Contrato de leitura (combinado no fio da #852) ───────────────────────────
 *
 * `data` é uma lista, uma linha por etiqueta:
 * `{ tag, uso_em_contatos, uso_em_leads, uso_em_conversas, em_regras, cor,
 *    descricao, no_vocabulario }` — os mesmos nomes de campo que a leitura "em
 * uso" já usa, para a troca de fonte custar uma linha por campo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { vocabularioDeTagsSchema, type LinhaDeVocabulario } from "@/lib/schemas/tags";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_tags" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const db = await createClient();
  // Client da SESSÃO: a função é `security invoker`, então quem recorta a
  // organização é a RLS e o `p_org` da sessão — pedir a de outro tenant não
  // devolve nada.
  const { data, error } = await db.rpc("fn_vocabulario_de_tags", {
    p_org: auth.org.orgId,
  });
  if (error) return fail("internal_error", "Não foi possível carregar as etiquetas.", 500, { requestId });

  const tags = (data ?? []) as LinhaDeVocabulario[];
  return ok(tags, {
    requestId,
    meta: {
      total: tags.length,
      // Quantas etiquetas a TELA não pode renomear em silêncio: cada uma delas
      // é um agente que ainda vai escrever esse nome amanhã.
      em_regras: tags.filter((t) => t.em_regras > 0).length,
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  // ⚠️ SEM `allowPlatformAdmin`. O portão de escrita é o da FUNÇÃO
  // (`fn_role_at_least(p_org, 'manager')`, que não conhece platform admin), e
  // deixar passar aqui só adiava o 42501 → 403 para depois do clique. A leitura
  // acima segue a mesma régua, para a tela não oferecer o que a escrita recusa.
  const auth = await requireRole("manager", { requestId, resource: "settings_tags" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const parsed = vocabularioDeTagsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira a etiqueta e o novo nome.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const { acao, tag, destino } = parsed.data;

  const db = await createClient();
  // Uma chamada só. Renomear a etiqueta e trocar o nome nas regras `add_tag` dos
  // agentes acontece na MESMA transação — é isto que impede o estado que a issue
  // descreve: contato renomeado com o agente ainda escrevendo o nome antigo.
  const { data, error } = await db.rpc("fn_vocabulario_de_tags_operar", {
    p_org: auth.org.orgId,
    p_acao: acao,
    p_tag: tag,
    p_destino: destino ?? null,
  });
  if (error) {
    if (error.code === "42501")
      return fail("forbidden", "Esta sessão não pode mudar as etiquetas da organização.", 403, { requestId });
    if (error.code === "22023")
      return fail("validation_failed", "Confira a etiqueta e o novo nome.", 422, { requestId });
    return fail("internal_error", "Não foi possível concluir a operação.", 500, { requestId });
  }

  const resultado = (data ?? {}) as Record<string, unknown>;
  void audit({
    action: "tag_vocabulary.changed",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "organization",
    resourceId: auth.org.orgId,
    requestId,
    metadata: { acao, tag, destino: destino ?? null, ...resultado },
  });
  return ok(resultado, { requestId });
}
