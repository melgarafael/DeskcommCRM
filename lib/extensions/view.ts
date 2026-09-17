/** Contrato de apresentação; não importa cliente de banco nem configuração do servidor. */
import type { CatalogEntry, ExtensionConfiguration, ExtensionManifest } from "./manifest";
import type { ExtensionOperationKind, ExtensionOperationStatus } from "./vocabulario";

export interface ExtensionOperationView {
  id: string;
  organization_id: string | null;
  /** Quem fez o pedido. Só essa pessoa retoma uma preparação: o pedido e a conclusão levam o ator. */
  actor_id: string | null;
  kind: ExtensionOperationKind;
  status: ExtensionOperationStatus;
  catalog_id: string | null;
  installation_id: string | null;
  publisher: string | null;
  name: string | null;
  version: string | null;
  error_code: string | null;
  error_message: string | null;
  /** Revisão da instalação que a troca encontrou; é a precondição para retomar uma atualização. */
  from_revision: number | null;
  from_version: string | null;
  to_version: string | null;
  /** Atualizar e desfazer: organizações com a extensão ativa. Remover: organizações desligadas. */
  organizations_affected: number | null;
  created_at: string;
  updated_at: string;
}

/** A versão para a qual "Desfazer a última troca" volta. Só quem administra a instalação a vê. */
export interface PreviousVersionView {
  version: string;
  compatible: boolean;
  compatibility_reason: string | null;
  /** A revisão admitida do catálogo ainda lista estes bytes. Informação, não recusa. */
  in_catalog: boolean;
}

export interface InstalledExtensionView {
  id: string;
  catalog_id: string;
  origin: string;
  publisher: string;
  name: string;
  version: string;
  display: ExtensionManifest["display"];
  permissions: ExtensionManifest["permissions"];
  enabled: boolean;
  /** Revisão do VÍNCULO desta organização (a precondição de configurar). */
  revision: number;
  configuration: ExtensionConfiguration;
  compatible: boolean;
  compatibility_reason: string | null;
  /** Revisão da INSTALAÇÃO (a precondição de atualizar, desfazer e remover). */
  installation_revision: number;
  previous: PreviousVersionView | null;
  /** Organizações com a extensão ativa; `null` para quem não administra a instalação. */
  active_organizations: number | null;
  /** Preenchido quando a instalação foi removida e esta organização a usava. */
  removed_at: string | null;
  /** O vínculo desta organização foi desligado pela remoção e ainda não foi reativado. */
  deactivated_by_removal_at: string | null;
}

export interface RemovedInstallationView {
  id: string;
  catalog_id: string;
  publisher: string;
  name: string;
  version: string;
  revision: number;
  removed_at: string;
  /** Organizações desligadas pela remoção que ainda não ativaram de novo. */
  awaiting_reactivation: number;
}

export interface ExtensionListView {
  organization_id: string;
  can_manage: boolean;
  can_install: boolean;
  catalogs: Array<{
    id: string;
    origin: string;
    revision: number;
    admitted_at: string;
    entries: CatalogEntry[];
  }>;
  installations: InstalledExtensionView[];
  /** Vazio para quem não administra a instalação. */
  removed_installations: RemovedInstallationView[];
  operations: ExtensionOperationView[];
}

export interface ExtensionGuideView {
  organization_id: string;
  installation_id: string;
  version: string;
  manifest: ExtensionManifest;
  configuration: ExtensionConfiguration;
  revision: number;
}
