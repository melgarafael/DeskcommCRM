"use client";

import Link from "next/link";
import { useState } from "react";

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
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import {
  localize,
  type ExtensionConfiguration,
  type ExtensionManifest,
} from "@/lib/extensions/manifest";
import type { InstalledExtensionView } from "@/lib/extensions/view";
import { BookOpen, CircleNotch, Lightbulb, ListChecks } from "@/lib/ui/icons";

import { deixamDeVer, organizacoesAtivas } from "./frases-de-versao";

const ICONS: Record<ExtensionManifest["display"]["icon"], typeof ListChecks> = {
  ListChecks,
  BookOpen,
  Lightbulb,
};

function permissionCopy(permissions: InstalledExtensionView["permissions"]): string {
  return permissions.includes("navigation.tasks")
    ? "Abre Tarefas; não lê seus dados."
    : "Não recebe acesso aos dados do CRM.";
}

export function InstalledExtensionCard({
  extension,
  canManage,
  actionsDisabled,
  manageBlockedReason,
  supportMode,
  busy,
  feedback,
  onConfigure,
  canInstall = false,
  platformBusyAction = null,
  preparationInProgress = false,
  platformBlockedReason,
  onRevert,
  onRemove,
}: {
  extension: InstalledExtensionView;
  canManage: boolean;
  actionsDisabled: boolean;
  manageBlockedReason?: string;
  supportMode: boolean;
  busy: boolean;
  /**
   * A resposta do último salvamento. Mora no gestor, e não aqui: salvar sobe a
   * revisão, a chave do card muda e ele remonta com os valores do servidor — o que
   * é certo para o formulário e apagava a mensagem antes de ela aparecer.
   */
  feedback: string | null;
  onConfigure: (
    extension: InstalledExtensionView,
    enabled: boolean,
    configuration: ExtensionConfiguration,
  ) => Promise<void>;
  /** Quem administra a instalação: vê o bloco "Em todas as organizações". */
  canInstall?: boolean;
  /** Qual ação de plataforma está em curso, para o indicador ficar no botão certo. */
  platformBusyAction?: "revert" | "remove" | null;
  /** Há preparação de instalação ou atualização desta identidade: o banco recusa desfazer e remover. */
  preparationInProgress?: boolean;
  platformBlockedReason?: string;
  onRevert?: (extension: InstalledExtensionView) => Promise<void>;
  onRemove?: (extension: InstalledExtensionView) => Promise<void>;
}) {
  const t = useT();
  const locale = useIdioma();
  const Icon = ICONS[extension.display.icon];
  const [enabled, setEnabled] = useState(extension.enabled);
  const [density, setDensity] = useState<ExtensionConfiguration["density"]>(
    extension.configuration.density,
  );
  const [showDescription, setShowDescription] = useState(extension.configuration.show_description);
  const changed =
    enabled !== extension.enabled ||
    density !== extension.configuration.density ||
    showDescription !== extension.configuration.show_description;

  async function save() {
    await onConfigure(extension, enabled, {
      density,
      show_description: showDescription,
    });
  }

  const title = localize(extension.display.title, locale).text;
  const formatDate = (value: string) => new Date(value).toLocaleDateString(locale);

  if (extension.removed_at) {
    // A organização usava esta extensão e o responsável pela instalação a removeu. Sem ações:
    // voltar é reinstalar pelo catálogo, e depois ativar de novo aqui.
    return (
      <Card className="flex h-full flex-col p-5" data-testid={`extension-installed-${extension.id}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{title}</h2>
          <Badge variant="neutral">{t("Removida")}</Badge>
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {extension.publisher}/{extension.name}@{extension.version}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground" data-testid={`extension-removed-${extension.id}`}>
          {t(
            "O responsável pela instalação removeu esta extensão em {data}. Os guias saíram de todas as organizações; a configuração desta organização ficou guardada.",
          ).replace("{data}", formatDate(extension.removed_at))}
        </p>
      </Card>
    );
  }

  const deactivatedByRemoval =
    !extension.enabled && extension.deactivated_by_removal_at ? (
      <p
        className="mt-4 rounded-md border border-info/30 bg-info-bg p-3 text-sm"
        data-testid={`extension-reactivate-${extension.id}`}
      >
        {(!extension.compatible
          ? t(
              "Estava ativa até ser removida da instalação em {data}. A versão reinstalada não pode ser ativada; peça ao responsável pela instalação uma versão compatível.",
            )
          : canManage
            ? t(
                "Estava ativa até ser removida da instalação em {data}. Ative de novo para voltar a mostrar os guias.",
              )
            : t(
                "Estava ativa até ser removida da instalação em {data}. Peça a um administrador da organização para ativar de novo.",
              )
        ).replace("{data}", formatDate(extension.deactivated_by_removal_at))}
      </p>
    ) : null;

  // Rótulos em t() literal: passados por variável, escapavam do gate de espanhol.
  const status = !extension.compatible
    ? { label: t("Incompatível"), variant: "error" as const }
    : extension.enabled
      ? { label: t("Ativa"), variant: "success" as const }
      : { label: t("Desativada"), variant: "neutral" as const };

  return (
    <Card className="flex h-full flex-col p-5" data-testid={`extension-installed-${extension.id}`}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Icon size={22} weight="duotone" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{title}</h2>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {localize(extension.display.summary, locale).text}
          </p>
          {localize(extension.display.title, locale).fallback ||
          localize(extension.display.summary, locale).fallback ? (
            <p className="mt-1 text-xs text-warning-fg">{t("Texto disponível em português.")}</p>
          ) : null}
        </div>
      </div>

      <dl className="mt-4 grid gap-2 rounded-md border border-border bg-surface-elevated/55 p-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t("Versão")}</dt>
          <dd className="mt-0.5 font-mono">{extension.version}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("Origem")}</dt>
          <dd className="mt-0.5 break-all">{extension.origin}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">{t("Permissão")}</dt>
          <dd className="mt-0.5">{t(permissionCopy(extension.permissions))}</dd>
        </div>
      </dl>

      {deactivatedByRemoval}

      {canInstall ? (
        <h3 className="mt-4 text-sm font-semibold">{t("Nesta organização")}</h3>
      ) : null}

      {!extension.compatible ? (
        <div className="mt-4 rounded-md border border-error/30 bg-error-bg p-3 text-sm">
          <p className="font-medium text-error-fg">{t("Esta versão não pode ser ativada")}</p>
          <p className="mt-1 text-muted-foreground">
            {extension.compatibility_reason
              ? t(extension.compatibility_reason)
              : t("O servidor recusou a compatibilidade desta versão.")}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("Peça ao responsável pela instalação uma versão compatível.")}
          </p>
          {canManage && extension.enabled ? (
            // Ficou incompatível depois de ativada (uma atualização do CRM estreitou o
            // contrato): sai do hub, mas segue ativa e ocupando vaga. Sem este botão não
            // havia saída pela tela. Desativar preserva a configuração.
            <div className="mt-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                {t(
                  "Ela segue marcada como ativa e ocupa uma das vagas de extensões ativas até ser desativada.",
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                data-testid={`extension-disable-incompatible-${extension.id}`}
                disabled={busy || actionsDisabled}
                onClick={() => void onConfigure(extension, false, extension.configuration)}
              >
                {t("Desativar nesta organização")}
              </Button>
              {feedback ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {feedback}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : canManage ? (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor={`enabled-${extension.id}`}>{t("Ativa no CRM")}</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {enabled
                  ? t("Os guias aparecem no hub do CRM.")
                  : t("A configuração fica preservada enquanto estiver desativada.")}
              </p>
            </div>
            <Switch
              id={`enabled-${extension.id}`}
              data-testid={`extension-enabled-${extension.id}`}
              checked={enabled}
              disabled={actionsDisabled}
              onCheckedChange={setEnabled}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`density-${extension.id}`}>{t("Densidade dos cards")}</Label>
              <Select
                value={density}
                disabled={actionsDisabled}
                onValueChange={(value) => setDensity(value as ExtensionConfiguration["density"])}
              >
                <SelectTrigger
                  id={`density-${extension.id}`}
                  data-testid={`extension-density-${extension.id}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="comfortable">{t("Confortável")}</SelectItem>
                  <SelectItem value="compact">{t("Compacta")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <Label htmlFor={`description-${extension.id}`} className="leading-snug">
                {t("Mostrar descrição nos cards")}
              </Label>
              <Switch
                id={`description-${extension.id}`}
                data-testid={`extension-description-${extension.id}`}
                checked={showDescription}
                disabled={actionsDisabled}
                onCheckedChange={setShowDescription}
              />
            </div>
          </div>
          {feedback ? (
            <p role="status" className="text-xs text-muted-foreground">
              {feedback}
            </p>
          ) : null}
          {manageBlockedReason ? (
            <p className="text-xs text-muted-foreground">{manageBlockedReason}</p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            {extension.enabled ? (
              <Button asChild variant="outline">
                <Link href={`/app/extensions/${encodeURIComponent(extension.id)}`}>
                  {t("Abrir guia")}
                </Link>
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{t("Ative para abrir o guia.")}</p>
            )}
            <Button
              data-testid={`extension-save-${extension.id}`}
              disabled={!changed || busy || actionsDisabled}
              onClick={() => void save()}
            >
              {busy ? <CircleNotch className="animate-spin" aria-hidden /> : null}
              {busy ? t("Salvando…") : t("Salvar configuração")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {supportMode
              ? t("Saia do acompanhamento para configurar extensões.")
              : extension.enabled
                ? t("Este guia está pronto para uso.")
                : t("Peça a um administrador da organização para ativar este guia.")}
          </p>
          {extension.enabled ? (
            <Button asChild variant="outline">
              <Link href={`/app/extensions/${encodeURIComponent(extension.id)}`}>
                {t("Abrir guia")}
              </Link>
            </Button>
          ) : null}
        </div>
      )}

      {canInstall && onRevert && onRemove ? (
        <PlatformBlock
          extension={extension}
          title={title}
          busyAction={platformBusyAction}
          preparationInProgress={preparationInProgress}
          actionsDisabled={actionsDisabled}
          blockedReason={platformBlockedReason}
          onRevert={onRevert}
          onRemove={onRemove}
        />
      ) : null}
    </Card>
  );
}

/**
 * O que vale para TODAS as organizações, separado do que vale para esta. Aparece nos dois ramos
 * (compatível e incompatível): uma versão que ficou incompatível é justamente a que precisa de
 * "Desfazer" ou "Remover".
 */
function PlatformBlock({
  extension,
  title,
  busyAction,
  preparationInProgress,
  actionsDisabled,
  blockedReason,
  onRevert,
  onRemove,
}: {
  extension: InstalledExtensionView;
  title: string;
  busyAction: "revert" | "remove" | null;
  preparationInProgress: boolean;
  actionsDisabled: boolean;
  blockedReason?: string;
  onRevert: (extension: InstalledExtensionView) => Promise<void>;
  onRemove: (extension: InstalledExtensionView) => Promise<void>;
}) {
  const t = useT();
  const [dialog, setDialog] = useState<"revert" | "remove" | null>(null);
  const previous = extension.previous;
  const active = extension.active_organizations ?? 0;
  const busy = busyAction !== null;
  const blocked = busy || actionsDisabled || preparationInProgress;
  // Um botão de confirmar desabilitado dentro de um diálogo modal fica mudo: o motivo que existe
  // fora dele some atrás do overlay, e quem opera só descobre desistindo. O diálogo carrega o seu.
  const motivoDoBloqueio = preparationInProgress
    ? t(
        "Há uma preparação desta extensão em andamento. Acompanhe ou cancele o pedido em Atividade recente antes de desfazer ou remover.",
      )
    : actionsDisabled
      ? (blockedReason ?? t("Atualize o estado das extensões antes de enviar um novo pedido."))
      : null;
  return (
    <section
      className="mt-4 space-y-3 rounded-md border border-border bg-surface-elevated/40 p-3"
      data-testid={`extension-platform-${extension.id}`}
    >
      <div>
        <h3 className="text-sm font-semibold">{t("Em todas as organizações")}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground" data-testid={`extension-active-count-${extension.id}`}>
          {organizacoesAtivas(t, active)}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {previous ? (
          <Button
            variant="outline"
            size="sm"
            data-testid={`extension-revert-${extension.id}`}
            disabled={!previous.compatible || blocked}
            onClick={() => setDialog("revert")}
          >
            {busyAction === "revert" ? <CircleNotch className="animate-spin" aria-hidden /> : null}
            {t("Desfazer a última troca (volta para {versao})").replace("{versao}", previous.version)}
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="text-error-fg"
          data-testid={`extension-remove-${extension.id}`}
          disabled={blocked}
          onClick={() => setDialog("remove")}
        >
          {busyAction === "remove" ? <CircleNotch className="animate-spin" aria-hidden /> : null}
          {t("Remover da instalação")}
        </Button>
      </div>
      {previous && !previous.compatible ? (
        <p className="text-xs text-muted-foreground">
          {t("A versão {versao} não é compatível com esta versão do CRM.").replace(
            "{versao}",
            previous.version,
          )}
        </p>
      ) : null}
      {preparationInProgress ? (
        <p className="text-xs text-muted-foreground" data-testid={`extension-platform-preparing-${extension.id}`}>
          {t(
            "Há uma preparação desta extensão em andamento. Acompanhe ou cancele o pedido em Atividade recente antes de desfazer ou remover.",
          )}
        </p>
      ) : null}
      {blockedReason ? <p className="text-xs text-muted-foreground">{blockedReason}</p> : null}

      <AlertDialog open={dialog === "revert"} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent data-testid={`extension-revert-dialog-${extension.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Voltar {titulo} para a versão {versao}?")
                .replace("{titulo}", title)
                .replace("{versao}", previous?.version ?? "")}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {t(
                    "A versão {atual} sai de todas as organizações agora e a {anterior} volta a valer. Nada é baixado.",
                  )
                    .replace("{atual}", extension.version)
                    .replace("{anterior}", previous?.version ?? "")}
                </p>
                <p>{organizacoesAtivas(t, active)}</p>
                {previous && !previous.in_catalog ? (
                  <p>
                    {t("A versão {versao} não está mais no catálogo admitido.").replace(
                      "{versao}",
                      previous.version,
                    )}
                  </p>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {motivoDoBloqueio ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid={`extension-revert-blocked-${extension.id}`}
            >
              {motivoDoBloqueio}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid={`extension-revert-confirm-${extension.id}`}
              disabled={blocked}
              onClick={() => void onRevert(extension)}
            >
              {t("Desfazer a troca")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === "remove"} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent data-testid={`extension-remove-dialog-${extension.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Remover {titulo} de todas as organizações?").replace("{titulo}", title)}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{deixamDeVer(t, active)}</p>
                <p>
                  {t(
                    "Não há desfazer: para reinstalar, o catálogo precisa estar no ar e listar a versão, e cada organização ativa de novo.",
                  )}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {motivoDoBloqueio ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid={`extension-remove-blocked-${extension.id}`}
            >
              {motivoDoBloqueio}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid={`extension-remove-confirm-${extension.id}`}
              className={buttonVariants({ variant: "destructive" })}
              disabled={blocked}
              onClick={() => void onRemove(extension)}
            >
              {t("Remover de todas")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
