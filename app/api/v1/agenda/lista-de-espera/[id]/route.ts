/**
 * LISTA DE ESPERA — a resposta da pessoa à oferta, registrada pela equipe.
 *
 * `aceitar` confirma pela porta de alteração da agenda, com a sessão: é ela que
 * recusa compromisso que já caiu e que cobra a aprovação humana do serviço que a
 * exige. `recusar` passa a vaga ao próximo. `sair` tira a pessoa da fila.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { alterarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import { aceitarEncaixe, recusarEncaixe } from "@/lib/agenda/encaixe";
import { portaSupabase } from "@/lib/agenda/encaixe-supabase";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({ acao: z.enum(["aceitar", "recusar", "sair"]) });

const FRASE_DA_RECUSA: Record<string, string> = {
  sem_oferta: "Esta pessoa não tem oferta em aberto.",
  oferta_vencida: "O prazo da oferta já venceu.",
  contato_indisponivel: "Este contato pediu para sair ou foi anonimizado.",
  vaga_perdida: "Esta vaga não está mais disponível.",
};

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "calendar_waitlist" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "lista_de_espera"))) return fail("not_found", "Not found.", 404, { requestId });

  const { id } = await context.params;
  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !corpo.success) {
    return fail("validation_failed", "Pedido inválido.", 422, { requestId });
  }

  const organizationId = authz.org.orgId;
  const porta = portaSupabase(admin);
  const entrada = { organizationId, esperaId: id, agora: new Date() };
  const { acao } = corpo.data;

  try {
    if (acao === "aceitar") {
      const supabase = await createClient();
      const resultado = await aceitarEncaixe(porta, entrada, async (compromissoId) => {
        try {
          await alterarAgendamentoHandler(
            supabase,
            { organization_id: organizationId, actor: { type: "user", id: authz.user.id, role: authz.org.role }, requestId },
            { id: compromissoId, status: "confirmed" },
          );
          return true;
        } catch (erro) {
          // Compromisso cancelado ou alterado na corrida: a vaga foi perdida.
          if (erro instanceof ApiError && (erro.status === 409 || erro.status === 422)) return false;
          throw erro;
        }
      });
      if (!resultado.aceito) {
        return fail("conflict", FRASE_DA_RECUSA[resultado.motivo] ?? "Oferta indisponível.", 409, { requestId });
      }
    } else if (acao === "recusar") {
      await recusarEncaixe(porta, { ...entrada, definitivo: false });
    } else {
      await recusarEncaixe(porta, { ...entrada, definitivo: true });
    }
  } catch (erro) {
    if (erro instanceof ApiError) return fail(erro.code, erro.message, erro.status, { requestId });
    throw erro;
  }

  void audit({
    action: "agenda.lista_de_espera_respondida",
    organizationId,
    actorUserId: authz.user.id,
    requestId,
    resourceType: "calendar_waitlist",
    resourceId: id,
    metadata: { acao },
  });
  return ok({ id, acao }, { requestId });
}
