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
 * As três guardas que a decisão do dono exigiu para a troca (recorte do #1967):
 *
 *  (a) A EMPRESA FICA SABENDO. Um aviso `email_de_login_trocado` na Central de
 *      CADA organização em que a pessoa tem acesso ATIVO — o login é um só na
 *      instalação, então toda empresa que ele abre precisa saber, não só a que
 *      o admin escolheu na URL. Com o nome da pessoa e a data — NUNCA um
 *      endereço (a Central é lida por toda a empresa). O tenant do path também
 *      precisa ser um desses: vínculo revogado é 404, para que a empresa avisada
 *      não seja uma em que a pessoa já não está. Gravados ANTES do GoTrue: se
 *      os avisos não gravam, nada é trocado (falha fechada na ação); se o
 *      GoTrue recusar depois, os avisos recém-criados são desfeitos.
 *  (b) O ENDEREÇO ANTIGO FICA SABENDO. Depois da troca, um e-mail à caixa
 *      anterior, com a marca da instalação (`marcaDaSaida`) e sem o endereço
 *      novo. Falha ABERTA: sem envio configurado (o estado de um primeiro
 *      deploy) a troca segue, e o registro diz que o aviso não saiu.
 *  (c) QUEM TEM FATOR PROVA. `requirePlatformAdminEscrita()` → `mfaEmDivida()`:
 *      o admin com TOTP cadastrado precisa da sessão `aal2`; sem fator, a
 *      política de MFA é opcional e a troca segue.
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
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { marcaDaSaida } from "@/lib/branding/saida";
import { sendEmail } from "@/lib/email/roteador";
import { buildAvisoDeTrocaDeEmail } from "@/lib/email/templates/aviso-de-troca-de-email";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email("E-mail inválido").max(254),
});

type AvisoAoEnderecoAntigo = "enviado" | "sem_envio_configurado" | "sem_endereco_anterior" | "falhou";

/** O nome que vai para a Central. Nunca um endereço — nem quando o nome é um. */
function nomeParaOAviso(metadata: Record<string, unknown> | undefined): string {
  const nome = typeof metadata?.full_name === "string" ? metadata.full_name.trim() : "";
  return nome && !nome.includes("@") ? nome : "uma pessoa da equipe";
}

