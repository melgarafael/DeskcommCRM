import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/contacts/[id]/proposals/[proposal_id]
 *
 * O humano decide sobre o dado que a IA ouviu: `accept` grava no cadastro,
 * `dismiss` recusa. **Os DOIS são auditados** — recusa é sinal, não ausência
 * dele. "Vi e decidi não gravar" é o que diz onde a IA erra (invariante 7 do
 * sistema vivo), e sem registro isso fica idêntico a "ninguém olhou".
 *
 * ⚠️ A TRAVA É O `eq("status","pending")` DENTRO DO UPDATE.
 *
 * Entre a tela renderizar e alguém clicar, a proposta pode ter vencido, sido
 * decidida por um colega, ou apagada porque o contato foi anonimizado. Ler e
 * depois escrever deixaria a janela aberta; o UPDATE condicional fecha a corrida
 * no banco, e quem perde recebe 409 com a razão — em vez de aplicar, em nome de
 * quem clicou, uma decisão que o sistema já tinha encerrado.
 *
 * ⚠️ A GRAVAÇÃO PASSA PELO HANDLER DE CONTATOS, não por um UPDATE direto.
 *
 * `patchContactHandler` já barra contato anonimizado com 403
 * (`lgpd_anonymization_irreversible`), já faz o merge de consentimento por
 * finalidade e já emite o audit com `old_`/`new_`. Escrever direto aqui
 * duplicaria as três regras — e a cópia é que fica para trás.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { patchContactHandler } from "@/app/api/v1/contacts/_handler";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string; proposal_id: string }>;
}

const Body = z.object({
  decision: z.enum(["accept", "dismiss"]),
  /** Por que recusou. É o laço de retorno — sem ele, o sinal é só um número. */
  motivo: z.string().max(300).optional(),
});

interface PropostaDecidida {
  id: string;
  campo: string;
  valor_proposto: string;
  valor_anterior: string | null;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: contactId, proposal_id } = await ctx.params;

  // `agent`: paridade com o PATCH do próprio contato. Confirmar um dado é
  // editar a ficha, e editar ficha é trabalho de quem atende.
  const guard = await requireRole("agent", { requestId });
  if (!guard.ok) return guard.response;
  const t = (texto: string) => traduzir(texto, guard.user.idioma);
  const orgId = guard.org.orgId;
  const userId = guard.user.id;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("decision é obrigatório (accept | dismiss)."), 400, { requestId });
  }
  const { decision, motivo } = parsed.data;

  const supabase = await createClient();

  const { data: decidida, error } = await supabase
    .from("contact_field_proposals")
    .update({
      status: decision === "accept" ? "accepted" : "dismissed",
      decided_at: new Date().toISOString(),
      decided_by_user_id: userId,
      motivo_recusa: decision === "dismiss" ? (motivo ?? null) : null,
    })
    .eq("id", proposal_id)
    .eq("contact_id", contactId)
    .eq("organization_id", orgId)
    .eq("status", "pending")
    .select("id, campo, valor_proposto, valor_anterior")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });

  if (!decidida) {
    // Distinguir "já decidida" de "não existe" AJUDA e não expõe nada: sem
    // isso a pessoa clica de novo achando que falhou.
    const { data: existe } = await supabase
      .from("contact_field_proposals")
      .select("status")
      .eq("id", proposal_id)
      .eq("contact_id", contactId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (existe) {
      const st = (existe as { status: string }).status;
      return fail(
        "proposal_not_pending",
        st === "expired" ? t("Esta sugestão venceu pelo prazo.") : t("Esta sugestão já foi decidida."),
        409,
        { requestId },
      );
    }
    return fail("not_found", t("Sugestão não encontrada."), 404, { requestId });
  }

  const p = decidida as PropostaDecidida;

  if (decision === "dismiss") {
    await audit({
      action: "contact.field_rejected",
      actorUserId: userId,
      organizationId: orgId,
      resourceType: "contact",
      resourceId: contactId,
      requestId,
      metadata: {
        proposal_id: p.id,
        campo: p.campo,
        // O valor recusado entra no audit porque é o que permite entender o
        // padrão de erro da IA depois — e ele já estava no banco de qualquer
        // forma, na linha da proposta.
        valor_recusado: p.valor_proposto,
        motivo: motivo ?? null,
      },
    });
    return ok({ decision: "dismissed", campo: p.campo }, { requestId });
  }

  // ---- accept: agora sim escreve, e pelo caminho que já tem as regras ----
  try {
    await patchContactHandler(
      supabase,
      { organization_id: orgId, actor: { type: "user", id: userId }, requestId },
      contactId,
      {
        [p.campo]: p.valor_proposto,
        // A BASE LEGAL, gravada no mesmo ato (spec 17 §4b).
        //
        // Escopo `transactional` por L-05, cuja exceção já cobre comunicação
        // transacional originada pelo próprio cliente: um dado que a pessoa
        // digitou espontaneamente num atendimento que ELA iniciou é esse caso.
        //
        // O formato é o que `lib/lgpd/export-collector.ts` já LÊ — o leitor
        // existia e o escritor nunca tinha sido escrito.
        consent: {
          transactional: {
            granted: true,
            granted_at: new Date().toISOString(),
            source: `informado pelo titular em atendimento; confirmado por usuário ${userId}`,
          },
        },
      } as never,
    );
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      // 403 de contato anonimizado chega aqui. A proposta já foi marcada
      // `accepted` pelo UPDATE acima — e fica assim de propósito: houve uma
      // decisão humana, e ela é fato mesmo que a escrita tenha sido barrada.
      // Reverter para `pending` reapresentaria o botão e convidaria ao mesmo
      // clique, sem que nada tivesse mudado.
      return fail(err.code, err.message ?? t("Não foi possível gravar."), err.status, { requestId });
    }
    return fail("internal_error", t("Não foi possível gravar o dado."), 500, { requestId });
  }

  await audit({
    action: "contact.field_confirmed",
    actorUserId: userId,
    organizationId: orgId,
    resourceType: "contact",
    resourceId: contactId,
    requestId,
    metadata: {
      proposal_id: p.id,
      campo: p.campo,
      // O par que a L-06 exige, tirado da PROPOSTA: `valor_anterior` foi
      // capturado quando ela nasceu, então existe mesmo que o campo tenha
      // mudado no meio do caminho.
      old_value: p.valor_anterior,
      new_value: p.valor_proposto,
      legal_basis: "L-05 transactional (dado informado pelo titular em atendimento iniciado por ele)",
    },
  });

  return ok({ decision: "accepted", campo: p.campo }, { requestId });
}
