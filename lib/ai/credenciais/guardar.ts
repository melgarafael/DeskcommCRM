/**
 * GUARDAR A CHAVE DE UM PROVEDOR DE IA — o miolo, sem HTTP.
 *
 * Extraído de `POST /api/v1/ai/credentials` porque agora há um SEGUNDO caminho
 * que precisa exatamente disto: o wizard. O passo de treinar detecta que a
 * instalação não tem chave nenhuma e oferece colar uma ali — antes ele apenas
 * informava "Falta a chave da inteligência artificial", que é um beco: a pessoa
 * lê o diagnóstico e não tem o que fazer com ele.
 *
 * O que mora aqui é o que os dois caminhos precisam fazer IGUAL, e cada item
 * desta lista tem consequência de segurança se divergir: cifrar AES-GCM (nunca
 * guardar plaintext), gravar só os últimos 4 dígitos em claro, registrar no
 * audit, e validar a chave em segundo plano sem segurar a resposta. Uma segunda
 * cópia disso na Server Action divergiria no primeiro ajuste — e o ajuste que
 * divergisse seria justamente o de segurança.
 *
 * O que NÃO mora aqui: autenticação, papel e formato do erro. São do chamador,
 * porque a rota responde JSON com `requestId` e a Server Action responde para
 * uma tela em português.
 */
