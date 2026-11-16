"use server";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";
import { verificarDominioNaResend } from "@/lib/email/resend-da-organizacao";
import {
  contaResendDaOrganizacaoSchema,
  type ContaResendDaOrganizacaoInput,
} from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

export type ConectarContaResendResult =
  | { ok: true }
  | FalhaDaContaResend;

/** O resultado FRACASSADO de qualquer uma das duas actions — vocabulário único. */
type FalhaDaContaResend = {
  ok: false;
  error:
    | "validation_failed"
    | "unauthenticated"
    | "forbidden_tenant"
    | "forbidden_role"
    | "mfa_required"
    /** A Resend recusou a chave (ou a chamada falhou) — não é culpa do domínio. */
    | "chave_recusada"
    | "permissao_insuficiente"
    | "consulta_indisponivel"
    | "envio_desabilitado"
    /** O domínio do endereço não está VERIFICADO na conta (critério E). */
    | "dominio_nao_verificado"
    | "sem_endereco"
    /** A instalação não tem a chave de cifragem — a conta não pode ser gravada. */
    | "cifra_indisponivel"
    | "nao_gravou"
    | "db_error";
  details?: unknown;
};

type Autorizado =
  | { ok: true; orgId: string; userId: string; requestId: string | null; ip: string | null; userAgent: string | null }
  | { ok: false; falha: FalhaDaContaResend };

/** As MESMAS réguas de porta que `updateMarcaDaOrganizacao` — não duplico a prosa aqui. */
async function autorizar(): Promise<Autorizado> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, falha: { ok: false, error: "unauthenticated" } };
  if (supportWriteError(authUser.support)) return { ok: false, falha: { ok: false, error: "forbidden_role" } };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, falha: { ok: false, error: "forbidden_tenant" } };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) {
    return { ok: false, falha: { ok: false, error: "forbidden_role" } };
  }
  // DEPOIS do papel: quem nem tem o papel recebe `forbidden_role`; quem tem, é
  // cobrado pelo segundo fator — mesma ordem da action da marca.
  if (await mfaEmDivida()) return { ok: false, falha: { ok: false, error: "mfa_required" } };
  const hdrs = await headers();
  return {
    ok: true,
    orgId: activeOrg.orgId,
    userId: authUser.id,
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent") ?? null,
  };
}

/**
 * Conecta a CONTA Resend da organização (#3287, fatia da conta própria).
 *
 * A chave CRUA que a pessoa colou é (1) conferida contra a API de DOMÍNIOS da
 * Resend — o domínio do endereço de remetente tem de estar VERIFICADO na conta,
 * senão a recusa é mensagem própria (`dominio_nao_verificado`), nunca o erro cru
 * da API (critério (E)); e (2) CIFRADA (AES-256-GCM) antes de gravar, na própria
 * linha da organização. A chave em claro NUNCA é logada nem devolvida — a tela
 * só recebe os 4 últimos (`estadoDaContaResend`).
 */
export async function conectarContaResendDaOrganizacao(
  input: ContaResendDaOrganizacaoInput,
): Promise<ConectarContaResendResult> {
  const parsed = contaResendDaOrganizacaoSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }
  const autor = await autorizar();
  if (!autor.ok) return autor.falha;

  const { api_key, from_email } = parsed.data;

  // O DOMÍNIO tem de estar VERIFICADO na conta (critério E). Recusar aqui, com
  // a mensagem própria, é o que evita "conectar" uma conta que falharia em todo
  // envio no meio de uma automação para um cliente real.
  const verificacao = await verificarDominioNaResend(api_key, from_email);
  if (!verificacao.ok) {
    if (verificacao.motivo === "dominio_nao_verificado") {
      return { ok: false, error: "dominio_nao_verificado", details: verificacao.dominio };
    }
    return { ok: false, error: verificacao.motivo };
  }

  // A CIFRA, antes de gravar. Falha fechada: sem a chave de cifragem da
  // instalação a conta não pode ser gravada em segurança, e gravar em claro
  // estaria pior que não gravar.
  let envelope: ReturnType<typeof encryptKey>;
  try {
    envelope = encryptKey(api_key);
  } catch (err) {
    logger.warn("conta Resend: cifra indisponível; nada foi gravado", {
      detalhe: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "cifra_indisponivel" };
  }

  // `upsert` na PK: reconectar troca a chave/ endereço sem deixar duas linhas.
  const { data, error } = await createAdminClient()
    .from("organization_resend_accounts")
    .upsert(
      {
        organization_id: autor.orgId,
        api_key_ciphertext: bufToBytea(envelope.ciphertext),
        api_key_iv: bufToBytea(envelope.iv),
        api_key_tag: bufToBytea(envelope.tag),
        api_key_last4: envelope.last4,
        from_email,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" },
    )
    .select("organization_id");

  if (error) return { ok: false, error: "db_error" };
  // A CATRACA da issue #144: `data` vazio é escrita que não casou — a tela não
  // pode dizer "conectada" com nada gravado.
  if (!data || data.length !== 1) return { ok: false, error: "nao_gravou" };

  await audit({
    // FORMA, nunca IDENTIDADE: nem a chave (obviamente) nem o endereço entram na
    // trilha — só o fato de a organização ter conectado uma conta Resend.
    action: "org.resend_account_connected",
    actorUserId: autor.userId,
    organizationId: autor.orgId,
    resourceType: "organization",
    resourceId: autor.orgId,
    requestId: autor.requestId,
    ip: autor.ip,
    userAgent: autor.userAgent,
    metadata: {
      fields_changed: ["api_key", "from_email"],
      dominio_verificado: true,
    },
  });

  revalidatePath("/app/settings/marca");
  return { ok: true };
}

/**
 * Desconecta a conta Resend da organização: apaga a linha. O envio volta a sair
 * pelo roteador da plataforma no mesmo instante (é a própria invariância
 * "sem conta = como hoje"). Quem grava é o admin client — a RLS da tabela não
 * tem policy de sessão, de propósito (a chave é segredo).
 */
export async function desconectarContaResendDaOrganizacao(): Promise<
  ConectarContaResendResult
> {
  const autor = await autorizar();
  if (!autor.ok) return autor.falha;

  const { error } = await createAdminClient()
    .from("organization_resend_accounts")
    .delete()
    .eq("organization_id", autor.orgId);
  if (error) return { ok: false, error: "db_error" };

  await audit({
    action: "org.resend_account_disconnected",
    actorUserId: autor.userId,
    organizationId: autor.orgId,
    resourceType: "organization",
    resourceId: autor.orgId,
    requestId: autor.requestId,
    ip: autor.ip,
    userAgent: autor.userAgent,
    metadata: { fields_changed: ["api_key", "from_email"] },
  });

  revalidatePath("/app/settings/marca");
  return { ok: true };
}
