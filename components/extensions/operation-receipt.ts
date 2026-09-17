import type { ExtensionOperationView } from "@/lib/extensions/view";
import {
  ehEstadoDeOperacao,
  ehOperacaoDaPlataforma,
  ehTipoDeOperacao,
  type ExtensionOperationKind,
} from "@/lib/extensions/vocabulario";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableCount(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

/**
 * Tipos que um mesmo pedido pode devolver. Instalar e atualizar passam pela mesma rota, e quem
 * decide entre os dois é o banco (a identidade já estava instalada ou não).
 */
export function compatibleKinds(kind: ExtensionOperationKind): readonly ExtensionOperationKind[] {
  return kind === "install" || kind === "update" ? ["install", "update"] : [kind];
}

/** Validação client-side: o cast genérico do fetch não prova o JSON recebido. */
export function parseExtensionOperationView(value: unknown): ExtensionOperationView | null {
  if (typeof value !== "object" || value === null) return null;
  const operation = value as Record<string, unknown>;
  if (
    typeof operation.id !== "string" ||
    !UUID.test(operation.id) ||
    !(typeof operation.organization_id === "string" || operation.organization_id === null) ||
    (typeof operation.organization_id === "string" && !UUID.test(operation.organization_id)) ||
    !(operation.actor_id === null || (typeof operation.actor_id === "string" && UUID.test(operation.actor_id))) ||
    !ehTipoDeOperacao(operation.kind) ||
    !ehEstadoDeOperacao(operation.status) ||
    !nullableString(operation.catalog_id) ||
    !nullableString(operation.installation_id) ||
    !nullableString(operation.publisher) ||
    !nullableString(operation.name) ||
    !nullableString(operation.version) ||
    !nullableString(operation.error_code) ||
    !nullableString(operation.error_message) ||
    !nullableCount(operation.from_revision) ||
    !nullableString(operation.from_version) ||
    !nullableString(operation.to_version) ||
    !nullableCount(operation.organizations_affected) ||
    typeof operation.created_at !== "string" ||
    typeof operation.updated_at !== "string"
  ) {
    return null;
  }
  return operation as unknown as ExtensionOperationView;
}

export function operationMatchesOrganization(
  operation: ExtensionOperationView,
  organizationId: string,
): boolean {
  // Espelho de `extension_operations_scope`: configurar é da organização; o resto, da plataforma.
  if (!ehOperacaoDaPlataforma(operation.kind)) return operation.organization_id === organizationId;
  return operation.organization_id === null;
}

export function expectedOperation(
  value: unknown,
  expected: {
    id: string;
    kinds: readonly ExtensionOperationKind[];
    organizationId: string;
  },
): ExtensionOperationView | null {
  const operation = parseExtensionOperationView(value);
  if (
    !operation ||
    operation.id !== expected.id ||
    !expected.kinds.includes(operation.kind) ||
    !operationMatchesOrganization(operation, expected.organizationId)
  ) {
    return null;
  }
  return operation;
}
