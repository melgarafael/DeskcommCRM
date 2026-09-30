/**
 * PATCH /api/v1/admin/tenants/[id]/members/[userId]/email — o admin da
 * plataforma corrige o e-mail de LOGIN de um membro do tenant.
 *
 * O caso de uso é o cadastro com o endereço errado: a pessoa não recebe a
 * confirmação, não consegue recuperar a senha e ninguém mais consegue entrar em
 * contato. O e-mail NÃO é imutável — mas ele é o identificador de login, e por
 * isso a troca passa por todas as dependências:
 *
 *  - AUTENTICAÇÃO: o e-mail mora em `auth.users` (GoTrue). A troca é pela API
 *    admin com `email_confirm: true` — sem ela, o GoTrue exigiria confirmar no
 *    endereço NOVO, e numa instalação sem SMTP (o estado de um primeiro deploy)
 *    esse e-mail nunca sai: a troca ficaria pendente para sempre. Quem confirma
 *    aqui é o admin da plataforma, com MFA, e o ato fica auditado.
 *  - UNICIDADE: o GoTrue recusa e-mail já usado por outro login — em QUALQUER
 *    organização desta instalação —, e a recusa vira 409 com mensagem clara.
 *  - LOGIN / RECUPERAÇÃO DE SENHA / CÓDIGOS DE RECUPERAÇÃO: todos procuram a
 *    pessoa pelo e-mail em `auth.users` na hora (`useRecoveryCode`,
 *    `requestPasswordReset`), então passam a valer para o endereço novo sem
 *    nenhuma cópia a atualizar. Nenhuma tabela pública guarda o e-mail de login
 *    (conferido: a auditoria guarda só hash).
 *  - SESSÕES: continuam válidas. O e-mail não é credencial de sessão; a pessoa
 *    segue logada e usa o endereço novo no próximo login.
 *  - CONVITES pendentes para o endereço antigo continuam amarrados a ele — e é
 *    o certo: o convite é para quem controla aquela caixa.
 *
 * O que fica de fora, de propósito: trocar o e-mail de um ADMIN DA PLATAFORMA.
 * Um admin trocando o e-mail de outro seria o caminho para tomar a conta dele
 * (o endereço novo recebe a recuperação de senha). Isso se faz pelo próprio
 * dono da conta, não pela gestão de tenants.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit, hashEmail } from "@/lib/audit";
import { requirePlatformAdminWrite } from "@/lib/auth/requirePlatformAdminWrite";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email("E-mail inválido").max(254),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const requestId = randomUUID();
  const { id, userId } = await params;
  if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(userId).success) {
    return fail("not_found", "Membro não encontrado", 404, { requestId });
  }

  const supportDenied = await requireSupportWrite(id);
  if (supportDenied) return supportDenied;

  const guarda = await requirePlatformAdminWrite(requestId);
  if (!guarda.ok) return guarda.response;

  let email: string;
  try {
    email = bodySchema.parse(await req.json()).email;
  } catch {
    return fail("validation_failed", "Informe um e-mail válido.", 400, { requestId });
  }

  const admin = createAdminClient();

  // A pessoa precisa pertencer a ESTE tenant: a rota é da gestão de tenants, e
  // o par (organização, usuário) do path é o que o admin escolheu na tela.
  const [{ data: vinculo }, { data: ehAdmin }] = await Promise.all([
    admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", id)
      .eq("user_id", userId)
      .maybeSingle(),
    admin
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);
  if (!vinculo) return fail("not_found", "Membro não encontrado neste tenant.", 404, { requestId });
  if (ehAdmin) {
    return fail(
      "forbidden",
      "O e-mail de um administrador da plataforma não se troca por aqui: só o próprio dono da conta pode mudá-lo.",
      403,
      { requestId },
    );
  }

  const { data: atual, error: leituraErr } = await admin.auth.admin.getUserById(userId);
  if (leituraErr || !atual?.user) {
    return fail("not_found", "Login não encontrado.", 404, { requestId });
  }
  const anterior = (atual.user.email ?? "").toLowerCase();
  if (anterior === email) {
    return fail("state_conflict", "Este já é o e-mail desta pessoa.", 409, { requestId });
  }

  const { error } = await admin.auth.admin.updateUserById(userId, {
    email,
    email_confirm: true,
  });
  if (error) {
    // GoTrue: `email_exists` (422) quando outro login já usa o endereço.
    const code = (error as { code?: string }).code;
    if (
      code === "email_exists" ||
      /already (been )?registered|already exists/i.test(error.message)
    ) {
      return fail(
        "state_conflict",
        "Este e-mail já é usado por outro login nesta instalação.",
        409,
        {
          requestId,
        },
      );
    }
    if (code === "validation_failed" || code === "email_address_invalid") {
      return fail("validation_failed", "O provedor de autenticação recusou este e-mail.", 400, {
        requestId,
      });
    }
    return fail("internal_error", "Não foi possível trocar o e-mail agora.", 500, { requestId });
  }

  // Só hash: a auditoria não guarda e-mail em claro (dado pessoal).
  void audit({
    action: "member.email_changed",
    actorUserId: guarda.ctx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "user",
    resourceId: userId,
    requestId,
    metadata: {
      email_hash_anterior: anterior ? hashEmail(anterior) : null,
      email_hash_novo: hashEmail(email),
    },
  });

  return ok({ user_id: userId, email }, { requestId });
}
