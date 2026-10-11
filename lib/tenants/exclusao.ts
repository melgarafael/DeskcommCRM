/**
 * EXCLUSÃO DE UMA ORGANIZAÇÃO — o procedimento inteiro, na ordem que não deixa
 * órfão.
 *
 * O banco faz a parte transacional (`fn_excluir_organizacao`, migration 0614):
 * lápide na auditoria, cascata em ~155 tabelas, conferência de que nada ficou.
 * O que mora FORA do Postgres não entra numa transação, e por isso a ordem é o
 * desenho:
 *
 *   0. RELER O PROVEDOR DE COBRANÇA — antes de qualquer transação. A trava da
 *      migration 0601 (`trg_cobranca_trava_exclusao_com_assinatura_viva`)
 *      decide pela LINHA de `cobranca_assinaturas`, e a linha diz o que a
 *      ÚLTIMA releitura gravou (`sincronizar`). Sem reler aqui, uma assinatura
 *      que voltou a ficar viva depois daquela gravação passava pela trava — e
 *      uma que o provedor cancelou continuava bloqueando (#2626). Quem grava é
 *      `sincronizar`, o único lugar que grava a releitura; com a empresa
 *      suspensa pelo administrador (a pré-condição abaixo) a régua devolve
 *      `nada`, então o efeito desta chamada é a releitura fresca na linha.
 *      Leitura que FALHA recusa a exclusão (503 `provedor_indisponivel`), como a
 *      isenção recusa (`app/api/v1/admin/tenants/[id]/assinatura/route.ts`): a
 *      exclusão é irreversível e a cascata leva junto o `provedor_cliente_id`,
 *      então excluir pelo último estado gravado deixaria o provedor cobrando
 *      sem ninguém aqui para cancelar.
 *   1. ANTES do banco, só LER o que o desligamento vai precisar — as linhas dos
 *      canais (`inventariarCanaisDaOrganizacao`, em
 *      `lib/channels/desligar-da-organizacao.ts`), a sessão de voz e a conexão
 *      da loja, com as credenciais já decifradas, em memória. Precisa ser
 *      antes: depois da cascata as linhas não existem mais. Nada externo é
 *      tocado neste passo.
 *   2. O banco, numa transação. Se falhar, nada foi apagado e NADA lá fora
 *      caiu: o WhatsApp, a voz e a loja da empresa seguem funcionando, e o
 *      tenant fica suspenso e intacto para o admin tentar de novo.
 *   3. DEPOIS do commit, desligar o que fala com o mundo, só com o inventário:
 *      os canais de mensagem, a voz e os webhooks da loja. Best-effort: um
 *      serviço fora do ar não desfaz a exclusão — o desfecho de cada passo vai
 *      para o registro final, e um `falhou` aqui é sessão órfã no provedor.
 *      Desligar antes e o banco recusar era pior: a empresa ficava sem
 *      WhatsApp e continuava existindo.
 *   4. Os arquivos no Storage (prefixo `<org>/` em todos os buckets) pela API
 *      — apagar `storage.objects` direto deixaria o arquivo no disco. O
 *      inventário vem em páginas (o PostgREST corta em 1000 linhas sem avisar).
 *   5. Os logins que pertenciam só a esta organização, pelo GoTrue (limpa
 *      sessões, fatores e identidades). Quem o banco ainda referencia fica, e
 *      isso é registrado — não é erro.
 *   6. O registro final (`organization.deletion_completed`).
 *
 * INTERROMPIDA DEPOIS DO COMMIT. Os passos 3 a 6 moram na memória da
 * requisição: se a resposta da rpc se perde (gateway, rede, restart) ou o
 * processo morre no meio, nada do que estava em memória sobra. Por isso a
 * lápide guarda os identificadores sem segredo do que fala com o mundo
 * (sessões, números, voz, loja) e os membros, e uma nova tentativa sobre a
 * organização já apagada — lápide `organization.deleted` sem
 * `organization.deletion_completed` — RETOMA dos passos 3 a 6 a partir dela.
 * O que precisava de credencial (o webhook do número oficial, os webhooks da
 * loja) não se refaz: vai para o registro final como `falhou`, com o
 * identificador na lápide. Esses casos chegam a quem chamou como
 * `ExclusaoInterrompida`, nunca como "nada foi apagado".
 *
 * Pré-condição dura, conferida aqui e de novo no banco: a organização está
 * SUSPENSA, a suspensão é ADMINISTRATIVA (a por cobrança é recusada — excluir
 * deixaria a assinatura cobrando no provedor) e a confirmação é o slug dela.
 * Aqui se olha só o tipo; o banco olha também o histórico da suspensão atual,
 * porque uma administrativa por cima da cobrança troca o tipo (migration 0614)
 * — essa recusa chega como `PT409 organizacao_com_cobranca_pendente`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { estaSuspensa } from "@/lib/organizacao/operante";
import {
  desligarCanaisInventariados,
  inventariarCanaisDaOrganizacao,
  inventarioDaLapide,
  type CanalNaLapide,
  type InventarioDeCanais,
} from "@/lib/channels/desligar-da-organizacao";
import { sincronizar } from "@/lib/cobranca/sincronizar";
import { logger } from "@/lib/logger";
import { NuvemshopApiClient } from "@/lib/nuvemshop/api-client";
import { desligarSessaoDeVozNoTransporte } from "@/lib/voice/desparear";
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
      | "not_found"
      | "state_conflict"
      | "exclusao_com_cobranca_pendente"
      | "exclusao_com_assinatura_viva"
      | "provedor_indisponivel"
      | "confirmacao_divergente"
      | "motivo_curto",
    message: string,
  ) {
    super(message);
    this.name = "ExclusaoRecusada";
  }
}

/**
 * A exclusão passou do commit — ou pode ter passado, quando a resposta da rpc
 * se perdeu — e a limpeza de fora não terminou. Repetir com o mesmo
 * identificador retoma (ou exclui, se o banco não confirmou).
 */
