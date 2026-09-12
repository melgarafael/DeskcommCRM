import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * REATIVAR UM TIPO DE AGENDAMENTO — o outro lado do `DELETE` da rota irmã.
 *
 * ─── O defeito que esta rota fecha ────────────────────────────────────────
 *
 * A tela de Configurações › Agenda sempre teve o botão "Reativar", e ele
 * **nunca funcionou**. Ele mandava `PATCH /api/v1/agenda/tipos` com
 * `{ id, is_active: true }`, e o `alterarSchema` daquela rota é
 * `criarSchema.partial()` — `is_active` não está entre os doze campos de
 * `camposDoTipo`. Zod descarta chave desconhecida **em silêncio**, então o
 * corpo chegava vazio ao `update` e a rota respondia 422 "Nenhum campo para
 * alterar." — uma recusa que não nomeia o que aconteceu, numa tela em que o
 * usuário só vê "não deu".
 *
 * Quem escondeu o defeito do compilador foi um `as never` na chamada (o único
 * do arquivo da tela). Ele saiu junto com este conserto.
 *
 * ─── Por que uma ROTA, e não `is_active` no schema do PATCH ───────────────
 *
 * O caminho curto seria acrescentar `is_active` a `camposDoTipo`. Ele custa uma
 * linha e cobra duas coisas:
 *
 * 1. O MESMO pedido que muda duração passaria a poder **desligar** um tipo. E
 *    desligar já tem porta própria (o `DELETE`), com a guarda e a decisão de
 *    "desativar, nunca apagar" escritas lá.
 * 2. A trilha perderia a distinção. Reativar cairia em `api_audit_log` como
 *    `agenda.tipo_alterado { campos: ["is_active"] }` — indistinguível, para
 *    quem audita depois, de "mudaram a duração". Ligar de volta um tipo que
 *    alguém desligou é ato de gestão e merece verbo próprio na trilha:
 *    `agenda.tipo_reativado`.
 *
 * Sub-rota de ação é a forma que esta casa já usa para o ato que não é um campo
 * — `agenda/google/desconectar`, `contacts/merge`, `lgpd/anonymize`.
 *
 * ─── Simetria com o `DELETE` ──────────────────────────────────────────────
 *
 * Mesmo papel (`manager`), mesma guarda de suporte, mesmo filtro explícito de
 * `organization_id` no client de service role, mesmo 404 quando não há linha.
 * Dizer "reativei" sobre o que não existe é a mesma família de mentira que o
 * `DELETE` recusa do outro lado.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const corpo = z.object({ id: z.string().uuid() });

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? undefined;
  const autorizado = await requireRole("manager", { requestId, resource: "calendar_event_types" });
  if (!autorizado.ok) return autorizado.response;
  const t = (texto: string) => traduzir(texto, autorizado.user.idioma);

  const lido = corpo.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return fail("validation_failed", t("corpo inválido"), 422, { requestId });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("calendar_event_types")
    .update({ is_active: true })
    .eq("id", lido.data.id)
    // O tenant vem da SESSÃO, nunca do corpo — o corpo carrega só o `id` do
    // tipo, e sem este filtro a service role reativaria tipo de outra casa.
    .eq("organization_id", autorizado.org.orgId)
    .select("id")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", t("Tipo de agendamento não encontrado."), 404, { requestId });

  await audit({
    actorUserId: autorizado.user.id,
    action: "agenda.tipo_reativado",
    organizationId: autorizado.org.orgId,
    resourceType: "calendar_event_types",
    resourceId: lido.data.id,
    metadata: {},
  });
  return ok(data, { requestId });
}
