import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/followups/enrollments — lista enrollments da org ativa
 *   (any member), filtros opcionais `?status=` e `?contact_id=` (uuid).
 * POST /api/v1/ai/followups/enrollments — enrollment (`agent`+ COM posse, #3746);
 *   lógica em `lib/followup/enroll.ts`.
 *
 * ─── O POST era `manager`+ e o botão ficava no painel da conversa (#3746) ───
 *
 * O lugar de decidir "inscrever este cliente no fluxo" é a conversa, e é o
 * Atendente quem está nela. O piso caiu para `agent` e veio com ESCOPO DE
 * POSSE, a mesma régua do PATCH da carteira (`lib/carteira/posse.ts`): o
 * Atendente inscreve o cliente cuja conversa está atribuída a ele ou que já
 * está na carteira dele. Fora disso, 403 `fora_da_posse`. `manager`+ segue
 * podendo tudo.
 *
 * O GET, com `?contact_id=`, também devolve `meta.pode_inscrever` — a resposta
 * da MESMA régua. É o que a seção de follow-up do painel lê para oferecer (ou
 * não) o botão: a tela não decide por papel, e não promete o que a rota recusa.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { conferirPosse, respostaDaPosse } from "@/lib/carteira/posse";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { createFollowupEnrollmentSchema } from "@/lib/followup/api-schemas";
import { ENROLLMENT_LIST_COLUMNS, enrollFollowupFlow } from "@/lib/followup/enroll";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const ENROLLMENT_STATUSES = [
  "active",
  "waiting_reply",
  "paused_handoff",
  "paused_manual",
  "coletando",
  "completed",
  "cancelled",
  "dead",
];

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const status = req.nextUrl.searchParams.get("status");
  if (status !== null && !ENROLLMENT_STATUSES.includes(status)) {
    return fail("invalid_request", t("status inválido."), 400, { requestId });
  }
  // O recorte por contato é do servidor: a porta de follow-up do painel da
  // conversa (#3178) lê só o contato aberto, em vez de baixar a org inteira e
  // esbarrar no `max_rows` do PostgREST.
  const contactId = req.nextUrl.searchParams.get("contact_id");
  if (contactId !== null && !z.string().uuid().safeParse(contactId).success) {
    return fail("invalid_request", t("contact_id inválido."), 400, { requestId });
  }

  const supabase = await createClient();
  let query = supabase
    .from("followup_enrollments")
    .select(ENROLLMENT_LIST_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("updated_at", { ascending: false });
  if (status !== null) query = query.eq("status", status);
  if (contactId !== null) query = query.eq("contact_id", contactId);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  // #3746 — a capacidade que a TELA lê, respondida pelo servidor com a régua do
  // POST. Só é calculada quando a tela pediu um contato: a fila de follow-ups
  // (org inteira) não pergunta "posso inscrever este aqui?".
  let meta: { pode_inscrever: boolean } | undefined;
  if (contactId) {
    try {
      meta = {
        pode_inscrever: (
          await conferirPosse({
            db: createAdminClient(),
            organizationId: activeOrg.orgId,
            atorId: authz.user.id,
            papel: activeOrg.role,
            contactId,
          })
        ).pode,
      };
    } catch {
      // Sem a leitura da régua a tela esconde o botão; o POST continua sendo a
      // guarda de verdade. Lista sem o `meta` é melhor que lista nenhuma.
      meta = undefined;
    }
  }

  return ok(data ?? [], { requestId, meta });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Piso de papel: `agent`+. Quem pode inscrever ESTE contato é a régua de
  // posse abaixo — o papel sozinho não separa "meu cliente" de "cliente do
  // colega" (#3746).
  const authz = await requireRole("agent", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = createFollowupEnrollmentSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // #3746 — A POSSE, no servidor. A conversa do payload é o escopo: o Atendente
  // inscreve o cliente que ele atende (a conversa está com ele) ou que já está
  // na carteira dele. Sem `conversation_id` — a fila de follow-ups, que inscreve
  // fora de uma conversa — vale qualquer conversa do contato atribuída a ele.
  const admin = createAdminClient();
  const posse = await conferirPosse({
    db: admin,
    organizationId: activeOrg.orgId,
    atorId: user.id,
    papel: activeOrg.role,
    contactId: parsed.data.contact_id,
    conversaId: parsed.data.conversation_id ?? null,
  });
  if (!posse.pode) return respostaDaPosse(posse, { traduzir: t, requestId });

  const result = await enrollFollowupFlow(admin, {
    organizationId: activeOrg.orgId,
    pointerId: parsed.data.pointer_id,
    contactId: parsed.data.contact_id,
    agentId: parsed.data.agent_id,
    actorUserId: user.id,
    requestId,
  });

  if (!result.ok) {
    return fail(result.code, result.message, result.status, { requestId });
  }
  return ok(result.enrollment, { requestId, status: 201 });
}