export class ExclusaoInterrompida extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExclusaoInterrompida";
  }
}

/** O que a lápide da migration 0614 guarda e a retomada lê. */
interface LapideDaExclusao {
  slug: string;
  contagens?: Record<string, number>;
  membros?: string[];
  inventario_externo?: {
    canais?: CanalNaLapide[];
    nuvemshop_store_id?: string | null;
  };
}

interface Entrada {
  orgId: string;
  atorId: string;
  confirmacao: string;
  motivo: string;
  requestId: string;
}

const LOTE_DO_STORAGE = 100;
/**
 * Página do inventário do Storage. Abaixo do `max_rows` do PostgREST (1000,
 * `supabase/config.toml`), que corta a resposta de função em silêncio: uma
 * chamada só devolvia os 1000 primeiros e o resultado dizia "terminou".
 */
const PAGINA_DO_INVENTARIO = 500;

function mensagemDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const MENSAGEM_DE_COBRANCA =
  "Esta empresa está suspensa por falta de pagamento. Excluí-la deixaria a assinatura cobrando no provedor: resolva a cobrança antes.";

/** A releitura do provedor falhou: a exclusão recusa em vez de decidir pelo estado gravado. */
const MENSAGEM_DE_PROVEDOR_INDISPONIVEL =
  "Não foi possível confirmar com o provedor de cobrança se esta empresa ainda tem assinatura ativa. Nada foi apagado. Tente de novo; se persistir, confira a conexão do provedor em Cobrança.";

/**
 * A recusa do gatilho da migration 0601 (`organizacao_com_assinatura_viva`).
 * A suspensão por cobrança já foi recusada antes, então quem chega aqui é a
 * empresa suspensa pelo ADMINISTRADOR que ainda tem assinatura viva no
 * provedor — "falta de pagamento" seria falso, e "não está mais suspensa"
 * também.
 */
const MENSAGEM_DE_ASSINATURA_VIVA =
  "Esta empresa ainda tem assinatura ativa no provedor de cobrança. Cancele a assinatura antes de excluir: excluí-la agora deixaria o provedor cobrando sem ninguém aqui para cancelar.";

/** Passo 3 — a voz é por organização, não por canal; o id veio do inventário. */
async function desligarVoz(orgId: string, sessaoDeVoz: string | null): Promise<DesfechoExterno> {
  const wacalls = getWacallsClient();
  if (!wacalls || !sessaoDeVoz) return "nao_se_aplica";
  try {
    await desligarSessaoDeVozNoTransporte(wacalls, sessaoDeVoz);
    return "ok";
  } catch (err) {
    logger.warn("[exclusao] falha ao desligar a voz", {
      organization_id: orgId,
      erro: mensagemDe(err),
    });
    return "falhou";
  }
}

