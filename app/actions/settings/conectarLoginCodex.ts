"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

import { desconectarLoginCodex, guardarLoginCodex, lerLoginCodex } from "@/lib/ai/credenciais/login-codex";
import { lerOuCriarHostIdSiwc } from "@/lib/ai/credenciais/host-siwc";
import {
  CLIENTE_DINAMICO_SIWC,
  ENDPOINT_DE_JWKS,
  lerRetornoColado,
  trocarCodigoPorTokens,
} from "@/lib/ai/pontos/pkce-da-assinatura";
import { verificarEstado } from "@/lib/agenda/google/estado";
import { audit } from "@/lib/audit";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Validar a autorização SIWC colada e guardar a conta ChatGPT da empresa.
 *
 * ─── O portão é o da EMPRESA, não o da instalação (#1672, item 6) ──────────
 *
 * A decisão do mantenedor foi "uma conta ChatGPT por empresa": quem conecta é
 * o `admin` da empresa, em Credenciais, e a empresa vem da SESSÃO
 * (`resolveActiveOrg`), nunca do corpo do pedido. O portão antigo,
 * `escritaDeAdminOuRecusa()` (admin da PLATAFORMA), saiu.
 *
 * Não há atalho para admin da plataforma: o revendedor que quer conectar a
 * conta dele numa empresa entra pelo modo suporte `full`, que já resolve como
 * `role: "admin"` da empresa em `orgAtivaSemPortao` — e é por ali que
 * `resolveActiveOrg` passa. O mesmo portão de qualquer outra escrita da empresa.
 *
 * Com o interruptor da instalação (`login_codex`) desligado, a gravação
 * recusa: `guardarLoginCodex` consulta `moduloLigado` e falha fechado.
 *
 * ─── O `state` é conferido ANTES da troca ─────────────────────────────────
 *
 * `codigo` é o endereço inteiro que o navegador mostrou, com `code`, `state` e
 * o client_id emitido quando esta é a primeira autorização SIWC.
 * O `state` foi emitido pela tela (`emitirEstado`, HMAC com `INTERNAL_SECRET`,
 * prazo de 10 min) e carrega a empresa e a pessoa: só o retorno do link que
 * ESTA pessoa abriu, NESTA empresa, chega à OpenAI. Sem isso, um admin induzido
 * a colar o retorno de login de outra conta ligaria à empresa uma conta ChatGPT
 * alheia. A comparação da assinatura é em tempo constante (`verificarEstado`).
 */
const entradaSchema = z.object({
  codigo: z.string().min(1).max(4096),
  codeVerifier: z.string().min(43).max(128),
});

export type ConectarLoginCodexResult = { ok: true } | { ok: false; error: string };

export async function conectarLoginCodex(
  input: z.infer<typeof entradaSchema>,
): Promise<ConectarLoginCodexResult> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) return { ok: false, error: "forbidden_role" };
  // Suporte em leitura (ou já encerrado) não grava nem apaga a conta da empresa.
  if (supportWriteError(authUser.support)) return { ok: false, error: "somente_leitura" };

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };

  const retorno = lerRetornoColado(parsed.data.codigo);
  if (!retorno) return { ok: false, error: "retorno_sem_estado" };
  if (retorno.error === "access_denied") return { ok: false, error: "consentimento_recusado" };
  if (!retorno.code) return { ok: false, error: "retorno_sem_estado" };
  let estado: ReturnType<typeof verificarEstado> = null;
  try {
    estado = verificarEstado(retorno.state, { segredo: env.INTERNAL_SECRET, agora: new Date() });
  } catch {
    // Segredo ausente/curto: sem ele nenhum retorno é conferível — recusa.
    estado = null;
  }
  if (!estado || estado.organizationId !== activeOrg.orgId || estado.userId !== authUser.id) {
    return { ok: false, error: "estado_invalido" };
  }

  const clientIdEsperado = estado.authSessionId;
  if (!clientIdEsperado) return { ok: false, error: "estado_invalido" };
  const clientId = clientIdEsperado === CLIENTE_DINAMICO_SIWC ? retorno.clientId : clientIdEsperado;
  if (!clientId || (retorno.clientId && retorno.clientId !== clientId)) {
    return { ok: false, error: "registro_incompleto" };
  }
  const admin = createAdminClient();
  const extAgentHostId = await lerOuCriarHostIdSiwc(admin);
  if (!extAgentHostId) return { ok: false, error: "host_siwc" };

  // O retorno vale UMA vez: o nonce do `state` é queimado ANTES da troca, na
  // mesma tabela e pela mesma razão do callback do Google Agenda
  // (`app/api/v1/agenda/google/callback/route.ts`). O nonce tem 128 bits
  // sorteados, então dividir a tabela com o Google não colide, e a poda do
  // `data-retention` já a alcança. Unicidade (`23505`) = repetido; qualquer
  // outro erro também recusa, porque sem gravar não há uso único a garantir.
  const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
    nonce: estado.nonce,
    organization_id: activeOrg.orgId,
    user_id: authUser.id,
    expira_em: new Date(estado.expiraEmMs).toISOString(),
  });
  if (erroDoNonce) return { ok: false, error: erroDoNonce.code === "23505" ? "estado_invalido" : "banco" };

  let tokens: Awaited<ReturnType<typeof trocarCodigoPorTokens>>;
  try {
    tokens = await trocarCodigoPorTokens({
      code: retorno.code,
      codeVerifier: parsed.data.codeVerifier,
      clientId,
    });
  } catch {
    // Sem detalhe na resposta: o corpo do provedor pode carregar material da
    // credencial, e a tela só precisa saber que a troca não deu.
    return { ok: false, error: "troca_recusada" };
  }

  if (!tokens.id_token || !tokens.scopes?.includes("chatgpt.tokens.use.direct")) {
    return { ok: false, error: "plano_nao_autorizado" };
  }
  if (!tokens.scopes.includes("resource.invoke")) {
    return { ok: false, error: "plano_nao_autorizado" };
  }

  let identidade: { subject: string; email?: string };
  try {
    const jwks = createRemoteJWKSet(new URL(ENDPOINT_DE_JWKS));
    const verificado = await jwtVerify(tokens.id_token, jwks, {
      issuer: "https://auth.openai.com",
      audience: clientId,
    });
    const nonce = verificado.payload.nonce;
    const subject = verificado.payload.sub;
    const email = verificado.payload.email;
    if (nonce !== estado.nonce || typeof subject !== "string" || subject.length === 0) {
      return { ok: false, error: "identidade_invalida" };
    }
    identidade = {
      subject,
      ...(typeof email === "string" ? { email } : {}),
    };
  } catch {
    return { ok: false, error: "identidade_invalida" };
  }

  const credencialAnterior = await lerLoginCodex({ admin, orgId: activeOrg.orgId });
  if (credencialAnterior?.subject && credencialAnterior.subject !== identidade.subject) {
    return { ok: false, error: "conta_diferente" };
  }
  tokens = {
    ...tokens,
    client_id: clientId,
    subject: identidade.subject,
    ...(identidade.email ? { email: identidade.email } : {}),
    ext_agent_host_id: extAgentHostId,
    token_type: tokens.token_type ?? "Bearer",
  };

  const gravado = await guardarLoginCodex({
    admin,
    orgId: activeOrg.orgId,
    userId: authUser.id,
    tokens,
  });
  if (!gravado.ok) return { ok: false, error: gravado.motivo };

  const hdrs = await headers();
  await audit({
    action: "ai.login_codex_conectado",
    actorUserId: authUser.id,
    // A EMPRESA passa a levar o rastro (#1672, item 6): são várias contas em
    // várias empresas, e "quem conectou, em qual empresa, quando" é a pergunta.
    organizationId: activeOrg.orgId,
    resourceType: "ai_provider_credential",
    resourceId: gravado.id,
    metadata: { provedor: "openai-assinatura" },
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });

  revalidatePath("/app/ai/credentials");
  return { ok: true };
}

export type DesconectarLoginCodexResult = { ok: true } | { ok: false; error: string };

/** DESCONECTAR a conta da empresa — apaga a linha dela. */
export async function desconectarLoginCodexAgora(): Promise<DesconectarLoginCodexResult> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) return { ok: false, error: "forbidden_role" };
  // Suporte em leitura (ou já encerrado) não grava nem apaga a conta da empresa.
  if (supportWriteError(authUser.support)) return { ok: false, error: "somente_leitura" };

  const admin = createAdminClient();
  const { data: linha } = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "openai-assinatura")
    .eq("is_active", true)
    .maybeSingle();

  const apagou = await desconectarLoginCodex({ admin, orgId: activeOrg.orgId });
  if (!apagou) return { ok: false, error: "banco" };

  if (linha?.id) {
    const hdrs = await headers();
    await audit({
      action: "ai.login_codex_desconectado",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "ai_provider_credential",
      resourceId: linha.id,
      metadata: { provedor: "openai-assinatura" },
      requestId: hdrs.get("x-request-id"),
      ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: hdrs.get("user-agent"),
    });
  }

  revalidatePath("/app/ai/credentials");
  return { ok: true };
}
