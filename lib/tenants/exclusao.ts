/**
 * EXCLUSÃO DE UMA ORGANIZAÇÃO — o procedimento inteiro, na ordem que não deixa
 * órfão.
 *
 * O banco faz a parte transacional (`fn_excluir_organizacao`, migration 0492):
 * lápide na auditoria, cascata em ~155 tabelas, conferência de que nada ficou.
 * O que mora FORA do Postgres não entra numa transação, e por isso a ordem é o
 * desenho:
 *
 *   1. ANTES do banco, desligar o que fala com o mundo — os canais de mensagem
 *      (`lib/channels/desligar-da-organizacao.ts`), a voz e os webhooks da
 *      loja integrada. Precisa ser
 *      antes: é a credencial guardada nas linhas da organização que autoriza a
 *      chamada, e depois da cascata ela não existe mais. Best-effort: um serviço
 *      externo fora do ar não segura a exclusão que o admin pediu — o resultado
 *      de cada passo vai para o registro final.
 *   2. O banco, numa transação. Se falhar, nada foi apagado: o tenant fica
 *      intacto (e suspenso) e o admin pode tentar de novo.
 *   3. DEPOIS do commit, os arquivos no Storage (prefixo `<org>/` em todos os
 *      buckets) pela API — apagar `storage.objects` direto deixaria o arquivo
 *      no disco. Repetível: o prefixo é determinístico.
 *   4. Os logins que pertenciam só a esta organização, pelo GoTrue (limpa
 *      sessões, fatores e identidades). Quem o banco ainda referencia fica, e
 *      isso é registrado — não é erro.
 *   5. O registro final (`organization.deletion_completed`).
 *
 * Pré-condição dura, conferida aqui e de novo no banco: a organização está
 * SUSPENSA e a confirmação é o slug dela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { desligarCanaisDaOrganizacao } from "@/lib/channels/desligar-da-organizacao";
import { logger } from "@/lib/logger";
import { NuvemshopApiClient } from "@/lib/nuvemshop/api-client";
import { despareaVoz } from "@/lib/voice/desparear";
import { getWacallsClient } from "@/lib/wacalls/client";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export type DesfechoExterno = "ok" | "falhou" | "nao_se_aplica";

export interface ResultadoDaExclusao {
  organizacao: string;
  slug: string;
  contagens: Record<string, number>;
  canais: Array<{ id: string; provedor: string; desfecho: DesfechoExterno; motivo?: string }>;
  voz: DesfechoExterno;
  nuvemshop: DesfechoExterno;
  arquivos: { encontrados: number; removidos: number; falhas: number };
  usuarios: { removidos: string[]; mantidos: Array<{ id: string; motivo: string }> };
}

export class ExclusaoRecusada extends Error {
  constructor(
    public readonly codigo:
      "not_found" | "state_conflict" | "confirmacao_divergente" | "motivo_curto",
    message: string,
  ) {
    super(message);
    this.name = "ExclusaoRecusada";
  }
}

interface Entrada {
  orgId: string;
  atorId: string;
  confirmacao: string;
  motivo: string;
  requestId: string;
}

const LOTE_DO_STORAGE = 100;

function mensagemDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Passo 1b — a voz é por organização, não por canal. */
async function desligarVoz(admin: SupabaseClient, orgId: string): Promise<DesfechoExterno> {
  const wacalls = getWacallsClient();
  if (!wacalls) return "nao_se_aplica";
  try {
    const r = await despareaVoz(admin, wacalls, orgId);
    return r.desapareado ? "ok" : "nao_se_aplica";
  } catch (err) {
    logger.warn("[exclusao] falha ao desparear a voz", {
      organization_id: orgId,
      erro: mensagemDe(err),
    });
    return "falhou";
  }
}

/** Passo 1c — os webhooks que a conexão registrou na loja apontam para cá. */
async function desligarNuvemshop(admin: SupabaseClient, orgId: string): Promise<DesfechoExterno> {
  const { data } = await admin
    .from("tenant_integrations")
    .select("oauth_access_token_encrypted, store_metadata, webhook_subscriptions")
    .eq("organization_id", orgId)
    .eq("provider", "nuvemshop")
    .maybeSingle();
  const linha = data as {
    oauth_access_token_encrypted: string | null;
    store_metadata: { store_id?: string | number } | null;
    webhook_subscriptions: Record<string, { id: number | null }> | null;
  } | null;
  if (!linha?.oauth_access_token_encrypted || !linha.store_metadata?.store_id)
    return "nao_se_aplica";
  try {
    const accessToken = await decryptWebhookSecret(admin, linha.oauth_access_token_encrypted);
    if (!accessToken) return "falhou";
    const client = new NuvemshopApiClient({
      storeId: String(linha.store_metadata.store_id),
      accessToken,
    });
    let falhou = false;
    for (const assinatura of Object.values(linha.webhook_subscriptions ?? {})) {
      if (!assinatura?.id) continue;
      try {
        await client.deleteWebhook(assinatura.id);
      } catch {
        falhou = true;
      }
    }
    return falhou ? "falhou" : "ok";
  } catch (err) {
    logger.warn("[exclusao] falha ao remover os webhooks da Nuvemshop", {
      organization_id: orgId,
      erro: mensagemDe(err),
    });
    return "falhou";
  }
}

