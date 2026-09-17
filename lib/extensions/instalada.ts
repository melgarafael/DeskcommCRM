import { createHash } from "node:crypto";

import { ExtensionError, type ExtensionErrorCode } from "./errors";
import {
  checkCompatibility,
  parseManifest,
  type CatalogEntry,
  type ExtensionConfiguration,
  type ExtensionManifest,
} from "./manifest";
import type { InstalledExtensionView, PreviousVersionView } from "./view";

export const MOTIVO_API_INCOMPATIVEL =
  "Esta extensão não é compatível com a API disponível nesta instalação.";
export const MOTIVO_PACOTE_ILEGIVEL =
  "O pacote gravado não pôde ser conferido por esta versão do CRM.";

type ArtefatoGravado = { sha256: string; byte_length: number; document: string };
type Leitura =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; code: "extension_storage_failed" | ExtensionErrorCode };

/**
 * Relê o documento admitido: confere tamanho e hash gravados e revalida o manifesto pelo
 * contrato DESTA versão. Devolve o motivo em vez de lançar, porque quem lê uma lista não
 * pode deixar um pacote derrubar os outros.
 */
export function lerManifestoAdmitido(artefato: ArtefatoGravado): Leitura {
  const bytes = new TextEncoder().encode(artefato.document);
  if (
    bytes.byteLength !== artefato.byte_length ||
    createHash("sha256").update(bytes).digest("hex") !== artefato.sha256
  ) {
    return { ok: false, code: "extension_storage_failed" };
  }
  try {
    return { ok: true, manifest: parseManifest(bytes) };
  } catch (error) {
    if (error instanceof ExtensionError) return { ok: false, code: error.code };
    throw error;
  }
}

/**
 * A versão para a qual "Desfazer a última troca" volta. A versão vem do manifesto gravado mesmo
 * quando esta versão do CRM já não o lê: sem ela, a tela não diria para onde a troca voltaria.
 * Um anterior ilegível ou incompatível aparece com o motivo, e o botão fica desabilitado.
 */
export function montarAnterior(
  artefato: (ArtefatoGravado & { manifest: unknown }) | undefined,
  identidade: { publisher: string; name: string },
  entradas: readonly CatalogEntry[],
): PreviousVersionView {
  const gravado = artefato?.manifest as { version?: unknown } | null | undefined;
  const version = typeof gravado?.version === "string" ? gravado.version : "";
  const leitura = artefato ? lerManifestoAdmitido(artefato) : null;
  const compatibilidade = leitura?.ok ? checkCompatibility(leitura.manifest) : null;
  return {
    version,
    compatible: compatibilidade?.compatible ?? false,
    compatibility_reason: !compatibilidade
      ? MOTIVO_PACOTE_ILEGIVEL
      : compatibilidade.compatible
        ? null
        : MOTIVO_API_INCOMPATIVEL,
    in_catalog:
      !!artefato &&
      entradas.some(
        (entrada) =>
          entrada.publisher === identidade.publisher &&
          entrada.name === identidade.name &&
          entrada.version === version &&
          entrada.sha256 === artefato.sha256,
      ),
  };
}

/**
 * Uma linha da gestão. Pacote que esta versão não consegue ler — atualização do CRM que
 * estreitou o contrato, documento adulterado, artefato ausente — vira linha incompatível,
 * com o vínculo preservado. Antes, um único pacote assim derrubava a lista inteira, e com
 * ela o único lugar de onde se desativa uma extensão.
 */
export function montarInstalada({
  item,
  artifact,
  catalog,
  binding,
  previous = null,
  activeOrganizations = null,
}: {
  item: {
    id: string;
    catalog_id: string;
    publisher: string;
    name: string;
    version: string;
    revision: number;
    removed_at: string | null;
  };
  artifact: ArtefatoGravado | undefined;
  catalog: { origin: string } | undefined;
  binding:
    | {
        enabled: boolean;
        revision: number;
        configuration: ExtensionConfiguration;
        deactivated_by_removal_at: string | null;
      }
    | undefined;
  previous?: PreviousVersionView | null;
  activeOrganizations?: number | null;
}): InstalledExtensionView {
  const leitura = artifact && catalog ? lerManifestoAdmitido(artifact) : null;
  const comum = {
    id: item.id,
    catalog_id: item.catalog_id,
    origin: catalog?.origin ?? "",
    publisher: item.publisher,
    name: item.name,
    version: item.version,
    // O contrato v1 só admite esta permissão, na admissão do catálogo e no parser.
    permissions: ["navigation.tasks"] as ExtensionManifest["permissions"],
    enabled: binding?.enabled ?? false,
    revision: binding?.revision ?? 0,
    installation_revision: item.revision,
    // Instalação removida não tem troca a desfazer: voltar é reinstalar pelo catálogo.
    previous: item.removed_at ? null : previous,
    active_organizations: activeOrganizations,
    removed_at: item.removed_at,
    deactivated_by_removal_at: binding?.deactivated_by_removal_at ?? null,
  };
  if (!leitura?.ok) {
    const identidade = `${item.publisher}/${item.name}`;
    return {
      ...comum,
      display: {
        title: { "pt-BR": identidade },
        summary: { "pt-BR": `${identidade}@${item.version}` },
        category: "productivity",
        icon: "BookOpen",
      },
      configuration: binding?.configuration ?? { density: "comfortable", show_description: true },
      compatible: false,
      compatibility_reason: MOTIVO_PACOTE_ILEGIVEL,
    };
  }
  const compatibility = checkCompatibility(leitura.manifest);
  return {
    ...comum,
    display: leitura.manifest.display,
    permissions: leitura.manifest.permissions,
    configuration: binding?.configuration ?? leitura.manifest.configuration,
    compatible: compatibility.compatible,
    compatibility_reason: compatibility.compatible ? null : MOTIVO_API_INCOMPATIVEL,
  };
}