function dataNoFuso(idioma: string, fuso: string | null | undefined): string {
  const timeZone = fuso && fusoValido(fuso) ? fuso : FUSO_PADRAO;
  return new Intl.DateTimeFormat(idioma, { dateStyle: "short", timeZone }).format(new Date());
}

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

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  let email: string;
  try {
    email = bodySchema.parse(await req.json()).email;
  } catch {
    return fail("validation_failed", "Informe um e-mail válido.", 400, { requestId });
  }

  const admin = createAdminClient();

  // Todos os vínculos ATIVOS do login (o e-mail vale para todos eles). A
  // pessoa precisa ter acesso ativo a ESTE tenant: a rota é da gestão de
  // tenants, e o par do path é o que o admin escolheu na tela.
  const [lidoVinculos, lidoAdmin] = await Promise.all([
    admin
      .from("user_organizations")
      .select("organization_id")
      .eq("user_id", userId)
      .is("revoked_at", null),
    admin
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);
  // Falha FECHADA: sem saber se o alvo é admin da plataforma, a guarda contra
  // tomada de conta não decide — e um `null` de erro leria como "não é".
  const erroDeLeitura = lidoVinculos.error ?? lidoAdmin.error;
  if (erroDeLeitura) {
    logger.error("[admin.members.email] leitura das guardas falhou; e-mail NÃO trocado", {
      requestId,
      organization_id: id,
      erro: erroDeLeitura.message,
    });
    return fail("internal_error", "Não foi possível trocar o e-mail agora.", 500, { requestId });
  }
  const orgIds: string[] = (lidoVinculos.data ?? []).map((v: { organization_id: string }) => v.organization_id);
  const ehAdmin = lidoAdmin.data;
  if (!orgIds.includes(id)) {
    return fail("not_found", "Membro sem acesso ativo neste tenant.", 404, { requestId });
  }
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

  // O fuso de cada empresa a avisar (a data do aviso é a do relógio dela).
  const { data: fusos, error: fusosErr } = await admin
    .from("organizations")
    .select("id, timezone")
    .in("id", orgIds);
  if (fusosErr) {
    logger.error("[admin.members.email] leitura dos fusos falhou; e-mail NÃO trocado", {
      requestId,
      organization_id: id,
      erro: fusosErr.message,
    });
    return fail("internal_error", "Não foi possível trocar o e-mail agora.", 500, { requestId });
  }
  const fusoDe = new Map<string, string | null>(
    (fusos ?? []).map((o: { id: string; timezone: string | null }) => [o.id, o.timezone]),
  );
  const vinculos = orgIds.map((orgId) => ({ orgId, fuso: fusoDe.get(orgId) ?? null }));

  // (a) A Central ANTES do GoTrue: troca invisível para a empresa não acontece.
  const fusoDaOrg = fusoDe.get(id) ?? null;
  const nome = nomeParaOAviso(atual.user.user_metadata);
  const { data: itens, error: centralErr } = await admin
    .from("agent_inbox_items")
    .insert(
      vinculos.map((v) => ({
        organization_id: v.orgId,
        kind: "email_de_login_trocado",
        severity: "warn",
        title: "E-mail de login trocado pelo administrador da plataforma",
        body: `O e-mail de login de ${nome} foi trocado pelo administrador da plataforma em ${dataNoFuso("pt-BR", v.fuso)}.`,
      })),
    )
    .select("id");
  if (centralErr || !itens || itens.length !== vinculos.length) {
    logger.error("[admin.members.email] aviso na Central falhou; e-mail NÃO trocado", {
      requestId,
      organization_id: id,
      erro: centralErr?.message,
    });
    return fail("internal_error", "Não foi possível trocar o e-mail agora.", 500, { requestId });
  }
  const avisosNaCentral = (itens as Array<{ id: string }>).map((i) => i.id);

  const { error } = await admin.auth.admin.updateUserById(userId, {
    email,
    email_confirm: true,
  });
  if (error) {
    // Compensação: os avisos diziam que a troca aconteceu, e ela não aconteceu.
    const { error: desfazerErr } = await admin
      .from("agent_inbox_items")
      .delete()
      .in("id", avisosNaCentral);
    if (desfazerErr) {
      logger.warn("[admin.members.email] avisos na Central ficaram sem troca", {
        requestId,
        organization_id: id,
        erro: desfazerErr.message,
      });
    }
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

  // (b) O endereço antigo, depois da troca. Falha aberta: informar não pode
  // desfazer a ação que já aconteceu.
  let avisoAoAntigo: AvisoAoEnderecoAntigo = "sem_endereco_anterior";
  if (anterior) {
    try {
      const idioma = normalizarIdioma(
        typeof atual.user.user_metadata?.locale === "string" ? atual.user.user_metadata.locale : null,
      );
      const marca = await marcaDaSaida(id);
      const corpo = buildAvisoDeTrocaDeEmail({ marca, idioma, data: dataNoFuso(idioma, fusoDaOrg) });
      const envio = await sendEmail({ to: anterior, fromName: marca.nome, ...corpo });
      avisoAoAntigo = envio.ok ? "enviado" : envio.error === "not_configured" ? "sem_envio_configurado" : "falhou";
      if (!envio.ok) {
        logger.warn("[admin.members.email] aviso ao endereço antigo não saiu", {
          requestId,
          organization_id: id,
          erro: envio.error,
        });
      }
    } catch (err) {
      avisoAoAntigo = "falhou";
      logger.warn("[admin.members.email] aviso ao endereço antigo lançou", {
        requestId,
        organization_id: id,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Só hash: a auditoria não guarda e-mail em claro (dado pessoal).
  void audit({
    action: "member.email_changed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "user",
    resourceId: userId,
    requestId,
    metadata: {
      email_hash_anterior: anterior ? hashEmail(anterior) : null,
      email_hash_novo: hashEmail(email),
      avisos_na_central: avisosNaCentral,
      aviso_ao_endereco_antigo: avisoAoAntigo,
    },
  });

  return ok({ user_id: userId, email }, { requestId });
}