/** Passo 3 — arquivos pelo prefixo `<org>/`, em lotes, pela API do Storage. */
async function limparArquivos(
  admin: SupabaseClient,
  orgId: string,
): Promise<ResultadoDaExclusao["arquivos"]> {
  const { data, error } = await admin.rpc("fn_arquivos_da_organizacao", { p_org: orgId });
  if (error) {
    logger.warn("[exclusao] inventário do Storage falhou", {
      organization_id: orgId,
      erro: error.message,
    });
    return { encontrados: 0, removidos: 0, falhas: 1 };
  }
  const porBucket = new Map<string, string[]>();
  for (const o of (data ?? []) as Array<{ bucket_id: string; name: string }>) {
    porBucket.set(o.bucket_id, [...(porBucket.get(o.bucket_id) ?? []), o.name]);
  }
  let removidos = 0;
  let falhas = 0;
  for (const [bucket, nomes] of porBucket) {
    for (let i = 0; i < nomes.length; i += LOTE_DO_STORAGE) {
      const lote = nomes.slice(i, i + LOTE_DO_STORAGE);
      const { error: remErr } = await admin.storage.from(bucket).remove(lote);
      if (remErr) falhas += lote.length;
      else removidos += lote.length;
    }
  }
  return { encontrados: (data ?? []).length, removidos, falhas };
}

/** Passo 4 — só quem o banco apontou como sem nenhum outro vínculo. */
async function removerLogins(
  admin: SupabaseClient,
  candidatos: string[],
): Promise<ResultadoDaExclusao["usuarios"]> {
  const removidos: string[] = [];
  const mantidos: Array<{ id: string; motivo: string }> = [];
  for (const id of candidatos) {
    const { error } = await admin.auth.admin.deleteUser(id);
    // O banco ainda referencia a pessoa (ex.: autora de um registro que não é
    // da organização excluída): o GoTrue recusa pela FK e o login fica. É o
    // desfecho correto — apagar forçado levaria dado alheio junto.
    if (error) mantidos.push({ id, motivo: error.message });
    else removidos.push(id);
  }
  return { removidos, mantidos };
}

export async function excluirOrganizacao(
  admin: SupabaseClient,
  entrada: Entrada,
): Promise<ResultadoDaExclusao> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < 10) {
    throw new ExclusaoRecusada(
      "motivo_curto",
      "Informe o motivo da exclusão (mínimo 10 caracteres).",
    );
  }

  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("id, slug, status")
    .eq("id", entrada.orgId)
    .maybeSingle();
  if (orgErr) throw new Error(`exclusao_leitura: ${orgErr.message}`);
  if (!org) throw new ExclusaoRecusada("not_found", "Organização não encontrada.");
  if (org.status !== "suspended") {
    throw new ExclusaoRecusada(
      "state_conflict",
      "Só uma organização suspensa pode ser excluída. Suspenda-a antes.",
    );
  }
  if (entrada.confirmacao !== org.slug) {
    throw new ExclusaoRecusada(
      "confirmacao_divergente",
      "A confirmação não confere com o identificador da organização.",
    );
  }

  // 1. O que fala com o mundo, com as credenciais ainda no banco.
  const canais = await desligarCanaisDaOrganizacao(admin, entrada.orgId);
  const voz = await desligarVoz(admin, entrada.orgId);
  const nuvemshop = await desligarNuvemshop(admin, entrada.orgId);

  // 2. O banco, numa transação.
  const { data: resultado, error: rpcErr } = await admin.rpc("fn_excluir_organizacao", {
    p_org: entrada.orgId,
    p_actor: entrada.atorId,
    p_confirmacao: entrada.confirmacao,
    p_motivo: motivo,
    p_request_id: entrada.requestId,
  });
  if (rpcErr) {
    // Recusas do próprio banco (corrida com uma reativação, por exemplo) viram
    // a mesma recusa que a checagem de cima daria.
    if (rpcErr.code === "PT409")
      throw new ExclusaoRecusada("state_conflict", "A organização não está mais suspensa.");
    if (rpcErr.code === "PT404")
      throw new ExclusaoRecusada("not_found", "Organização não encontrada.");
    throw new Error(`exclusao_banco: ${rpcErr.message}`);
  }
  const banco = resultado as {
    slug: string;
    contagens: Record<string, number>;
    usuarios_removiveis: string[];
  };

  // 3 e 4. Depois do commit — repetíveis e registrados.
  const arquivos = await limparArquivos(admin, entrada.orgId);
  const usuarios = await removerLogins(admin, banco.usuarios_removiveis ?? []);

  const saida: ResultadoDaExclusao = {
    organizacao: entrada.orgId,
    slug: banco.slug,
    contagens: banco.contagens ?? {},
    canais,
    voz,
    nuvemshop,
    arquivos,
    usuarios,
  };

  // 5. O registro final. `organizationId` nulo: a organização não existe mais,
  // e a trilha dela é achada por `resource_id` (como a lápide).
  await audit({
    action: "organization.deletion_completed",
    actorUserId: entrada.atorId,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: null,
    resourceType: "organization",
    resourceId: entrada.orgId,
    requestId: entrada.requestId,
    metadata: {
      slug: saida.slug,
      canais: saida.canais,
      voz: saida.voz,
      nuvemshop: saida.nuvemshop,
      arquivos: saida.arquivos,
      usuarios_removidos: saida.usuarios.removidos.length,
      usuarios_mantidos: saida.usuarios.mantidos.length,
    },
  });

  return saida;
}