import { audit } from "@/lib/audit";
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import type { ProvedorComChave } from "@/lib/ai/pontos/provedores";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import type { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoDeGuardar =
  | { ok: true; id: string; last4: string }
  | {
      ok: false;
      /**
       * `label_em_uso` é o único que o chamador precisa distinguir: é escolha do
       * usuário e tem conserto óbvio (mudar o nome). O resto é falha nossa.
       */
      motivo: "cifragem" | "label_em_uso" | "banco";
      detalhe?: string;
    };

export type ResultadoDeRotacionar =
  | { ok: true; id: string; last4: string | null; trocouChave: boolean }
  | {
      ok: false;
      /**
       * `nao_encontrada` cobre a corrida em que a credencial sumiu entre a
       * leitura da rota e o update. `label_em_uso` é escolha do usuário; o
       * resto é falha nossa — mesma divisão de `guardarCredencial`.
       */
      motivo: "cifragem" | "label_em_uso" | "nao_encontrada" | "banco";
      detalhe?: string;
    };

export interface PedidoDeGuardar {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  userId: string;
  provider: ProvedorComChave;
  label: string;
  /** Plaintext. Vive só no escopo desta chamada — nunca persistido nem logado. */
  apiKey: string;
  requestId?: string;
}

/**
 * As colunas cifradas de uma chave nova. Existe para o cadastro e a rotação
 * usarem a MESMA cifragem: uma segunda chamada a `encryptKey` com parâmetros
 * diferentes (ou, pior, um caminho que gravasse plaintext) divergiria em
 * silêncio, e o ajuste que divergisse seria o de segurança.
 */
function colunasCifradas(apiKey: string) {
  const encrypted = encryptKey(apiKey);
  return {
    api_key_encrypted: bufToBytea(encrypted.ciphertext),
    api_key_iv: bufToBytea(encrypted.iv),
    api_key_tag: bufToBytea(encrypted.tag),
    api_key_last4: encrypted.last4,
    last4: encrypted.last4,
  };
}

export async function guardarCredencial(p: PedidoDeGuardar): Promise<ResultadoDeGuardar> {
  let cifrada: ReturnType<typeof colunasCifradas>;
  try {
    cifrada = colunasCifradas(p.apiKey);
  } catch (err) {
    // Sem `console.error` com a chave por perto: o que interessa é que falhou.
    return { ok: false, motivo: "cifragem", detalhe: err instanceof Error ? err.message : undefined };
  }

  const { data: created, error } = await p.admin
    .from("ai_provider_credentials")
    .insert({
      organization_id: p.orgId,
      provider: p.provider,
      label: p.label,
      api_key_encrypted: cifrada.api_key_encrypted,
      api_key_iv: cifrada.api_key_iv,
      api_key_tag: cifrada.api_key_tag,
      api_key_last4: cifrada.api_key_last4,
      is_active: true,
      created_by: p.userId,
    })
    .select("id")
    .single();

  if (error || !created) {
    if (error?.code === "23505") return { ok: false, motivo: "label_em_uso" };
    return { ok: false, motivo: "banco", detalhe: error?.message };
  }

  const id = created.id as string;

  await audit({
    action: "ai.credential_created",
    actorUserId: p.userId,
    organizationId: p.orgId,
    resourceType: "ai_provider_credential",
    resourceId: id,
    ...(p.requestId ? { requestId: p.requestId } : {}),
    metadata: { provider: p.provider, label: p.label, last4: cifrada.last4 },
  });

  // Fire-and-forget: o plaintext vive até o callback resolver, e a resposta não
  // espera uma ida ao provedor. Guardar a chave e validá-la são coisas
  // diferentes — a segunda pode falhar por rede sem que a primeira precise ser
  // desfeita.
  void validarEmSegundoPlano(p.admin, id, p.orgId, p.provider, p.apiKey);

  return { ok: true, id, last4: cifrada.last4 };
}

/**
 * ROTACIONAR A CHAVE SEM TROCAR DE CREDENCIAL.
 *
 * É o caminho que faltava: a exclusão é bloqueada pela FK enquanto qualquer
 * versão de agente apontar para a credencial, e "excluir e recriar" era a única
 * saída oferecida — beco sem fundo no instante em que o agente está publicado.
 * Aqui a mesma credencial ganha chave nova (e/ou rótulo novo): o vínculo das
 * versões continua apontando para ela, e no próximo turno elas já usam a chave
 * nova.
 *
 * Sem `apiKey` NÃO se toca na chave: renomear não pode revalidar nada, porque
 * não há chave nova para o provedor testar. Sem `label` o nome fica; quem decide
 * o que mudou é o chamador, e o que faltar simplesmente não entra no patch.
 */
export interface PedidoDeRotacionar {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  userId: string;
  credentialId: string;
  provider: ProvedorComChave;
  /** Presente = trocar a chave. Ausente = manter a atual. Plaintext: nunca logado. */
  apiKey?: string;
  /** Presente = trocar o rótulo. Ausente = manter. */
  label?: string;
  requestId?: string;
}

export async function rotacionarCredencial(
  p: PedidoDeRotacionar,
): Promise<ResultadoDeRotacionar> {
  const patch: Record<string, unknown> = {};
  let last4: string | null = null;

  if (p.apiKey !== undefined) {
    let cifrada: ReturnType<typeof colunasCifradas>;
    try {
      cifrada = colunasCifradas(p.apiKey);
    } catch (err) {
      return { ok: false, motivo: "cifragem", detalhe: err instanceof Error ? err.message : undefined };
    }
    last4 = cifrada.last4;
    patch.api_key_encrypted = cifrada.api_key_encrypted;
    patch.api_key_iv = cifrada.api_key_iv;
    patch.api_key_tag = cifrada.api_key_tag;
    patch.api_key_last4 = cifrada.api_key_last4;
    // Chave nova = veredito antigo deixa de valer. Sem zerar, a tela mostraria
    // "Validada" (e os modelos da chave anterior) sobre uma chave que ninguém
    // testou ainda — mentira com cara de confirmação.
    patch.validated_at = null;
    patch.validation_error = null;
    patch.models_available = null;
  }

  if (p.label !== undefined) patch.label = p.label;

  const { data: updated, error } = await p.admin
    .from("ai_provider_credentials")
    .update(patch)
    .eq("id", p.credentialId)
    .eq("organization_id", p.orgId)
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return { ok: false, motivo: "label_em_uso" };
    return { ok: false, motivo: "banco", detalhe: error.message };
  }
  if (!updated) return { ok: false, motivo: "nao_encontrada" };

  await audit({
    action: "ai.credential_updated",
    actorUserId: p.userId,
    organizationId: p.orgId,
    resourceType: "ai_provider_credential",
    resourceId: p.credentialId,
    ...(p.requestId ? { requestId: p.requestId } : {}),
    // `last4` (não a chave) e o rótulo: a trilha responde "quando girou e para
    // onde", que é a pergunta de auditoria — nunca o segredo.
    metadata: {
      provider: p.provider,
      label: p.label ?? null,
      last4,
      trocou_chave: p.apiKey !== undefined,
    },
  });

  if (p.apiKey !== undefined) {
    // Mesmo contrato do POST: validar é um segundo momento, que pode falhar por
    // rede sem desfazer a rotação; a resposta não espera o provedor.
    void validarEmSegundoPlano(p.admin, p.credentialId, p.orgId, p.provider, p.apiKey);
  }

  return { ok: true, id: p.credentialId, last4, trocouChave: p.apiKey !== undefined };
}

async function validarEmSegundoPlano(
  admin: ReturnType<typeof createAdminClient>,
  credentialId: string,
  organizationId: string,
  provider: ProvedorComChave,
  apiKey: string,
): Promise<void> {
  try {
    const r = await validateProviderKey(provider, apiKey);
    await admin
      .from("ai_provider_credentials")
      .update(
        r.ok
          ? {
              validated_at: new Date().toISOString(),
              validation_error: null,
              models_available: r.models,
            }
          : { validated_at: null, validation_error: r.error, models_available: null },
      )
      .eq("id", credentialId)
      .eq("organization_id", organizationId);
  } catch {
    // Falha de rede na validação não pode derrubar nada: a credencial existe e
    // o campo `validated_at` continua nulo, que é a leitura honesta de "ainda
    // não sei".
  }
}
