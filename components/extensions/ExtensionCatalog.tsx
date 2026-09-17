"use client";

import { useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import { localize, type CatalogEntry, type ExtensionManifest } from "@/lib/extensions/manifest";
import { compararVersoes } from "@/lib/extensions/versao";
import {
  BookOpen,
  CheckCircle,
  CircleNotch,
  Lightbulb,
  ListChecks,
  MagnifyingGlass,
  PuzzlePiece,
  UploadSimple,
  X,
} from "@/lib/ui/icons";

import { continuamAtivas, usavamAntesDaRemocao } from "./frases-de-versao";

const CATEGORY_VALUES = ["all", "productivity", "sales", "service"] as const;
export type CategoryFilter = (typeof CATEGORY_VALUES)[number];

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: "Todas as categorias",
  productivity: "Produtividade",
  sales: "Vendas",
  service: "Atendimento",
};

const ICONS: Record<ExtensionManifest["display"]["icon"], typeof ListChecks> = {
  ListChecks,
  BookOpen,
  Lightbulb,
};

function normalizedSearch(...values: string[]): string {
  return values
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function matchesExtensionFilter(
  display: ExtensionManifest["display"],
  identity: string[],
  query: string,
  category: CategoryFilter,
  locale: "pt-BR" | "es",
): boolean {
  if (category !== "all" && display.category !== category) return false;
  const needle = normalizedSearch(query.trim());
  if (!needle) return true;
  return normalizedSearch(
    localize(display.title, locale).text,
    localize(display.summary, locale).text,
    ...identity,
  ).includes(needle);
}

export function ExtensionFilterBar({
  query,
  category,
  onQueryChange,
  onCategoryChange,
}: {
  query: string;
  category: CategoryFilter;
  onQueryChange: (value: string) => void;
  onCategoryChange: (value: CategoryFilter) => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="relative">
        <MagnifyingGlass
          aria-hidden
          size={17}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("Buscar por nome ou descrição")}
          aria-label={t("Buscar extensões")}
          className="pl-9"
        />
      </div>
      <Select value={category} onValueChange={(value) => onCategoryChange(value as CategoryFilter)}>
        <SelectTrigger aria-label={t("Filtrar por categoria")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CATEGORY_VALUES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(CATEGORY_LABELS[value])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function CatalogAdmission({
  file,
  onFile,
  onSubmit,
  busy,
  disabled,
  error,
  blockedReason,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  onSubmit: () => void;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  blockedReason?: string;
}) {
  const t = useT();
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <Card className="overflow-hidden border-accent-200" data-testid="extension-catalog-admission">
      <div className="grid md:grid-cols-[1.15fr_0.85fr]">
        <div className="p-5 sm:p-6">
          <Badge variant="info">{t("Responsável pela instalação")}</Badge>
          <h2 className="mt-3 text-lg font-semibold">{t("Oriente o trabalho com novos guias")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t(
              "Adicione guias que orientam o trabalho e só podem abrir Tarefas, sem receber dados do CRM. Escolha um catálogo revisado de uma fonte em que você confia.",
            )}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("O arquivo JSON pode ter até 512 KiB.")}
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <UploadSimple aria-hidden />
              {t("Escolher arquivo JSON")}
            </Button>
            <input
              ref={fileInput}
              id="extension-catalog-file"
              data-testid="extension-catalog-file"
              className="sr-only"
              type="file"
              accept="application/json,.json"
              aria-label={t("Escolher arquivo JSON")}
              onChange={(event) => {
                onFile(event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
            />
            {file ? (
              <span className="min-w-0 truncate text-sm text-muted-foreground">
                {file.name} ·{" "}
                {new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
                  file.size / 1024,
                )}{" "}
                KB
              </span>
            ) : null}
          </div>
          <Button
            data-testid="extension-catalog-submit"
            className="mt-4 w-full sm:w-auto"
            disabled={!file || busy || disabled}
            onClick={onSubmit}
          >
            {busy ? (
              <CircleNotch className="animate-spin" aria-hidden />
            ) : (
              <CheckCircle aria-hidden />
            )}
            {busy ? t("Admitindo…") : t("Admitir catálogo")}
          </Button>
          {error ? (
            <p className="mt-2 text-sm text-error-fg" role="alert">
              {error}
            </p>
          ) : blockedReason ? (
            <p className="mt-2 text-xs text-muted-foreground">{blockedReason}</p>
          ) : null}
        </div>
        <div className="border-t border-accent-200 bg-accent-soft/45 p-5 sm:p-6 md:border-t-0 md:border-l">
          <h3 className="text-sm font-semibold">{t("Antes de admitir")}</h3>
          <ul className="mt-3 space-y-3 text-sm text-muted-foreground">
            <li className="flex gap-2">
              <CheckCircle className="mt-0.5 shrink-0 text-accent" aria-hidden />
              {t("Registra quem admitiu, quando, a origem e a revisão do arquivo.")}
            </li>
            <li className="flex gap-2">
              <CheckCircle className="mt-0.5 shrink-0 text-accent" aria-hidden />
              {t("Confere que o arquivo não mudou antes de qualquer instalação.")}
            </li>
            <li className="flex gap-2">
              <X className="mt-0.5 shrink-0 text-error" aria-hidden />
              {t("O arquivo não comprova quem o publicou. Confirme a fonte antes de escolher.")}
            </li>
          </ul>
        </div>
      </div>
    </Card>
  );
}

/**
 * A relação entre uma entrada do catálogo e o que já está instalado. A identidade casa por
 * catálogo + publicador + nome: a mesma extensão vinda de outra origem é outra instalação, e o
 * catálogo não oferece trocá-la.
 */
export type CatalogIdentityState =
  | { kind: "absent" }
  | {
      kind: "installed";
      version: string;
      installationRevision: number;
      activeOrganizations: number | null;
    }
  | { kind: "removed"; revision: number; removedAt: string; awaitingReactivation: number }
  | { kind: "other_origin"; origin: string; version: string };

export function CatalogExtensionCard({
  entry,
  origin,
  canInstall,
  actionsDisabled,
  identity,
  blockedReason,
  busy,
  preparationInProgress = false,
  onInstall,
}: {
  entry: CatalogEntry;
  origin: string;
  canInstall: boolean;
  actionsDisabled: boolean;
  identity: CatalogIdentityState;
  blockedReason?: string;
  busy: boolean;
  /** Há preparação desta identidade em curso (de outra pessoa, ou um pedido anterior desta aba). */
  preparationInProgress?: boolean;
  /** Recebe a revisão da instalação que esta tela exibiu (`null` quando não havia linha). */
  onInstall: (expectedInstallationRevision: number | null) => void;
}) {
  const t = useT();
  const locale = useIdioma();
  const [confirming, setConfirming] = useState(false);
  const Icon = ICONS[entry.display.icon];
  const title = localize(entry.display.title, locale).text;
  const identidade = `${entry.publisher}-${entry.name}-${entry.version}`;
  const installed = identity.kind === "installed" ? identity : null;
  const sameVersion = installed?.version === entry.version;
  const upgrade = installed ? compararVersoes(entry.version, installed.version) > 0 : false;
  const confirmable = (installed && !sameVersion) || identity.kind === "removed";
  const actionLabel = installed
    ? upgrade
      ? t("Atualizar para {versao}").replace("{versao}", entry.version)
      : t("Trocar para {versao}").replace("{versao}", entry.version)
    : identity.kind === "removed"
      ? t("Reinstalar versão {versao}").replace("{versao}", entry.version)
      : t("Instalar versão revisada");
  const expectedRevision =
    identity.kind === "installed"
      ? identity.installationRevision
      : identity.kind === "removed"
        ? identity.revision
        : null;

  return (
    <Card
      className="flex h-full flex-col p-5"
      data-testid={`extension-catalog-${identidade}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface-elevated text-muted-foreground">
          <Icon size={22} weight="duotone" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {localize(entry.display.summary, locale).text}
          </p>
          {localize(entry.display.title, locale).fallback ||
          localize(entry.display.summary, locale).fallback ? (
            <p className="mt-1 text-xs text-warning-fg">{t("Texto disponível em português.")}</p>
          ) : null}
        </div>
      </div>
      <dl className="mt-4 space-y-2 rounded-md bg-surface-elevated/55 p-3 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t("Identidade")}</dt>
          <dd className="text-right font-mono break-all">
            {entry.publisher}/{entry.name}@{entry.version}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t("Origem revisada")}</dt>
          <dd className="text-right break-all">{origin}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t("Permissão")}</dt>
          <dd className="text-right">{t("Abre Tarefas; não lê seus dados.")}</dd>
        </div>
      </dl>
      <div className="mt-auto pt-4">
        {sameVersion ? (
          <div className="rounded-md border border-border p-3 text-sm">
            <p className="font-medium">{t("Esta versão já está instalada.")}</p>
          </div>
        ) : identity.kind === "other_origin" ? (
          <div className="rounded-md border border-border p-3 text-sm">
            <p className="font-medium">
              {t("Já instalada a partir de outra origem ({origem}, versão {versao}).")
                .replace("{origem}", identity.origin)
                .replace("{versao}", identity.version)}
            </p>
          </div>
        ) : canInstall ? (
          <div>
            {installed ? (
              <p className="mb-2 text-xs text-muted-foreground">
                {t("Instalada hoje: versão {versao}.").replace("{versao}", installed.version)}
              </p>
            ) : identity.kind === "removed" ? (
              <p className="mb-2 text-xs text-muted-foreground">
                {t("Removida da instalação em {data}.").replace(
                  "{data}",
                  new Date(identity.removedAt).toLocaleDateString(locale),
                )}
              </p>
            ) : null}
            <Button
              data-testid={`extension-install-${identidade}`}
              className="w-full sm:w-auto"
              disabled={busy || actionsDisabled || preparationInProgress}
              onClick={() => (confirmable ? setConfirming(true) : onInstall(expectedRevision))}
            >
              {busy ? (
                <CircleNotch className="animate-spin" aria-hidden />
              ) : (
                <UploadSimple aria-hidden />
              )}
              {busy ? t("Preparando…") : actionLabel}
            </Button>
            {preparationInProgress ? (
              <p
                className="mt-2 text-xs text-muted-foreground"
                data-testid={`extension-catalog-preparing-${identidade}`}
              >
                {t(
                  "Há uma preparação desta extensão em andamento. Acompanhe ou cancele o pedido em Atividade recente.",
                )}
              </p>
            ) : null}
            {blockedReason ? (
              <p className="mt-2 text-xs text-muted-foreground">{blockedReason}</p>
            ) : null}
          </div>
        ) : installed ? (
          <p className="text-sm text-muted-foreground">
            {t("Instalada hoje: versão {versao}.").replace("{versao}", installed.version)}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {blockedReason ?? t("Somente o responsável pela instalação pode instalar este pacote.")}
          </p>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid={`extension-install-dialog-${identidade}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {installed
                ? (upgrade
                    ? t("Atualizar {titulo} para a versão {versao}?")
                    : t("Trocar {titulo} para a versão {versao}?")
                  )
                    .replace("{titulo}", title)
                    .replace("{versao}", entry.version)
                : t("Reinstalar {titulo}?").replace("{titulo}", title)}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {installed ? (
                  <>
                    <p>
                      {t("A versão {versao} é substituída em todas as organizações.").replace(
                        "{versao}",
                        installed.version,
                      )}
                    </p>
                    {installed.activeOrganizations !== null ? (
                      <p>{continuamAtivas(t, installed.activeOrganizations)}</p>
                    ) : null}
                    <p>
                      {t(
                        "Depois você pode desfazer esta troca, mesmo com o catálogo fora do ar.",
                      )}
                    </p>
                  </>
                ) : identity.kind === "removed" ? (
                  <>
                    <p>
                      {t("Ela foi removida em {data}.").replace(
                        "{data}",
                        new Date(identity.removedAt).toLocaleDateString(locale),
                      )}
                    </p>
                    <p>{usavamAntesDaRemocao(t, identity.awaitingReactivation)}</p>
                    <p>{t("A versão é baixada de novo do catálogo.")}</p>
                  </>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preparationInProgress || actionsDisabled ? (
            // O motivo tem de estar DENTRO do diálogo: o que está na tela atrás dele não é lido.
            <p
              className="text-xs text-muted-foreground"
              data-testid={`extension-install-blocked-${identidade}`}
            >
              {preparationInProgress
                ? t(
                    "Há uma preparação desta extensão em andamento. Acompanhe ou cancele o pedido em Atividade recente.",
                  )
                : (blockedReason ??
                  t("Atualize o estado das extensões antes de enviar um novo pedido."))}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid={`extension-install-confirm-${identidade}`}
              // Um diálogo aberto antes de a preparação aparecer não pode confirmar o que o banco
              // recusa: a recarga de 3 s traz o recibo e o botão fecha a porta.
              disabled={busy || actionsDisabled || preparationInProgress}
              onClick={() => onInstall(expectedRevision)}
            >
              {installed ? (upgrade ? t("Atualizar") : t("Trocar")) : t("Reinstalar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export function ExtensionLoadingState() {
  const t = useT();
  return (
    <Card
      className="flex items-center gap-3 p-5 text-sm text-muted-foreground"
      data-testid="extensions-loading"
    >
      <CircleNotch className="animate-spin" aria-hidden />
      {t("Carregando extensões…")}
    </Card>
  );
}

export function ExtensionEmptyList({ title, description }: { title: string; description: string }) {
  return (
    <Card className="flex flex-col items-center px-5 py-12 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-elevated text-muted-foreground">
        <PuzzlePiece size={22} weight="duotone" aria-hidden />
      </div>
      <h2 className="mt-3 text-base font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
    </Card>
  );
}
