"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/hooks/i18n/useT";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import { randomId } from "@/lib/random-id";
import { ehTrocaParaVersaoMenor } from "@/lib/extensions/versao";
import type { CatalogEntry, ExtensionConfiguration } from "@/lib/extensions/manifest";
import type {
  ExtensionListView,
  ExtensionOperationView,
  InstalledExtensionView,
} from "@/lib/extensions/view";
import { ArrowsClockwise, CircleNotch, Info, PuzzlePiece, Warning } from "@/lib/ui/icons";
import { requestExtensionApi, type ExtensionApiResult } from "./api-client";
import {
  CatalogAdmission,
  CatalogExtensionCard,
  type CatalogIdentityState,
  type CategoryFilter,
  ExtensionEmptyList,
  ExtensionFilterBar,
  ExtensionLoadingState,
  matchesExtensionFilter,
} from "./ExtensionCatalog";
import { InstalledExtensionCard } from "./InstalledExtensionCard";
import {
  compatibleKinds,
  expectedOperation,
  operationMatchesOrganization,
  parseExtensionOperationView,
} from "./operation-receipt";
import { ExtensionOperations } from "./ExtensionOperations";
import {
  findPendingReceipt,
  isReceiptStorageKey,
  persistPendingReceipt,
  readPendingReceipts,
  removePendingReceipt,
  type PendingReceipt,
} from "./receipt-storage";

const CATALOG_MAX_BYTES = 512 * 1024;
const EXPECTED_ORGANIZATION_HEADER = "X-Expected-Organization-Id";