interface LojaInventariada {
  storeId: string;
  /** Decifrado antes da transação; `null` quando a credencial não abriu. */
  accessToken: string | null;
  webhookIds: number[];
}

/** Passo 1 — a conexão da loja, lida antes da transação (só leitura). */
async function inventariarNuvemshop(
  admin: SupabaseClient,
  orgId: string,
): Promise<LojaInventariada | null> {
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
  if (!linha?.oauth_access_token_encrypted || !linha.store_metadata?.store_id) return null;
  let accessToken: string | null = null;
  try {
    accessToken = await decryptWebhookSecret(admin, linha.oauth_access_token_encrypted);
  } catch (err) {
    logger.warn("[exclusao] credencial da Nuvemshop ilegível", {
      organization_id: orgId,
      erro: mensagemDe(err),
    });
  }
  const webhookIds = Object.values(linha.webhook_subscriptions ?? {})
    .map((a) => a?.id)
    .filter((id): id is number => typeof id === "number");
  return { storeId: String(linha.store_metadata.store_id), accessToken, webhookIds };
}

/** Passo 3 — os webhooks que a conexão registrou na loja apontam para cá. */
async function desligarNuvemshop(
  orgId: string,
  loja: LojaInventariada | null,
): Promise<DesfechoExterno> {
  if (!loja) return "nao_se_aplica";
  if (!loja.accessToken) return "falhou";
  const client = new NuvemshopApiClient({ storeId: loja.storeId, accessToken: loja.accessToken });
  let falhou = false;
  for (const id of loja.webhookIds) {
    try {
      await client.deleteWebhook(id);
    } catch (err) {
      falhou = true;
      logger.warn("[exclusao] falha ao remover um webhook da Nuvemshop", {
        organization_id: orgId,
        erro: mensagemDe(err),
      });
    }
  }
  return falhou ? "falhou" : "ok";
}

/**
 * Passo 4 — arquivos pelo prefixo `<org>/`, pela API do Storage. O inventário
 * vem em páginas por cursor (bucket, nome) até uma página curta; cada página é
 * removida em lotes antes de pedir a seguinte.
 */
async function limparArquivos(
  admin: SupabaseClient,
  orgId: string,
): Promise<ResultadoDaExclusao["arquivos"]> {
  let encontrados = 0;
  let removidos = 0;
  let falhas = 0;
  let cursor: { bucket_id: string; name: string } | null = null;
  for (;;) {
    const { data, error } = await admin.rpc("fn_arquivos_da_organizacao", {
      p_org: orgId,
      p_apos_bucket: cursor?.bucket_id ?? null,
      p_apos_nome: cursor?.name ?? null,
      p_limite: PAGINA_DO_INVENTARIO,
    });
    if (error) {
      logger.warn("[exclusao] inventário do Storage falhou", {
        organization_id: orgId,
        erro: error.message,
      });
      return { encontrados, removidos, falhas: falhas + 1 };
    }
    const pagina = (data ?? []) as Array<{ bucket_id: string; name: string }>;
    encontrados += pagina.length;
    const porBucket = new Map<string, string[]>();
    for (const o of pagina) {
      porBucket.set(o.bucket_id, [...(porBucket.get(o.bucket_id) ?? []), o.name]);
    }
    for (const [bucket, nomes] of porBucket) {
      for (let i = 0; i < nomes.length; i += LOTE_DO_STORAGE) {
        const lote = nomes.slice(i, i + LOTE_DO_STORAGE);
        const { error: remErr } = await admin.storage.from(bucket).remove(lote);
        if (remErr) falhas += lote.length;
        else removidos += lote.length;
      }
    }
    if (pagina.length < PAGINA_DO_INVENTARIO) break;
    cursor = pagina[pagina.length - 1]!;
  }
  return { encontrados, removidos, falhas };
}

