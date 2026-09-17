import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";

import { audit, auditForOrganizations } from "@/lib/audit";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { assertCatalogOrigin, downloadArtifact } from "./download";
import { SQL_ERRORS } from "./erros-do-banco";
import { causaSegura, ExtensionError } from "./errors";
import {
  lerManifestoAdmitido,
  montarAnterior,
  montarInstalada,
  MOTIVO_PACOTE_ILEGIVEL,
} from "./instalada";
import {
  EXTENSION_OPERATION_KINDS,
  EXTENSION_OPERATION_STATUSES,
  ehEstadoDeOperacao,
  ehTipoDeOperacao,
} from "./vocabulario";
import { ExtensionServiceError, requireExtensionPlatformFor } from "./http";
import {
  checkCompatibility,
  configurationSchema,
  parseCatalog,
  validateCatalogSnapshot,
  validateArtifact,
  type CatalogEntry,
  type ExtensionConfiguration,
  type ExtensionManifest,
} from "./manifest";
import type {
  ExtensionGuideView,
  ExtensionListView,
  ExtensionOperationView,
  InstalledExtensionView,
} from "./view";

const uuid = z.string().uuid();
const catalogRowSchema = z.object({
  id: uuid,
  origin: z.string(),
  revision: z.number().int(),
  digest: z.string(),
  snapshot: z.unknown(),
  admitted_at: z.string(),
});
const artifactRowSchema = z.object({
  id: uuid,
  sha256: z.string(),
  byte_length: z.number(),
  manifest: z.unknown(),
  document: z.string(),
});
const installationRowSchema = z.object({
  id: uuid,
  catalog_id: uuid,
  artifact_id: uuid,
  previous_artifact_id: uuid.nullable(),
  publisher: z.string(),
  name: z.string(),
  version: z.string(),
  revision: z.number().int().positive(),
  removed_at: z.string().nullable(),
});
const bindingRowSchema = z.object({
  organization_id: uuid,
  installation_id: uuid,
  enabled: z.boolean(),
  configuration: configurationSchema,
  revision: z.number().int(),
  deactivated_by_removal_at: z.string().nullable(),
});
const countRowSchema = z.object({
  installation_id: uuid,
  active_organizations: z.number().int(),
  awaiting_reactivation: z.number().int(),
});
const operationRowSchema = z.object({
  id: uuid,
  kind: z.enum(EXTENSION_OPERATION_KINDS),
  status: z.enum(EXTENSION_OPERATION_STATUSES),
  actor_id: uuid.nullable(),
  organization_id: uuid.nullable(),
  catalog_id: uuid.nullable(),
  installation_id: uuid.nullable(),
  publisher: z.string().nullable(),
  name: z.string().nullable(),
  version: z.string().nullable(),
  entry: z.unknown(),
  result: z.unknown(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
/** O que a tela usa do `result` de uma troca. Recibo antigo sem esses campos projeta `null`. */
const tradeResultSchema = z.object({
  from_revision: z.number().int().nullable().optional(),
  from_version: z.string().nullable().optional(),
  to_version: z.string().nullable().optional(),
  organizations_active: z.number().int().optional(),
  organizations_disabled: z.array(uuid).optional(),
  organizations_disabled_count: z.number().int().optional(),
});
/** Toda RPC que escreve diz se ESTA chamada fez a transição; a repetição idempotente diz `false`. */
const appliedSchema = z.object({ applied_now: z.boolean() });

function dbFailure(error: { code?: string; message?: string } | null): void {
  if (!error) return;
  const known = error.code === "P0001" && error.message ? SQL_ERRORS[error.message] : undefined;
  if (known && error.message)
    throw new ExtensionServiceError(error.message, known.message, known.status);
  // O código e a mensagem do banco só existem aqui: o erro que sobe é genérico de propósito, porque
  // a tela não mostra detalhe do banco. Sem este registro, "a tabela não existe" — um deploy cujo
  // código chegou antes da migration — virava um aviso na tela de todo mundo e nada no log.
  logger.warn("[extensions] falha do banco sem código conhecido", {
    db_code: error.code ?? null,
    detail: (error.message ?? "").slice(0, 200),
  });
  throw new ExtensionServiceError(
    "upstream_unavailable",
    "Não foi possível confirmar o resultado. Consulte o histórico antes de repetir o pedido.",
    503,
  );
}

function serviceError(code: keyof typeof SQL_ERRORS): ExtensionServiceError {
  const known = SQL_ERRORS[code]!;
  return new ExtensionServiceError(code, known.message, known.status);
}

function tradeResult(value: unknown): z.infer<typeof tradeResultSchema> {
  const parsed = tradeResultSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function operationView(value: unknown): ExtensionOperationView {
  const row = operationRowSchema.parse(value);
  let message: string | null = row.error_code
    ? (SQL_ERRORS[row.error_code]?.message ?? null)
    : null;
  if (row.error_code && !message) {
    const known = [
      "extension_invalid_package",
      "extension_incompatible",
      "extension_download_failed",
      "extension_unsafe_origin",
      "extension_digest_mismatch",
      "extension_payload_too_large",
    ] as const;
    const code = known.find((candidate) => candidate === row.error_code);
    message = code
      ? new ExtensionError(code).message
      : "Não foi possível concluir a preparação. Confira o catálogo e faça um novo pedido.";
  }
  const result = tradeResult(row.result);
  const affected =
    row.kind === "update" || row.kind === "revert"
      ? (result.organizations_active ?? null)
      : row.kind === "removal"
        ? (result.organizations_disabled_count ?? null)
        : null;
  return {
    id: row.id,
    organization_id: row.organization_id,
    actor_id: row.actor_id,
    kind: row.kind,
    status: row.status,
    catalog_id: row.catalog_id,
    installation_id: row.installation_id,
    publisher: row.publisher,
    name: row.name,
    version: row.version,
    error_code: row.error_code,
    error_message: message,
    from_revision: result.from_revision ?? null,
    from_version: result.from_version ?? null,
    to_version: result.to_version ?? null,
    organizations_affected: row.status === "completed" ? affected : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Leitor tolerante da lista. Um recibo gravado por uma versão MAIS NOVA do sistema (um tipo ou
 * estado que esta não conhece) sai da lista em vez de derrubar a gestão inteira. Precisa estar
 * na imagem para a qual um rollback volta; por isso nasce junto com os tipos novos.
 */
function readableOperations(rows: unknown[]): ExtensionOperationView[] {
  return rows.flatMap((value) => {
    const identity = z.object({ id: uuid, kind: z.unknown(), status: z.unknown() }).parse(value);
    if (!ehTipoDeOperacao(identity.kind) || !ehEstadoDeOperacao(identity.status)) {
      logger.warn("[extensions] recibo de versão mais nova", { operation_id: identity.id });
      return [];
    }
    return [operationView(value)];
  });
}

const OP_COLS =
  "id,kind,status,actor_id,organization_id,catalog_id,installation_id,publisher,name,version,entry,result,error_code,created_at,updated_at";
const CATALOG_COLS = "id,origin,revision,digest,snapshot,admitted_at";
const INSTALL_COLS =
  "id,catalog_id,artifact_id,previous_artifact_id,publisher,name,version,revision,removed_at";
const ARTIFACT_COLS = "id,sha256,byte_length,manifest,document";
const BINDING_COLS =
  "organization_id,installation_id,enabled,configuration,revision,deactivated_by_removal_at";

/**
 * Leitura por lista de ids em lotes. O filtro `in` vai na URL do PostgREST; 256 uuids passam de
 * 9 KB e esbarram no limite de linha de requisição de proxies comuns.
 */
const IN_BATCH = 64;
/**
 * Pares publicador/nome por consulta de removidas. Com slugs de até 64 caracteres, 16 pares cabem
 * em menos de 3 KB de URL.
 */
const IDENTITY_BATCH = 16;
type DbRead = { data: unknown; error: { code?: string; message?: string } | null };
async function readInBatches(
  ids: readonly string[],
  read: (batch: string[]) => PromiseLike<DbRead>,
): Promise<unknown[]> {
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += IN_BATCH) {
    batches.push(unique.slice(index, index + IN_BATCH));
  }
  const results = await Promise.all(batches.map((batch) => read(batch)));
  return results.flatMap((result) => {
    dbFailure(result.error);
    return (result.data as unknown[] | null) ?? [];
  });
}

function admittedManifest(value: z.infer<typeof artifactRowSchema>): ExtensionManifest {
  const leitura = lerManifestoAdmitido(value);
  if (leitura.ok) return leitura.manifest;
  if (leitura.code === "extension_storage_failed") {
    throw new ExtensionServiceError(
      "extension_storage_failed",
      "O pacote local precisa ser conferido pelo administrador da instalação.",
      503,
    );
  }
  throw new ExtensionError(leitura.code);
}

/** Snapshot que esta versão já não sabe ler some do catálogo, e não da gestão inteira. */
function entradasLegiveis(row: z.infer<typeof catalogRowSchema>): CatalogEntry[] {
  try {
    return validateCatalogSnapshot(row.snapshot).entries;
  } catch (error) {
    if (!(error instanceof ExtensionError)) throw error;
    logger.warn("[extensions] catálogo admitido ilegível nesta versão", {
      catalog_id: row.id,
      error_code: error.code,
    });
    return [];
  }
}

/**
 * Quem administra a instalação vê e faz as ações de plataforma. Negado e "não deu para conferir"
 * são respostas diferentes: tratar a falha da conferência como negação rebaixava a gestão para a
 * de um membro comum sem erro visível, e a leitura de um recibo de plataforma virava 404, que a
 * tela lê como "recibo inexistente" e apaga.
 */
export async function canManageInstallation(user: AuthUser): Promise<boolean> {
  if (!user.is_platform_admin || user.support) return false;
  const check = await requireExtensionPlatformFor(user);
  if (check.ok) return true;
  if (check.response.status >= 500) {
    throw new ExtensionServiceError(
      "upstream_unavailable",
      "Não foi possível confirmar a permissão de acesso.",
      503,
    );
  }
  return false;
}

/** Instância é lida pelo gestor autorizado; vínculos usam RLS e org explícita. */
export async function listExtensions(user: AuthUser, org: ActiveOrg): Promise<ExtensionListView> {
  const canInstall = await canManageInstallation(user);
  const admin = createAdminClient();
  const session = await createClient();
  const operations = admin.from("extension_operations").select(OP_COLS);
  const scoped = canInstall
    ? operations.or(`organization_id.eq.${org.orgId},organization_id.is.null`)
    : operations.eq("organization_id", org.orgId);
  const none: DbRead = { data: [], error: null };
  const [
    catalogResult,
    installationResult,
    operationResult,
    preparingResult,
    countResult,
  ] = await Promise.all([
    admin
      .from("extension_catalogs")
      .select(CATALOG_COLS)
      .order("admitted_at", { ascending: false })
      .limit(8),
    // Removidas filtradas NO BANCO, antes do limite: senão o acúmulo de removidas empurra as
    // vigentes para fora da lista.
    admin
      .from("extension_installations")
      .select(INSTALL_COLS)
      .is("removed_at", null)
      .order("installed_at")
      .limit(128),
    scoped.neq("status", "preparing").order("created_at", { ascending: false }).limit(50),
    canInstall
      ? admin
          .from("extension_operations")
          .select(OP_COLS)
          .is("organization_id", null)
          .eq("status", "preparing")
          .order("created_at", { ascending: false })
          .limit(128)
      : Promise.resolve(none),
    // Exceção declarada na spec à regra "service role filtra organization_id": a contagem
    // atravessa organizações, e por isso devolve só números, e só a quem administra a instalação.
    canInstall
      ? admin.rpc("fn_extensions_installation_counts", { p_actor: user.id })
      : Promise.resolve(none),
  ]);
  for (const result of [
    catalogResult,
    installationResult,
    operationResult,
    preparingResult,
    countResult,
  ]) {
    dbFailure(result.error);
  }
  const catalogs = z.array(catalogRowSchema).parse(catalogResult.data ?? []);
  const installations = z.array(installationRowSchema).parse(installationResult.data ?? []);
  // Vínculos desta organização que a remoção desligou e cuja instalação continua removida: dão o
  // card "Removida". As ativas saem NO BANCO, antes do limite: filtradas depois, as reinstaladas
  // ocupavam o corte e escondiam removidas mais antigas. O limite de 128 cards fica declarado na
  // spec. (Até 128 ids ativos cabem na URL do PostgREST.)
  // O PostgREST não aceita `in` com lista vazia; o UUID nulo não é id de nenhuma instalação.
  const activeIds = installations.length
    ? installations.map((item) => item.id)
    : ["00000000-0000-0000-0000-000000000000"];
  const markedResult = await session
    .from("organization_extensions")
    .select("installation_id")
    .eq("organization_id", org.orgId)
    .not("deactivated_by_removal_at", "is", null)
    .not("installation_id", "in", `(${activeIds.join(",")})`)
    .order("deactivated_by_removal_at", { ascending: false })
    .limit(128);
  dbFailure(markedResult.error);
  const markedIds = z
    .array(z.object({ installation_id: uuid }))
    .parse(markedResult.data ?? [])
    .map((item) => item.installation_id);
  const removedForOrganization = z.array(installationRowSchema).parse(
    await readInBatches(markedIds, (batch) =>
      admin
        .from("extension_installations")
        .select(INSTALL_COLS)
        .in("id", batch)
        .not("removed_at", "is", null),
    ),
  );
  const rows = [...installations, ...removedForOrganization];
  const previousIds = canInstall
    ? installations.flatMap((item) => (item.previous_artifact_id ? [item.previous_artifact_id] : []))
    : [];
  // Artefatos por id, e não um `limit` cego: com o acúmulo de versões ele deixava de fora
  // justamente os vigentes, que apareciam como "pacote ilegível".
  const [artifactRows, bindingRows] = await Promise.all([
    readInBatches([...rows.map((item) => item.artifact_id), ...previousIds], (batch) =>
      admin.from("extension_artifacts").select(ARTIFACT_COLS).in("id", batch),
    ),
    readInBatches(
      rows.map((item) => item.id),
      (batch) =>
        session
          .from("organization_extensions")
          .select(BINDING_COLS)
          .eq("organization_id", org.orgId)
          .in("installation_id", batch),
    ),
  ]);
  const artifacts = new Map(
    z
      .array(artifactRowSchema)
      .parse(artifactRows)
      .map((item) => [item.id, item]),
  );
  const bindings = new Map(
    z
      .array(bindingRowSchema)
      .parse(bindingRows)
      .map((item) => [item.installation_id, item]),
  );
  const counts = new Map(
    z
      .array(countRowSchema)
      .parse(countResult.data ?? [])
      .map((item) => [item.installation_id, item]),
  );
  const catalogEntries = new Map(catalogs.map((row) => [row.id, entradasLegiveis(row)]));
  // Removidas das identidades que os catálogos admitidos listam, e não "as 128 mais recentes":
  // uma removida fora desse corte aparecia como nunca instalada, a tela pedia a instalação com
  // revisão nula, e o banco respondia "mudou em outra sessão" para sempre. A consulta é por PARES
  // exatos (publicador e nome juntos), sem repetir a identidade de cada versão do catálogo: cada
  // lote traz no máximo uma linha por par, longe do corte de linhas do PostgREST, e nenhuma
  // removida sai duas vezes.
  const identityBatches = canInstall
    ? [...catalogEntries].flatMap(([catalogId, entries]) => {
        const pairs = [
          ...new Map(entries.map((entry) => [`${entry.publisher}/${entry.name}`, entry])).values(),
        ];
        const batches: Array<{ catalogId: string; pairs: CatalogEntry[] }> = [];
        for (let index = 0; index < pairs.length; index += IDENTITY_BATCH) {
          batches.push({ catalogId, pairs: pairs.slice(index, index + IDENTITY_BATCH) });
        }
        return batches;
      })
    : [];
  // No máximo quatro consultas por vez: o caso comum é uma ou duas, e o pior (8 catálogos cheios)
  // não pode disparar dezenas de requisições simultâneas numa VPS pequena.
  const removedResults: DbRead[] = [];
  for (let index = 0; index < identityBatches.length; index += 4) {
    removedResults.push(
      ...(await Promise.all(
        identityBatches.slice(index, index + 4).map(({ catalogId, pairs }) =>
          admin
            .from("extension_installations")
            .select(INSTALL_COLS)
            .eq("catalog_id", catalogId)
            .not("removed_at", "is", null)
            // Publicador e nome são slugs ([a-z0-9-]): não precisam de escape no filtro.
            .or(
              pairs.map((pair) => `and(publisher.eq.${pair.publisher},name.eq.${pair.name})`).join(","),
            ),
        ),
      )),
    );
  }
  const removed = [
    ...new Map(
      removedResults
        .flatMap((result) => {
          dbFailure(result.error);
          return z.array(installationRowSchema).parse(result.data ?? []);
        })
        .map((item) => [item.id, item]),
    ).values(),
  ];

  const views: InstalledExtensionView[] = rows.map((item) => {
    const view = montarInstalada({
      item,
      artifact: artifacts.get(item.artifact_id),
      catalog: catalogs.find((source) => source.id === item.catalog_id),
      binding: bindings.get(item.id),
      previous:
        canInstall && item.previous_artifact_id
          ? montarAnterior(
              artifacts.get(item.previous_artifact_id),
              item,
              catalogEntries.get(item.catalog_id) ?? [],
            )
          : null,
      activeOrganizations: canInstall ? (counts.get(item.id)?.active_organizations ?? 0) : null,
    });
    if (view.compatibility_reason === MOTIVO_PACOTE_ILEGIVEL) {
      // Registra a identidade, nunca o conteúdo do pacote.
      logger.warn("[extensions] pacote instalado ilegível nesta versão", {
        installation_id: item.id,
      });
    }
    return view;
  });
  return {
    organization_id: org.orgId,
    can_manage: org.role === "admin" && !user.support,
    can_install: canInstall,
    catalogs: catalogs.map((row) => ({
      id: row.id,
      origin: row.origin,
      revision: row.revision,
      admitted_at: row.admitted_at,
      entries: catalogEntries.get(row.id) ?? [],
    })),
    installations: views,
    removed_installations: removed.map((item) => ({
      id: item.id,
      catalog_id: item.catalog_id,
      publisher: item.publisher,
      name: item.name,
      version: item.version,
      revision: item.revision,
      removed_at: item.removed_at ?? "",
      awaiting_reactivation: counts.get(item.id)?.awaiting_reactivation ?? 0,
    })),
    operations: readableOperations([
      ...((preparingResult.data as unknown[] | null) ?? []),
      ...((operationResult.data as unknown[] | null) ?? []),
    ]),
  };
}

/** O único caminho de conteúdo instalado consulta estado local; não acessa catálogo remoto. */
export async function loadExtensionGuide(
  organizationId: string,
  installationId: string,
): Promise<ExtensionGuideView> {
  const admin = createAdminClient();
  // A instalação ANTES do vínculo: removida, a organização precisa ouvir "removeu de todas as
  // organizações", e não "desativada nesta organização", que manda procurar quem ativa.
  const installed = await admin
    .from("extension_installations")
    .select(INSTALL_COLS)
    .eq("id", installationId)
    .maybeSingle();
  dbFailure(installed.error);
  const installation = installationRowSchema.nullable().parse(installed.data);
  if (!installation) throw serviceError("extension_installation_not_found");
  if (installation.removed_at) throw serviceError("extension_removed");
  const session = await createClient();
  const bindingResult = await session
    .from("organization_extensions")
    .select(BINDING_COLS)
    .eq("organization_id", organizationId)
    .eq("installation_id", installationId)
    .maybeSingle();
  dbFailure(bindingResult.error);
  const binding = bindingRowSchema.nullable().parse(bindingResult.data);
  if (!binding?.enabled)
    throw new ExtensionServiceError(
      "extension_inactive",
      "Esta extensão está desativada nesta organização. Consulte o administrador para ativá-la.",
      404,
    );
  const artifactResult = await admin
    .from("extension_artifacts")
    .select(ARTIFACT_COLS)
    .eq("id", installation.artifact_id)
    .maybeSingle();
  dbFailure(artifactResult.error);
  const artifact = artifactRowSchema.parse(artifactResult.data);
  const manifest = admittedManifest(artifact);
  if (!checkCompatibility(manifest).compatible) throw new ExtensionError("extension_incompatible");
  return {
    organization_id: organizationId,
    installation_id: installation.id,
    version: installation.version,
    manifest,
    configuration: binding.configuration,
    revision: binding.revision,
  };
}

export async function loadCrmExtensions(organizationId: string): Promise<ExtensionGuideView[]> {
  const session = await createClient();
  const result = await session
    .from("organization_extensions")
    .select("installation_id")
    .eq("organization_id", organizationId)
    .eq("enabled", true)
    .limit(8);
  dbFailure(result.error);
  const ids = z.array(z.object({ installation_id: uuid })).parse(result.data ?? []);
  const guias = await Promise.allSettled(
    ids.map((item) => loadExtensionGuide(organizationId, item.installation_id)),
  );
  // Um guia ativo que esta versão já não lê (ou cujo pacote falhou na conferência) sai
  // do hub sozinho. Antes, um só derrubava a lista e escondia todos os outros cards.
  guias.forEach((resultado, indice) => {
    if (resultado.status === "rejected") {
      const motivo = resultado.reason as { code?: unknown };
      logger.warn("[extensions] guia ativo fora do hub", {
        installation_id: ids[indice]!.installation_id,
        error_code: typeof motivo?.code === "string" ? motivo.code : null,
      });
    }
  });
  const lidos = guias.flatMap((resultado) =>
    resultado.status === "fulfilled" ? [resultado.value] : [],
  );
  if (ids.length > 0 && lidos.length === 0) {
    // Nenhum dos ativos pôde ser lido: é falha, não lista vazia, e o hub precisa distinguir.
    throw (guias[0] as PromiseRejectedResult).reason;
  }
  return lidos;
}

export async function readExtensionOperation(
  operationId: string,
  organizationId: string | null,
  platform: boolean,
): Promise<ExtensionOperationView> {
  const admin = createAdminClient();
  let query = admin.from("extension_operations").select(OP_COLS).eq("id", operationId);
  if (platform) {
    // Quem administra a instalação lê recibos da plataforma e os da organização ativa, como na
    // lista; nunca o de outra organização, que nenhuma tela desta sessão tem como consumir.
    query = organizationId
      ? query.or(`organization_id.eq.${organizationId},organization_id.is.null`)
      : query.is("organization_id", null);
  } else {
    if (!organizationId)
      throw new ExtensionServiceError(
        "extension_operation_not_found",
        "Pedido não encontrado.",
        404,
      );
    query = query.eq("organization_id", organizationId);
  }
  const result = await query.maybeSingle();
  dbFailure(result.error);
  if (!result.data)
    throw new ExtensionServiceError("extension_operation_not_found", "Pedido não encontrado.", 404);
  const [operation] = readableOperations([result.data]);
  if (!operation) {
    throw new ExtensionServiceError(
      "extension_operation_unreadable",
      "Este pedido foi registrado por uma versão mais nova do sistema.",
      409,
    );
  }
  return operation;
}

export async function admitExtensionCatalog(
  actorId: string,
  operationId: string,
  bytes: Uint8Array,
): Promise<ExtensionOperationView> {
  const snapshot = parseCatalog(bytes);
  assertCatalogOrigin(snapshot.origin, {
    localCatalogOrigin: env.EXTENSIONS_LOCAL_CATALOG_ORIGIN || null,
    appUrl: env.NEXT_PUBLIC_APP_URL,
  });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const result = await createAdminClient().rpc("fn_extensions_admit_catalog", {
    p_actor: actorId,
    p_operation: operationId,
    p_snapshot: snapshot,
    p_digest: digest,
  });
  dbFailure(result.error);
  const operation = operationView(result.data);
  if (appliedSchema.parse(result.data).applied_now) {
    await audit({
      action: "extension.catalog_admitted",
      actorUserId: actorId,
      actingAsPlatformAdmin: true,
      resourceType: "extension_catalog",
      resourceId: operation.catalog_id,
      metadata: { operation_id: operation.id, revision: snapshot.revision, digest },
    });
  }
  return operation;
}

export interface InstallExtensionRequest {
  catalog_id: string;
  publisher: string;
  name: string;
  version: string;
  /** Revisão da instalação que a tela exibiu; `null` quando não havia linha para a identidade. */
  expected_installation_revision: number | null;
}

/** Instalar, atualizar, trocar para versão menor e reinstalar: o recibo diz qual foi. */
export async function installExtension(
  actorId: string,
  operationId: string,
  input: InstallExtensionRequest,
): Promise<ExtensionOperationView> {
  const admin = createAdminClient();
  const prepared = await admin.rpc("fn_extensions_prepare_install", {
    p_actor: actorId,
    p_operation: operationId,
    p_catalog: input.catalog_id,
    p_publisher: input.publisher,
    p_name: input.name,
    p_version: input.version,
    p_expected_installation_revision: input.expected_installation_revision,
  });
  dbFailure(prepared.error);
  const receipt = operationRowSchema.parse(prepared.data);
  if (receipt.status !== "preparing") return operationView(receipt);
  const isUpdate = receipt.kind === "update";
  const from = tradeResult(receipt.result);

  const source = await admin
    .from("extension_catalogs")
    .select(CATALOG_COLS)
    .eq("id", input.catalog_id)
    .single();
  dbFailure(source.error);
  const catalog = catalogRowSchema.parse(source.data);
  // Entry vem do recibo preparado, não do pedido nem de uma segunda descoberta remota.
  const snapshot = validateCatalogSnapshot({
    format_version: 1,
    origin: catalog.origin,
    revision: catalog.revision,
    entries: [receipt.entry],
  });
  const entry: CatalogEntry = snapshot.entries[0]!;
  let bytes: Uint8Array;
  let manifest: ExtensionManifest;
  try {
    if (
      !checkCompatibility({
        format_version: 1,
        profile: "declarative",
        host_api: entry.host_api,
        permissions: entry.permissions,
        dependencies: [],
      }).compatible
    )
      throw new ExtensionError("extension_incompatible");
    bytes = await downloadArtifact(catalog.origin, entry, {
      localCatalogOrigin: env.EXTENSIONS_LOCAL_CATALOG_ORIGIN || null,
      appUrl: env.NEXT_PUBLIC_APP_URL,
    });
    manifest = await validateArtifact(bytes, entry);
    if (!checkCompatibility(manifest).compatible)
      throw new ExtensionError("extension_incompatible");
  } catch (error) {
    if (!(error instanceof ExtensionError)) throw error;
    // O recibo guarda só o código estável; o porquê operacional (status HTTP, erro de
    // rede) ia embora aqui. Vai a log e à auditoria, sem texto remoto nem do pacote.
    const causa = causaSegura(error);
    logger.warn("[extensions] instalação falhou", {
      operation_id: operationId,
      catalog_id: input.catalog_id,
      kind: receipt.kind,
      error_code: error.code,
      ...causa,
    });
    const failed = await admin.rpc("fn_extensions_fail_install", {
      p_actor: actorId,
      p_operation: operationId,
      p_error_code: error.code,
    });
    dbFailure(failed.error);
    const falha = operationView(failed.data);
    if (appliedSchema.parse(failed.data).applied_now) {
      await audit({
        action: isUpdate ? "extension.update_failed" : "extension.install_failed",
        actorUserId: actorId,
        actingAsPlatformAdmin: true,
        resourceType: "extension_operation",
        resourceId: falha.id,
        metadata: {
          operation_id: falha.id,
          error_code: error.code,
          catalog_id: input.catalog_id,
          publisher: entry.publisher,
          name: entry.name,
          version: entry.version,
          ...(isUpdate ? { from_version: from.from_version ?? null } : {}),
          ...causa,
        },
      });
    }
    return falha;
  }
  // Só esta transação publica. Falha de conexão daqui em diante deixa resultado
  // a reconciliar; não transforma uma confirmação possivelmente consumada em failed.
  const finished = await admin.rpc("fn_extensions_finish_install", {
    p_actor: actorId,
    p_operation: operationId,
    p_manifest: manifest,
    p_sha256: createHash("sha256").update(bytes).digest("hex"),
    p_byte_length: bytes.byteLength,
    p_document: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  });
  dbFailure(finished.error);
  const operation = operationView(finished.data);
  if (appliedSchema.parse(finished.data).applied_now) {
    await audit(
      operation.kind === "update"
        ? {
            action: "extension.updated",
            actorUserId: actorId,
            actingAsPlatformAdmin: true,
            resourceType: "extension_installation",
            resourceId: operation.installation_id,
            metadata: {
              operation_id: operation.id,
              from_version: operation.from_version,
              to_version: operation.to_version,
              digest: entry.sha256,
              organizations_active: operation.organizations_affected,
            },
          }
        : {
            action: "extension.installed",
            actorUserId: actorId,
            actingAsPlatformAdmin: true,
            resourceType: "extension_installation",
            resourceId: operation.installation_id,
            metadata: { operation_id: operation.id, version: entry.version, digest: entry.sha256 },
          },
    );
  }
  return operation;
}

export async function cancelExtensionInstall(
  actorId: string,
  operationId: string,
): Promise<ExtensionOperationView> {
  const result = await createAdminClient().rpc("fn_extensions_cancel_install", {
    p_actor: actorId,
    p_operation: operationId,
  });
  dbFailure(result.error);
  const operation = operationView(result.data);
  if (appliedSchema.parse(result.data).applied_now) {
    await audit({
      action: "extension.preparation_cancelled",
      actorUserId: actorId,
      actingAsPlatformAdmin: true,
      resourceType: "extension_operation",
      resourceId: operation.id,
      metadata: { operation_id: operation.id, kind: operation.kind },
    });
  }
  return operation;
}

/**
 * Desfazer a última troca. A compatibilidade da versão de destino é conferida aqui, antes da
 * RPC, sobre a revisão que o pedido traz: a RPC exige a mesma revisão sob a trava, então o
 * anterior conferido é o que será aplicado. Um pedido repetido (mesma chave) vai direto à RPC,
 * que devolve o recibo original.
 */
export async function revertExtension(
  actorId: string,
  operationId: string,
  installationId: string,
  input: { expected_installation_revision: number },
): Promise<ExtensionOperationView> {
  const admin = createAdminClient();
  const existing = await admin
    .from("extension_operations")
    .select("id")
    .eq("id", operationId)
    .maybeSingle();
  dbFailure(existing.error);
  if (!existing.data) {
    const installed = await admin
      .from("extension_installations")
      .select(INSTALL_COLS)
      .eq("id", installationId)
      .maybeSingle();
    dbFailure(installed.error);
    const installation = installationRowSchema.nullable().parse(installed.data);
    // Sem linha, removida, revisão divergente ou sem anterior: a RPC dá o código certo, na ordem
    // certa (inclusive "sistema em atualização" antes de tudo).
    if (
      installation &&
      !installation.removed_at &&
      installation.revision === input.expected_installation_revision &&
      installation.previous_artifact_id
    ) {
      const artifact = await admin
        .from("extension_artifacts")
        .select(ARTIFACT_COLS)
        .eq("id", installation.previous_artifact_id)
        .single();
      dbFailure(artifact.error);
      if (!checkCompatibility(admittedManifest(artifactRowSchema.parse(artifact.data))).compatible) {
        throw new ExtensionError("extension_incompatible");
      }
    }
  }
  const result = await admin.rpc("fn_extensions_revert_install", {
    p_actor: actorId,
    p_operation: operationId,
    p_installation: installationId,
    p_expected_installation_revision: input.expected_installation_revision,
  });
  dbFailure(result.error);
  const operation = operationView(result.data);
  if (appliedSchema.parse(result.data).applied_now) {
    await audit({
      action: "extension.reverted",
      actorUserId: actorId,
      actingAsPlatformAdmin: true,
      resourceType: "extension_installation",
      resourceId: installationId,
      metadata: {
        operation_id: operation.id,
        from_version: operation.from_version,
        to_version: operation.to_version,
        organizations_active: operation.organizations_affected,
      },
    });
  }
  return operation;
}

/**
 * Remover da instalação. Além do registro da instância, cada organização desligada recebe a
 * própria linha `extension.deactivated_by_removal`, separada da desativação que a própria organização faz: é por ela que `/app/audit` da organização
 * explica por que o guia sumiu. Nenhuma linha numa repetição idempotente.
 */
export async function removeExtension(
  actorId: string,
  operationId: string,
  installationId: string,
  input: { expected_installation_revision: number },
): Promise<ExtensionOperationView> {
  const result = await createAdminClient().rpc("fn_extensions_remove_installation", {
    p_actor: actorId,
    p_operation: operationId,
    p_installation: installationId,
    p_expected_installation_revision: input.expected_installation_revision,
  });
  dbFailure(result.error);
  const operation = operationView(result.data);
  if (appliedSchema.parse(result.data).applied_now) {
    const row = operationRowSchema.parse(result.data);
    const disabled = tradeResult(row.result).organizations_disabled ?? [];
    await audit({
      action: "extension.removed",
      actorUserId: actorId,
      actingAsPlatformAdmin: true,
      resourceType: "extension_installation",
      resourceId: installationId,
      metadata: {
        operation_id: operation.id,
        version: operation.version,
        organizations_disabled_count: disabled.length,
      },
    });
    await auditForOrganizations(
      {
        action: "extension.deactivated_by_removal",
        actorUserId: actorId,
        actingAsPlatformAdmin: true,
        resourceType: "extension_installation",
        resourceId: installationId,
        metadata: { operation_id: operation.id, reason: "installation_removed" },
      },
      disabled,
    );
  }
  return operation;
}

export async function configureExtension(
  actorId: string,
  organizationId: string,
  installationId: string,
  operationId: string,
  input: { expected_revision: number; enabled: boolean; configuration: ExtensionConfiguration },
): Promise<ExtensionOperationView> {
  const admin = createAdminClient();
  // A ativação usa o mesmo contrato de leitura/instalação antes da mutação.
  if (input.enabled) {
    const result = await admin
      .from("extension_installations")
      .select("artifact_id,removed_at")
      .eq("id", installationId)
      .maybeSingle();
    dbFailure(result.error);
    const installed = z
      .object({ artifact_id: uuid, removed_at: z.string().nullable() })
      .nullable()
      .parse(result.data);
    if (!installed) throw serviceError("extension_installation_not_found");
    // Removida: a RPC recusa com `extension_removed` (ou devolve o recibo de uma repetição);
    // conferir a compatibilidade antes daria o motivo errado.
    if (!installed.removed_at) {
      const artifact = await admin
        .from("extension_artifacts")
        .select(ARTIFACT_COLS)
        .eq("id", installed.artifact_id)
        .single();
      dbFailure(artifact.error);
      if (
        !checkCompatibility(admittedManifest(artifactRowSchema.parse(artifact.data))).compatible
      ) {
        throw new ExtensionError("extension_incompatible");
      }
    }
  }
  const result = await admin.rpc("fn_extensions_configure", {
    p_actor: actorId,
    p_organization: organizationId,
    p_installation: installationId,
    p_operation: operationId,
    p_expected_revision: input.expected_revision,
    p_enabled: input.enabled,
    p_configuration: input.configuration,
  });
  dbFailure(result.error);
  const operation = operationView(result.data);
  if (appliedSchema.parse(result.data).applied_now) {
    await audit({
      action: input.enabled ? "extension.configured" : "extension.deactivated",
      actorUserId: actorId,
      organizationId,
      resourceType: "extension_installation",
      resourceId: installationId,
      metadata: {
        operation_id: operation.id,
        expected_revision: input.expected_revision,
        enabled: input.enabled,
      },
    });
  }
  return operation;
}