export function ExtensionsManager({
  organizationId,
  actorId,
  supportMode = false,
}: {
  organizationId: string;
  actorId: string;
  supportMode?: boolean;
}) {
  const t = useT();
  const locale = useIdioma();
  const router = useRouter();
  const [data, setData] = useState<ExtensionListView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshotFresh, setSnapshotFresh] = useState(false);
  const [storageStatus, setStorageStatus] = useState<"checking" | "ready" | "failed">("checking");
  const [pending, setPending] = useState<PendingReceipt[]>([]);
  // O aviso de "conexão caiu" é sobre UM recibo, não sobre o carregamento da tela.
  // Guardado junto do erro de carregamento, ele só sumia com uma recarga bem-sucedida
  // e continuava afirmando um pedido pendente depois que outra aba já o tinha
  // reconciliado. Aqui ele é derivado: aparece enquanto o recibo existe e some junto.
  const [uncertainReceiptId, setUncertainReceiptId] = useState<string | null>(null);
  const [configFeedback, setConfigFeedback] = useState<Record<string, string>>({});
  /** Revisão da instalação que cada card mostrava na leitura anterior (ver `esquecerMensagens`). */
  const revisoesVistas = useRef<Record<string, number>>({});
  /**
   * Alvos desta aba com pedido em voo. Era um indicador de alvo ÚNICO, e toda ação seguinte o
   * sobrescrevia: cancelar um pedido apagava o "Preparando…" de outro ainda em curso e reabria
   * o botão que o banco recusa. Uma lista comporta os pedidos simultâneos que a tela permite.
   */
  const [emVoo, setEmVoo] = useState<string[]>([]);
  const ocupado = (alvo: string): boolean => emVoo.includes(alvo);
  /** Marca o alvo e devolve quem o libera — uma ocorrência por pedido, mesmo com alvos repetidos. */
  const marcarEmVoo = useCallback((alvo: string): (() => void) => {
    setEmVoo((atual) => [...atual, alvo]);
    return () =>
      setEmVoo((atual) => {
        const indice = atual.indexOf(alvo);
        return indice < 0 ? atual : [...atual.slice(0, indice), ...atual.slice(indice + 1)];
      });
  }, []);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [catalogFile, setCatalogFile] = useState<File | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const syncPendingFromStorage = useCallback((): boolean => {
    try {
      setPending(readPendingReceipts(window.localStorage, actorId, organizationId));
      setStorageStatus("ready");
      return true;
    } catch {
      setPending([]);
      setStorageStatus("failed");
      return false;
    }
  }, [actorId, organizationId]);

  const removeStoredReceipt = useCallback(
    (receiptId: string): boolean => {
      try {
        removePendingReceipt(window.localStorage, actorId, organizationId, receiptId);
        return syncPendingFromStorage();
      } catch {
        setStorageStatus("failed");
        return false;
      }
    },
    [actorId, organizationId, syncPendingFromStorage],
  );

  /**
   * A mensagem do card vale enquanto o card for O MESMO: continua na lista e na mesma revisão da
   * instalação. Sair da lista conta como mudança — a organização cujo vínculo já estava desligado
   * NÃO vê a instalação removida (a remoção só marca vínculo ativo), então entre a remoção e a
   * reinstalação o card some, e uma regra que só comparasse revisões de quem está na lista deixaria
   * a frase antiga voltar sobre o card reinstalado.
   */
  const esquecerMensagens = useCallback((installations: InstalledExtensionView[]) => {
    const anteriores = revisoesVistas.current;
    const agora = Object.fromEntries(
      installations.map((item) => [item.id, item.installation_revision] as const),
    );
    revisoesVistas.current = agora;
    setConfigFeedback((atual) => {
      const mantidas = Object.entries(atual).filter(([id]) => agora[id] === anteriores[id]);
      return mantidas.length === Object.keys(atual).length ? atual : Object.fromEntries(mantidas);
    });
  }, []);

  const invalidateContext = useCallback(
    (message: string) => {
      // O snapshot morreu (outra organização, recibo sem contexto): as mensagens dos cards eram
      // daquele mundo. Sem isto, a frase de um salvamento feito em A reaparecia sobre o card de B.
      setConfigFeedback({});
      revisoesVistas.current = {};
      setData(null);
      setSnapshotFresh(false);
      setLoading(false);
      setLoadError(t(message));
      router.refresh();
    },
    [router, t],
  );

  const carregar = useCallback(
    async (quiet = false) => {
      const sequence = ++requestSequence.current;
      const requestedOrganization = organizationId;
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      setSnapshotFresh(false);
      if (!quiet) setLoading(true);

      const result = await requestExtensionApi<ExtensionListView>("/api/v1/extensions", {
        headers: { [EXPECTED_ORGANIZATION_HEADER]: requestedOrganization },
        signal: controller.signal,
      });
      if (sequence !== requestSequence.current || requestedOrganization !== organizationId) {
        return false;
      }

      if (!result.ok) {
        if (controller.signal.aborted) return false;
        if (result.error.code === "extension_context_changed") {
          invalidateContext(result.error.message);
          return false;
        }
        if (result.error.code !== "connection_failed" || !controller.signal.aborted) {
          setLoadError(t(result.error.message));
          setLoading(false);
        }
        return false;
      }
      if (result.data.organization_id !== requestedOrganization) {
        invalidateContext(
          "A organização ativa mudou em outra aba. Recarregue a página antes de continuar.",
        );
        return false;
      }
      const operations = result.data.operations.map(parseExtensionOperationView);
      if (
        operations.some(
          (operation) =>
            operation === null || !operationMatchesOrganization(operation, requestedOrganization),
        )
      ) {
        invalidateContext(
          "O servidor devolveu um recibo sem o contexto esperado. Recarregue a página antes de continuar.",
        );
        return false;
      }
      const validatedOperations = operations.filter(
        (operation): operation is ExtensionOperationView => operation !== null,
      );
      const validatedData = { ...result.data, operations: validatedOperations };

      // A mensagem do card é do salvamento, não da revisão: ela sobrevive à recarga que o próprio
      // salvamento dispara (inclusive quando outra sessão desfez uma troca no meio) e é esquecida
      // quando a instalação muda de revisão entre duas leituras, o que é remover e reinstalar.
      esquecerMensagens(validatedData.installations);
      setData(validatedData);
      setLoadError(null);
      setLoading(false);
      setSnapshotFresh(true);

      const serverReceipts = new Set(validatedOperations.map((operation) => operation.id));
      if (serverReceipts.size > 0) {
        try {
          for (const receiptId of serverReceipts) {
            removePendingReceipt(window.localStorage, actorId, organizationId, receiptId);
          }
          syncPendingFromStorage();
        } catch {
          setStorageStatus("failed");
        }
      }
      return true;
    },
    [actorId, esquecerMensagens, invalidateContext, organizationId, syncPendingFromStorage, t],
  );

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      syncPendingFromStorage();
      void carregar();
    }, 0);
    const syncOtherTab = (event: StorageEvent) => {
      if (event.key === null || isReceiptStorageKey(event.key, actorId, organizationId)) {
        syncPendingFromStorage();
        // Outra aba mexeu nos recibos: enviou um pedido ou confirmou um. Nos dois casos o
        // servidor pode ter mudado, e esta aba seguia mostrando a lista de antes — medido
        // no trace da jornada: a instalação reconciliada na outra aba nunca aparecia aqui.
        void carregar(true);
      }
    };
    window.addEventListener("storage", syncOtherTab);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("storage", syncOtherTab);
      activeRequest.current?.abort();
    };
  }, [actorId, carregar, organizationId, syncPendingFromStorage]);

  useEffect(() => {
    const refresh = () => void carregar(true);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [carregar]);

  const hasPreparing = data?.operations.some((operation) => operation.status === "preparing");
  useEffect(() => {
    if (!hasPreparing) return;
    const interval = window.setInterval(() => void carregar(true), 3_000);
    return () => window.clearInterval(interval);
  }, [carregar, hasPreparing]);

  const runMutation = useCallback(
    async ({
      kind,
      label,
      targetKey,
      request,
    }: {
      kind: PendingReceipt["kind"];
      label: string;
      targetKey: string;
      request: (idempotencyKey: string) => Promise<ExtensionApiResult<unknown>>;
    }): Promise<ExtensionApiResult<ExtensionOperationView>> => {
      if (!snapshotFresh) {
        return {
          ok: false,
          status: 409,
          uncertain: false,
          error: {
            code: "extension_snapshot_stale",
            message: "Atualize o estado das extensões antes de enviar um novo pedido.",
          },
        };
      }
      if (storageStatus !== "ready") {
        return {
          ok: false,
          status: 0,
          uncertain: false,
          error: {
            code: "receipt_storage_unavailable",
            message:
              "Este navegador não conseguiu guardar o recibo. Libere o armazenamento deste site antes de enviar o pedido.",
          },
        };
      }

      let receipt: PendingReceipt;
      try {
        const current = findPendingReceipt(window.localStorage, actorId, organizationId, targetKey);
        receipt = current ?? {
          id: randomId(),
          kind,
          label,
          targetKey,
          createdAt: new Date().toISOString(),
        };
        // A confirmação síncrona precede o fetch: sem recibo durável, não há mutação.
        persistPendingReceipt(window.localStorage, actorId, organizationId, receipt);
        syncPendingFromStorage();
      } catch {
        setStorageStatus("failed");
        return {
          ok: false,
          status: 0,
          uncertain: false,
          error: {
            code: "receipt_storage_unavailable",
            message:
              "Este navegador não conseguiu guardar o recibo. Libere o armazenamento deste site antes de enviar o pedido.",
          },
        };
      }

      const liberar = marcarEmVoo(targetKey);

      // `request` não lança: `requestExtensionApi` converte queda de rede e corpo ilegível em
      // resultado. É o que permite liberar o alvo aqui, e não num `finally` sem prova.
      const result = await request(receipt.id);
      liberar();
      if (!result.ok && result.uncertain) {
        setUncertainReceiptId(receipt.id);
        return result;
      }

      if (!result.ok) {
        removeStoredReceipt(receipt.id);
        if (result.error.code === "extension_context_changed") {
          invalidateContext(result.error.message);
        }
        return result;
      }
      const confirmed = expectedOperation(result.data, {
        id: receipt.id,
        kinds: compatibleKinds(kind),
        organizationId,
      });
      if (!confirmed) {
        invalidateContext(
          "O servidor devolveu um recibo sem o contexto esperado. Recarregue a página antes de continuar.",
        );
        return {
          ok: false,
          status: 502,
          uncertain: true,
          error: {
            code: "extension_receipt_invalid",
            message:
              "O servidor devolveu um recibo sem o contexto esperado. Recarregue a página antes de continuar.",
          },
        };
      }
      if (confirmed.status !== "preparing") removeStoredReceipt(receipt.id);
      await carregar(true);
      return { ok: true, data: confirmed };
    },
    [
      actorId,
      carregar,
      invalidateContext,
      marcarEmVoo,
      organizationId,
      removeStoredReceipt,
      snapshotFresh,
      storageStatus,
      syncPendingFromStorage,
    ],
  );

  const selectCatalogFile = useCallback(
    (file: File | null) => {
      if (file && file.size > CATALOG_MAX_BYTES) {
        setCatalogFile(null);
        setCatalogError(t("O arquivo pode ter até 512 KiB. Escolha um arquivo menor."));
        return;
      }
      setCatalogFile(file);
      setCatalogError(null);
    },
    [t],
  );

  const admitCatalog = useCallback(async () => {
    if (!catalogFile) return;
    if (catalogFile.size > CATALOG_MAX_BYTES) {
      setCatalogError(t("O arquivo pode ter até 512 KiB. Escolha um arquivo menor."));
      return;
    }
    let bytes: ArrayBuffer;
    let digest: string;
    try {
      bytes = await catalogFile.arrayBuffer();
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    } catch {
      setCatalogError(
        t("Não foi possível ler este arquivo. Escolha o catálogo novamente e tente outra vez."),
      );
      return;
    }
    const result = await runMutation({
      kind: "catalog_admission",
      label: catalogFile.name,
      targetKey: `catalog:${digest}`,
      request: (idempotencyKey) =>
        requestExtensionApi("/api/v1/extensions/catalogs", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: bytes,
        }),
    });
    if (!result.ok) {
      if (!result.uncertain) toast.error(t(result.error.message));
      return;
    }
    setCatalogFile(null);
    setCatalogError(null);
    toast.success(t("Catálogo admitido e disponível para instalação."));
  }, [catalogFile, runMutation, t]);

  /**
   * A instalação mudou em outra sessão antes deste pedido: o estado da tela não vale mais. Uma
   * remoção feita em outra sessão chega como `extension_removed` (410), porque o banco confere
   * "removida" antes da revisão; sem recarregar, o card seguia oferecendo desfazer e remover.
   * Devolve `true` quando tratou o código.
   */
  const staleInstallation = useCallback(
    async (error: { code: string; message: string }): Promise<boolean> => {
      if (error.code === "extension_version_changed") {
        toast.warning(
          t("A extensão mudou em outra sessão. Recarregamos o estado atual; revise antes de repetir."),
        );
      } else if (error.code === "extension_removed" || error.code === "extension_preparation_in_progress") {
        // A preparação em curso veio de outra sessão: recarregar traz o recibo para a Atividade
        // recente, liga o acompanhamento e acende o bloqueio com o motivo.
        toast.warning(t(error.message));
      } else {
        return false;
      }
      await carregar(true);
      return true;
    },
    [carregar, t],
  );

  const install = useCallback(
    async (catalogId: string, entry: CatalogEntry, expectedInstallationRevision: number | null) => {
      // A precondição entra na chave: a mesma versão pedida sobre outra revisão é outra intenção,
      // e não pode reaproveitar o recibo pendente da anterior.
      const targetKey = `install:${catalogId}:${entry.publisher}:${entry.name}:${entry.version}:${expectedInstallationRevision ?? "none"}`;
      const reinstall =
        expectedInstallationRevision !== null &&
        (data?.removed_installations ?? []).some(
          (item) =>
            item.catalog_id === catalogId &&
            item.publisher === entry.publisher &&
            item.name === entry.name,
        );
      const result = await runMutation({
        kind: expectedInstallationRevision === null || reinstall ? "install" : "update",
        label: `${entry.publisher}/${entry.name}@${entry.version}`,
        targetKey,
        request: (idempotencyKey) =>
          requestExtensionApi("/api/v1/extensions/install", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
              catalog_id: catalogId,
              publisher: entry.publisher,
              name: entry.name,
              version: entry.version,
              expected_installation_revision: expectedInstallationRevision,
            }),
          }),
      });
      if (!result.ok) {
        if (!(await staleInstallation(result.error)) && !result.uncertain) {
          toast.error(t(result.error.message));
        }
        return;
      }
      // A rota responde 200 com o recibo em QUALQUER desfecho; o status é que diz o
      // que aconteceu. Um download que falhou (catálogo fora do ar é o caso comum)
      // chegava aqui como "Preparação iniciada" em verde.
      if (result.data.status === "failed") {
        toast.error(
          result.data.error_message
            ? t(result.data.error_message)
            : t("A instalação falhou. Veja o motivo no recibo e tente de novo."),
        );
        return;
      }
      if (result.data.status === "cancelled") {
        // Cancelado durante o download, por outro responsável ou por uma revisão nova do catálogo:
        // a rota responde 200 com o recibo cancelado, e isso não é sucesso. O motivo, quando existe
        // (catálogo readmitido), diz o próximo passo.
        toast.info(
          result.data.error_message
            ? t(result.data.error_message)
            : result.data.kind === "update"
              ? t("O pedido foi cancelado antes de concluir. A versão instalada continua a mesma.")
              : t("O pedido foi cancelado antes de concluir. Nada foi instalado."),
        );
        return;
      }
      if (result.data.status === "preparing") {
        toast.success(t("Preparação iniciada. O recibo continuará visível até a conclusão."));
      } else if (result.data.kind === "update") {
        toast.success(
          ehTrocaParaVersaoMenor(result.data)
            ? t("Versão trocada. As organizações que a usavam continuam com ela ativa.")
            : t("Extensão atualizada. As organizações que a usavam continuam com ela ativa."),
        );
      } else if (reinstall) {
        toast.success(t("Extensão reinstalada. Cada organização precisa ativá-la de novo."));
      } else {
        toast.success(t("Extensão instalada. Agora um administrador da organização pode ativá-la."));
      }
    },
    [data?.removed_installations, runMutation, staleInstallation, t],
  );

  const changeInstallation = useCallback(
    async (extension: InstalledExtensionView, action: "revert" | "remove") => {
      const kind = action === "revert" ? "revert" : "removal";
      const result = await runMutation({
        kind,
        label: `${extension.publisher}/${extension.name}@${extension.version}`,
        targetKey: `${kind}:${extension.id}:${extension.installation_revision}`,
        request: (idempotencyKey) =>
          requestExtensionApi(
            `/api/v1/extensions/${encodeURIComponent(extension.id)}/${action}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify({
                expected_installation_revision: extension.installation_revision,
              }),
            },
          ),
      });
      if (!result.ok) {
        if (!(await staleInstallation(result.error)) && !result.uncertain) {
          toast.error(t(result.error.message));
        }
        return;
      }
      toast.success(
        action === "revert"
          ? t("Troca desfeita: a versão {versao} voltou a valer em todas as organizações.").replace(
              "{versao}",
              result.data.to_version ?? result.data.version ?? "",
            )
          : t("Extensão removida de todas as organizações."),
      );
    },
    [runMutation, staleInstallation, t],
  );

  const configure = useCallback(
    async (
      extension: InstalledExtensionView,
      enabled: boolean,
      configuration: ExtensionConfiguration,
    ): Promise<{ ok: boolean; message: string }> => {
      const payload = {
        expected_revision: extension.revision,
        enabled,
        configuration,
      };
      const targetKey = `configure:${extension.id}:${JSON.stringify(payload)}`;
      const result = await runMutation({
        kind: "configure",
        label: `${extension.publisher}/${extension.name}`,
        targetKey,
        request: (idempotencyKey) =>
          requestExtensionApi(
            `/api/v1/extensions/${encodeURIComponent(extension.id)}/configuration`,
            {
              method: "PUT",
              headers: {
                "content-type": "application/json",
                "Idempotency-Key": idempotencyKey,
                [EXPECTED_ORGANIZATION_HEADER]: organizationId,
              },
              body: JSON.stringify(payload),
            },
          ),
      });
      if (!result.ok) {
        if (result.error.code === "extension_context_changed") {
          return { ok: false, message: t(result.error.message) };
        }
        // Removida em outra sessão: o formulário não pode seguir editável sobre ela. O aviso vai
        // para fora do card, porque a recarga pode tirá-lo da lista, e a mensagem do card fica
        // vazia para não reaparecer se a mesma instalação for reinstalada.
        if (result.error.code === "extension_removed") {
          toast.warning(t(result.error.message));
          await carregar(true);
          return { ok: false, message: "" };
        }
        // Só a revisão divergente é "outra pessoa alterou". Os outros 409 (o limite de
        // extensões ativas, por exemplo) têm motivo próprio, e o servidor já o escreve.
        if (result.status === 409 && result.error.code === "extension_revision_conflict") {
          await carregar(true);
          return {
            ok: false,
            message: t(
              "Outra pessoa alterou esta extensão. Recarregamos o valor atual; revise antes de salvar novamente.",
            ),
          };
        }
        return { ok: false, message: t(result.error.message) };
      }
      return { ok: true, message: t("Configuração salva.") };
    },
    [carregar, organizationId, runMutation, t],
  );

  const verifyOperation = useCallback(
    async (operation: ExtensionOperationView) => {
      const liberar = marcarEmVoo(`operation:${operation.id}`);
      let result = await requestExtensionApi<unknown>(
        `/api/v1/extensions/operations/${encodeURIComponent(operation.id)}`,
        { headers: { [EXPECTED_ORGANIZATION_HEADER]: organizationId } },
      );
      const readReceipt = result.ok
        ? expectedOperation(result.data, {
            id: operation.id,
            kinds: compatibleKinds(operation.kind),
            organizationId,
          })
        : null;
      if (result.ok && !readReceipt) {
        liberar();
        invalidateContext(
          "O servidor devolveu um recibo sem o contexto esperado. Recarregue a página antes de continuar.",
        );
        return;
      }
      if (
        readReceipt?.status === "preparing" &&
        (readReceipt.kind === "install" || readReceipt.kind === "update") &&
        readReceipt.catalog_id &&
        readReceipt.publisher &&
        readReceipt.name &&
        readReceipt.version
      ) {
        result = await requestExtensionApi<unknown>("/api/v1/extensions/install", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": readReceipt.id,
          },
          body: JSON.stringify({
            catalog_id: readReceipt.catalog_id,
            publisher: readReceipt.publisher,
            name: readReceipt.name,
            version: readReceipt.version,
            // O pedido retomado é o MESMO: a precondição é a revisão que a preparação encontrou.
            expected_installation_revision: readReceipt.from_revision,
          }),
        });
      }
      liberar();
      if (!result.ok) {
        if (result.error.code === "extension_context_changed") {
          invalidateContext(result.error.message);
          return;
        }
        if (result.uncertain) {
          setLoadError(
            t(
              "Não foi possível confirmar o resultado da verificação. Consulte o recibo antes de repetir a ação.",
            ),
          );
          await carregar(true);
        } else {
          toast.error(t(result.error.message));
        }
        return;
      }
      if (
        !expectedOperation(result.data, {
          id: operation.id,
          kinds: compatibleKinds(operation.kind),
          organizationId,
        })
      ) {
        invalidateContext(
          "O servidor devolveu um recibo sem o contexto esperado. Recarregue a página antes de continuar.",
        );
        return;
      }
      await carregar(true);
    },
    [carregar, invalidateContext, marcarEmVoo, organizationId, t],
  );

  const verifyLocalReceipt = useCallback(
    async (receipt: PendingReceipt) => {
      const liberar = marcarEmVoo(`receipt:${receipt.id}`);
      const result = await requestExtensionApi<unknown>(
        `/api/v1/extensions/operations/${encodeURIComponent(receipt.id)}`,
        { headers: { [EXPECTED_ORGANIZATION_HEADER]: organizationId } },
      );
      liberar();
      if (!result.ok) {
        if (result.error.code === "extension_context_changed") {
          invalidateContext(result.error.message);
        } else if (result.status === 404 && result.error.code === "extension_operation_not_found") {
          removeStoredReceipt(receipt.id);
          toast.info(
            t("O servidor não encontrou esse recibo. Você pode enviar o pedido novamente."),
          );
        } else {
          toast.error(t(result.error.message));
        }
        return;
      }
      if (
        !expectedOperation(result.data, {
          id: receipt.id,
          kinds: compatibleKinds(receipt.kind),
          organizationId,
        })
      ) {
        invalidateContext(
          "O servidor devolveu um recibo sem o contexto esperado. Recarregue a página antes de continuar.",
        );
        return;
      }
      removeStoredReceipt(receipt.id);
      await carregar(true);
    },
    [carregar, invalidateContext, marcarEmVoo, organizationId, removeStoredReceipt, t],
  );

  const cancelOperation = useCallback(
    async (operation: ExtensionOperationView) => {
      const liberar = marcarEmVoo(`cancel:${operation.id}`);
      const result = await requestExtensionApi<unknown>(
        `/api/v1/extensions/operations/${encodeURIComponent(operation.id)}/cancel`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": randomId(),
            [EXPECTED_ORGANIZATION_HEADER]: organizationId,
          },
        },
      );
      liberar();
      if (!result.ok) {
        if (result.error.code === "extension_context_changed") {
          invalidateContext(result.error.message);
        } else if (result.uncertain) {
          setLoadError(
            t(
              "Não foi possível confirmar o cancelamento. Verifique o recibo antes de repetir a ação.",
            ),
          );
          await carregar(true);
        } else {
          toast.error(t(result.error.message));
        }
        return;
      }
      const confirmed = expectedOperation(result.data, {
        id: operation.id,
        kinds: compatibleKinds(operation.kind),
        organizationId,
      });
      if (!confirmed) {
        invalidateContext(
          "O servidor devolveu um recibo sem o contexto esperado. Recarregue a página antes de continuar.",
        );
        return;
      }
      if (confirmed.status === "cancelled") {
        toast.success(
          confirmed.kind !== "update"
            ? t("Preparação cancelada. Este pedido não instalará a extensão.")
            : ehTrocaParaVersaoMenor(confirmed)
              ? t("Troca de versão cancelada. A versão instalada continua a mesma.")
              : t("Atualização cancelada. A versão instalada continua a mesma."),
        );
      } else if (confirmed.status === "completed") {
        toast.info(
          confirmed.kind !== "update"
            ? t("A instalação já havia sido concluída; o recibo foi atualizado.")
            : ehTrocaParaVersaoMenor(confirmed)
              ? t("A troca de versão já havia sido concluída; o recibo foi atualizado.")
              : t("A atualização já havia sido concluída; o recibo foi atualizado."),
        );
      } else if (confirmed.status === "failed") {
        toast.info(t("A preparação já havia falhado; o recibo foi atualizado."));
      }
      await carregar(true);
    },
    [carregar, invalidateContext, marcarEmVoo, organizationId, t],
  );

  /**
   * Há preparação desta identidade: um recibo `preparing` na lista OU um pedido desta aba ainda em
   * voo (o download leva até 15 s, e nesse intervalo a lista ainda não traz o recibo). A conta é
   * pelos pedidos em voo, e não pelo indicador de ocupado, que guarda um alvo só: uma segunda ação
   * na mesma aba apagava o indicador e reabria as ações que o banco recusa.
   */
  const preparando = (catalogId: string, publisher: string, name: string): boolean =>
    emVoo.some((alvo) => alvo.startsWith(`install:${catalogId}:${publisher}:${name}:`)) ||
    (data?.operations ?? []).some(
      (operation) =>
        operation.status === "preparing" &&
        operation.catalog_id === catalogId &&
        operation.publisher === publisher &&
        operation.name === name,
    );
  const installed = data?.installations ?? [];
  const catalogEntries = useMemo(
    () =>
      (data?.catalogs ?? []).flatMap((catalog) =>
        catalog.entries.map((entry) => ({ catalog, entry })),
      ),
    [data?.catalogs],
  );
  const filteredInstalled = installed.filter((extension) =>
    matchesExtensionFilter(
      extension.display,
      [extension.publisher, extension.name],
      query,
      category,
      locale,
    ),
  );
  const filteredCatalog = catalogEntries.filter(({ entry }) =>
    matchesExtensionFilter(entry.display, [entry.publisher, entry.name], query, category, locale),
  );
  const mutationBlockedReason =
    storageStatus === "failed"
      ? t(
          "Este navegador não conseguiu guardar o recibo. Libere o armazenamento deste site antes de enviar o pedido.",
        )
      : !snapshotFresh
        ? t("Atualize o estado das extensões antes de enviar um novo pedido.")
        : storageStatus === "checking"
          ? t("Aguarde enquanto os recibos deste navegador são conferidos.")
          : undefined;
  const mutationsReady = mutationBlockedReason === undefined;

  return (
    <main
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6"
      data-testid="extensions-manager"
    >
      <header className="relative overflow-hidden rounded-xl border border-border bg-surface p-5 shadow-xs sm:p-7">
        <div
          aria-hidden
          className="absolute -top-16 -right-12 h-40 w-40 rounded-full bg-accent-soft/70 blur-2xl"
        />
        <div className="relative flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-accent-200 bg-accent-soft text-accent">
            <PuzzlePiece size={24} weight="duotone" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t("Extensões")}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t(
                "Adicione guias ao CRM sem entregar dados ou executar código de terceiros. Antes de abrir Tarefas, o acesso e a ativação são conferidos novamente.",
              )}
            </p>
          </div>
        </div>
      </header>

      {loadError ? (
        <Card
          className="border-warning/40 bg-warning-bg p-4"
          role="alert"
          data-testid={data ? "extensions-stale" : "extensions-unavailable"}
        >
          <div className="flex items-start gap-3">
            <Warning size={20} weight="duotone" aria-hidden className="mt-0.5 text-warning-fg" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">
                {data
                  ? t("O estado exibido está desatualizado")
                  : t("Não foi possível confirmar o estado atual")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
              <Button className="mt-3" variant="outline" size="sm" onClick={() => void carregar()}>
                <ArrowsClockwise aria-hidden />
                {t("Tentar novamente")}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {storageStatus === "failed" ? (
        <Card className="border-error/40 bg-error-bg p-4" role="alert">
          <h2 className="text-sm font-semibold text-error-fg">
            {t("Os pedidos estão bloqueados neste navegador")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{mutationBlockedReason}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              "Libere o armazenamento do site e recarregue a página para continuar com segurança.",
            )}
          </p>
        </Card>
      ) : null}

      {pending.length > 0 ? (
        <Card className="border-info/40 bg-info-bg p-4">
          <div className="flex items-start gap-3">
            <Info size={20} weight="duotone" aria-hidden className="mt-0.5 text-info-fg" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">{t("Pedidos aguardando confirmação")}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(
                  "Os recibos abaixo foram preservados neste navegador para evitar pedidos duplicados.",
                )}
              </p>
              <div className="mt-3 space-y-2">
                {pending.map((receipt) => (
                  <div
                    key={receipt.id}
                    data-testid={`extension-local-receipt-${receipt.id}`}
                    className="flex flex-col gap-2 rounded-md border border-info/25 bg-surface/70 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {tituloDoPedido(receipt.kind, t)} · {receipt.label}
                      </p>
                      <p className="font-mono text-[11px] text-muted-foreground">{receipt.id}</p>
                      {receipt.id === uncertainReceiptId ? (
                        <p role="status" className="mt-1 text-xs text-warning-fg">
                          {t(
                            "A conexão caiu sem confirmação. O pedido foi preservado pelo recibo; verifique o estado antes de tentar outra vez.",
                          )}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid={`extension-local-receipt-verify-${receipt.id}`}
                      disabled={ocupado(`receipt:${receipt.id}`)}
                      onClick={() => void verifyLocalReceipt(receipt)}
                    >
                      {ocupado(`receipt:${receipt.id}`) ? (
                        <CircleNotch className="animate-spin" aria-hidden />
                      ) : (
                        <ArrowsClockwise aria-hidden />
                      )}
                      {t("Verificar recibo")}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {loading && !data && !loadError ? <ExtensionLoadingState /> : null}

      {data ? (
        <>
          {data.can_install ? (
            <CatalogAdmission
              file={catalogFile}
              onFile={selectCatalogFile}
              onSubmit={() => void admitCatalog()}
              busy={emVoo.some((alvo) => alvo.startsWith("catalog:"))}
              disabled={!mutationsReady}
              error={catalogError}
              blockedReason={mutationBlockedReason}
            />
          ) : null}

          <Tabs defaultValue="installed" className="space-y-5">
            <TabsList aria-label={t("Seções de extensões")}>
              <TabsTrigger value="installed">{t("Instaladas")}</TabsTrigger>
              <TabsTrigger value="catalog">{t("Catálogo")}</TabsTrigger>
            </TabsList>

            <ExtensionFilterBar
              query={query}
              category={category}
              onQueryChange={setQuery}
              onCategoryChange={setCategory}
            />

            <TabsContent value="installed" className="space-y-3">
              {filteredInstalled.length > 0 ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  {filteredInstalled.map((extension) => (
                    <InstalledExtensionCard
                      key={`${extension.id}:${extension.revision}:${extension.installation_revision}`}
                      extension={extension}
                      canManage={data.can_manage}
                      actionsDisabled={!mutationsReady}
                      manageBlockedReason={data.can_manage ? mutationBlockedReason : undefined}
                      supportMode={supportMode}
                      busy={emVoo.some((alvo) => alvo.startsWith(`configure:${extension.id}:`))}
                      // A mensagem é da revisão da instalação em que foi dada: remover e reinstalar
                      // mantêm o id e sobem a revisão, e a frase antiga não volta sobre o card novo.
                      feedback={configFeedback[extension.id] ?? null}
                      onConfigure={async (alvo, enabled, configuration) => {
                        setConfigFeedback(({ [alvo.id]: _, ...resto }) => resto);
                        const { message } = await configure(alvo, enabled, configuration);
                        setConfigFeedback((atual) => ({ ...atual, [alvo.id]: message }));
                      }}
                      canInstall={data.can_install}
                      platformBusyAction={
                        ocupado(`revert:${extension.id}:${extension.installation_revision}`)
                          ? "revert"
                          : ocupado(`removal:${extension.id}:${extension.installation_revision}`)
                            ? "remove"
                            : null
                      }
                      preparationInProgress={preparando(
                        extension.catalog_id,
                        extension.publisher,
                        extension.name,
                      )}
                      platformBlockedReason={data.can_install ? mutationBlockedReason : undefined}
                      onRevert={(alvo) => changeInstallation(alvo, "revert")}
                      onRemove={(alvo) => changeInstallation(alvo, "remove")}
                    />
                  ))}
                </div>
              ) : installed.length === 0 ? (
                <ExtensionEmptyList
                  title={t("Nenhuma extensão instalada")}
                  description={t(
                    "Quando a plataforma instalar um pacote revisado, ele aparecerá aqui para a organização decidir se ativa.",
                  )}
                />
              ) : (
                <ExtensionEmptyList
                  title={t("Nenhuma extensão corresponde à busca")}
                  description={t("Limpe a busca ou escolha outra categoria.")}
                />
              )}
            </TabsContent>

            <TabsContent value="catalog" className="space-y-3">
              {filteredCatalog.length > 0 ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  {filteredCatalog.map(({ catalog, entry }) => {
                    const identity = catalogIdentity(data, catalog.id, entry);
                    const expected =
                      identity.kind === "installed"
                        ? identity.installationRevision
                        : identity.kind === "removed"
                          ? identity.revision
                          : null;
                    const target = `install:${catalog.id}:${entry.publisher}:${entry.name}:${entry.version}:${expected ?? "none"}`;
                    return (
                      <CatalogExtensionCard
                        // A precondição entra na chave: se outra sessão mudar a instalação, o card
                        // remonta e fecha um diálogo aberto, em vez de confirmar sobre o estado novo.
                        key={`${catalog.id}:${entry.publisher}:${entry.name}:${entry.version}:${identity.kind}:${expected ?? "none"}`}
                        entry={entry}
                        origin={catalog.origin}
                        canInstall={data.can_install}
                        actionsDisabled={!mutationsReady}
                        blockedReason={data.can_install ? mutationBlockedReason : undefined}
                        identity={identity}
                        busy={ocupado(target)}
                        preparationInProgress={
                          !emVoo.includes(target) && preparando(catalog.id, entry.publisher, entry.name)
                        }
                        onInstall={(expectedRevision) =>
                          void install(catalog.id, entry, expectedRevision)
                        }
                      />
                    );
                  })}
                </div>
              ) : catalogEntries.length === 0 ? (
                <ExtensionEmptyList
                  title={t("Nenhum catálogo revisado disponível")}
                  description={
                    data.can_install
                      ? t("Adicione acima um arquivo obtido de uma fonte em que você já confia.")
                      : t("Peça ao responsável pela instalação para admitir um catálogo revisado.")
                  }
                />
              ) : (
                <ExtensionEmptyList
                  title={t("Nenhuma extensão corresponde à busca")}
                  description={t("Limpe a busca ou escolha outra categoria.")}
                />
              )}
            </TabsContent>
          </Tabs>

          {data.operations.length > 0 ? (
            <ExtensionOperations
              actorId={actorId}
              installBusy={(operation) =>
                Boolean(
                  operation.catalog_id &&
                    operation.publisher &&
                    operation.name &&
                    emVoo.some((alvo) =>
                      alvo.startsWith(
                        `install:${operation.catalog_id}:${operation.publisher}:${operation.name}:`,
                      ),
                    ),
                )
              }
              operations={data.operations}
              ocupado={ocupado}
              actionsDisabled={!mutationsReady}
              onVerify={verifyOperation}
              onCancel={cancelOperation}
            />
          ) : null}
        </>
      ) : null}
    </main>
  );
}

/** Onde uma entrada do catálogo está em relação ao que já foi instalado (ver `CatalogIdentityState`). */
function catalogIdentity(
  data: ExtensionListView,
  catalogId: string,
  entry: CatalogEntry,
): CatalogIdentityState {
  const sameIdentity = (item: { publisher: string; name: string }) =>
    item.publisher === entry.publisher && item.name === entry.name;
  const active = data.installations.filter((item) => !item.removed_at && sameIdentity(item));
  const here = active.find((item) => item.catalog_id === catalogId);
  if (here) {
    return {
      kind: "installed",
      version: here.version,
      installationRevision: here.installation_revision,
      activeOrganizations: here.active_organizations,
    };
  }
  const removed = data.removed_installations.find(
    (item) => item.catalog_id === catalogId && sameIdentity(item),
  );
  if (removed) {
    return {
      kind: "removed",
      revision: removed.revision,
      removedAt: removed.removed_at,
      awaitingReactivation: removed.awaiting_reactivation,
    };
  }
  const elsewhere = active[0];
  return elsewhere
    ? { kind: "other_origin", origin: elsewhere.origin, version: elsewhere.version }
    : { kind: "absent" };
}

/** O tipo do pedido pendente: o rótulo sozinho é igual para atualizar, desfazer e remover. */
function tituloDoPedido(kind: PendingReceipt["kind"], t: (texto: string) => string): string {
  switch (kind) {
    case "catalog_admission":
      return t("Admissão de catálogo");
    case "install":
      return t("Instalação");
    case "update":
      // O pedido guardado não sabe a versão de origem; o recibo do servidor diz qual dos dois foi.
      return t("Atualização ou troca de versão");
    case "revert":
      return t("Desfazer a última troca");
    case "removal":
      return t("Remoção da instalação");
    case "configure":
      return t("Configuração");
  }
}