/** Passo 5 — só quem o banco apontou como sem nenhum outro vínculo. */
async function removerLogins(
  admin: SupabaseClient,
  candidatos: string[],
): Promise<ResultadoDaExclusao["usuarios"]> {
  const removidos: string[] = [];
  const mantidos: Array<{ id: string; motivo: string }> = [];
  for (const id of candidatos) {
    const { error } = await admin.auth.admin.deleteUser(id);
    // Na retomada, o login pode já ter saído na tentativa interrompida.
    if (error && (error as { status?: number }).status === 404) {
      removidos.push(id);
      continue;
    }
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
    .select("id, slug, status, suspended_kind")
    .eq("id", entrada.orgId)
    .maybeSingle();
  if (orgErr) throw new Error(`exclusao_leitura: ${orgErr.message}`);
  if (!org) return retomar(admin, entrada);
  if (!estaSuspensa(org.status)) {
    throw new ExclusaoRecusada(
      "state_conflict",
      "Só uma organização suspensa pode ser excluída. Suspenda-a antes.",
    );
  }
  // Tipo nulo vale como administrativa — a régua de `lib/organizacao/operante.ts`.
  if (org.suspended_kind === "cobranca") {
    throw new ExclusaoRecusada("exclusao_com_cobranca_pendente", MENSAGEM_DE_COBRANCA);
  }
  if (entrada.confirmacao !== org.slug) {
    throw new ExclusaoRecusada(
      "confirmacao_divergente",
      "A confirmação não confere com o identificador da organização.",
    );
  }

  // 0. RELER O PROVEDOR ANTES DA RPC — a trava da migration 0601 lê a linha de
  //    `cobranca_assinaturas` (o que a última releitura gravou), e sem esta
  //    releitura ela decidiria pelo passado: assinatura que voltou a viver
  //    passaria, e a cancelada continuaria bloqueando (#2626). `sincronizar` é
  //    quem grava (compare-and-set em `relida_em`); a régua, aqui, é `nada`,
  //    porque a pré-condição acima só deixa seguir com suspensão
  //    administrativa. Leitura que falha (`ultimo_erro` gravado,
  //    `cobranca.leitura_falhou` no log) RECUSA: a exclusão é irreversível e o
  //    último estado gravado pode ser justamente o que mudou.
  const releitura = await sincronizar(admin, entrada.orgId);
  if (releitura.tipo === "falhou") {
    throw new ExclusaoRecusada("provedor_indisponivel", MENSAGEM_DE_PROVEDOR_INDISPONIVEL);
  }

  // 1. Só leitura: o que o desligamento vai precisar, antes que a cascata
  // apague as linhas. Nada externo é tocado aqui.
  const inventario = await inventariarCanaisDaOrganizacao(admin, entrada.orgId);
  const loja = await inventariarNuvemshop(admin, entrada.orgId);

  // 2. O banco, numa transação.
  let rpc: { data: unknown; error: { code?: string; message: string } | null };
  try {
    rpc = await admin.rpc("fn_excluir_organizacao", {
      p_org: entrada.orgId,
      p_actor: entrada.atorId,
      p_confirmacao: entrada.confirmacao,
      p_motivo: motivo,
      p_request_id: entrada.requestId,
    });
  } catch (err) {
    throw new ExclusaoInterrompida(`exclusao_banco_sem_resposta: ${mensagemDe(err)}`);
  }
  const rpcErr = rpc.error;
  if (rpcErr) {
    // Recusas do próprio banco (corrida com uma reativação, ou com uma
    // suspensão que virou cobrança) viram a mesma recusa que a checagem de
    // cima daria. Nada lá fora foi tocado.
    if (rpcErr.code === "PT409" && rpcErr.message === "organizacao_com_cobranca_pendente")
      throw new ExclusaoRecusada("exclusao_com_cobranca_pendente", MENSAGEM_DE_COBRANCA);
    if (rpcErr.code === "PT409" && rpcErr.message === "organizacao_com_assinatura_viva")
      throw new ExclusaoRecusada("exclusao_com_assinatura_viva", MENSAGEM_DE_ASSINATURA_VIVA);
    if (rpcErr.code === "PT409")
      throw new ExclusaoRecusada("state_conflict", "A organização não está mais suspensa.");
    if (rpcErr.code === "PT404")
      throw new ExclusaoRecusada("not_found", "Organização não encontrada.");
    // Sem código, o erro não veio do Postgres: a resposta não chegou (rede,
    // gateway, restart) e o commit PODE ter acontecido.
    if (!rpcErr.code) throw new ExclusaoInterrompida(`exclusao_banco_sem_resposta: ${rpcErr.message}`);
    throw new Error(`exclusao_banco: ${rpcErr.message}`);
  }
  const banco = rpc.data as {
    slug: string;
    contagens: Record<string, number>;
    usuarios_removiveis: string[];
  };

  return concluirDepoisDoCommit(admin, entrada, {
    slug: banco.slug,
    contagens: banco.contagens ?? {},
    inventario,
    loja,
    removiveis: banco.usuarios_removiveis ?? [],
    retomada: false,
  });
}

/**
 * A organização já não existe. Se a lápide existe e o registro final não, a
 * tentativa anterior morreu depois do commit: refaz os passos 3 a 6 a partir
 * da lápide. Senão, a organização não existe (ou já foi excluída por inteiro).
 */
async function retomar(admin: SupabaseClient, entrada: Entrada): Promise<ResultadoDaExclusao> {
  const { data, error } = await admin
    .from("api_audit_log")
    .select("action, metadata")
    .eq("resource_type", "organization")
    .eq("resource_id", entrada.orgId)
    .in("action", ["organization.deleted", "organization.deletion_completed"]);
  if (error) throw new ExclusaoInterrompida(`exclusao_retomada_leitura: ${error.message}`);
  const linhas = (data ?? []) as Array<{ action: string; metadata: LapideDaExclusao }>;
  const lapide = linhas.find((l) => l.action === "organization.deleted")?.metadata;
  if (!lapide || linhas.some((l) => l.action === "organization.deletion_completed")) {
    throw new ExclusaoRecusada("not_found", "Organização não encontrada.");
  }
  if (entrada.confirmacao !== lapide.slug) {
    throw new ExclusaoRecusada(
      "confirmacao_divergente",
      "A confirmação não confere com o identificador da organização.",
    );
  }

  // A mesma régua da exclusão, AGORA: quem ganhou outro vínculo desde a
  // tentativa interrompida não é mais removível.
  const { data: removiveis, error: logErr } = await admin.rpc("fn_logins_sem_vinculo", {
    p_users: lapide.membros ?? [],
  });
  if (logErr) throw new ExclusaoInterrompida(`exclusao_retomada_logins: ${logErr.message}`);

  const storeId = lapide.inventario_externo?.nuvemshop_store_id;
  return concluirDepoisDoCommit(admin, entrada, {
    slug: lapide.slug,
    contagens: lapide.contagens ?? {},
    inventario: inventarioDaLapide(lapide.inventario_externo?.canais ?? []),
    // O token da loja só existia na memória da tentativa que morreu.
    loja: storeId ? { storeId, accessToken: null, webhookIds: [] } : null,
    removiveis: (removiveis ?? []) as string[],
    retomada: true,
  });
}

/** Passos 3 a 6. Qualquer throw aqui é depois do commit: a exclusão está interrompida, não desfeita. */
async function concluirDepoisDoCommit(
  admin: SupabaseClient,
  entrada: Entrada,
  depois: {
    slug: string;
    contagens: Record<string, number>;
    inventario: InventarioDeCanais;
    loja: LojaInventariada | null;
    removiveis: string[];
    retomada: boolean;
  },
): Promise<ResultadoDaExclusao> {
  try {
    // 3. Depois do commit, o que fala com o mundo — só com o inventário.
    const canais = await desligarCanaisInventariados(depois.inventario);
    const voz = await desligarVoz(entrada.orgId, depois.inventario.sessaoDeVoz);
    const nuvemshop = await desligarNuvemshop(entrada.orgId, depois.loja);

    // 4 e 5. Registrados.
    const arquivos = await limparArquivos(admin, entrada.orgId);
    const usuarios = await removerLogins(admin, depois.removiveis);

    const saida: ResultadoDaExclusao = {
      organizacao: entrada.orgId,
      slug: depois.slug,
      contagens: depois.contagens,
      canais,
      voz,
      nuvemshop,
      arquivos,
      usuarios,
    };

    // 6. O registro final. `organizationId` nulo: a organização não existe mais.
    // Ele e a lápide são achados por `resource_id`; as linhas antigas da org,
    // que perderam a atribuição no SET NULL, só são DELIMITADAS pela lápide
    // (membros, contagem e intervalo) — ver o cabeçalho da migration 0614.
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
        retomada: depois.retomada,
        canais: saida.canais,
        voz: saida.voz,
        nuvemshop: saida.nuvemshop,
        arquivos: saida.arquivos,
        usuarios_removidos: saida.usuarios.removidos.length,
        usuarios_mantidos: saida.usuarios.mantidos.length,
      },
    });

    return saida;
  } catch (err) {
    throw new ExclusaoInterrompida(`exclusao_depois_do_commit: ${mensagemDe(err)}`);
  }
}
