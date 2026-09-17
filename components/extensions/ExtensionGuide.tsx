"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import { localize, type ExtensionManifest } from "@/lib/extensions/manifest";
import type { ExtensionGuideView } from "@/lib/extensions/view";
import {
  ArrowRight,
  ArrowsClockwise,
  BookOpen,
  CaretLeft,
  CircleNotch,
  Lightbulb,
  ListChecks,
  Warning,
} from "@/lib/ui/icons";

import { requestExtensionApi } from "./api-client";

const EXTENSION_ICONS: Record<ExtensionManifest["display"]["icon"], typeof ListChecks> = {
  ListChecks,
  BookOpen,
  Lightbulb,
};
const EXPECTED_ORGANIZATION_HEADER = "X-Expected-Organization-Id";

export function ExtensionGuide({
  organizationId,
  installationId,
  selectedCardId,
}: {
  organizationId: string;
  installationId: string;
  selectedCardId?: string;
}) {
  const t = useT();
  const locale = useIdioma();
  const router = useRouter();
  const [guide, setGuide] = useState<ExtensionGuideView | null>(null);
  const [guideFresh, setGuideFresh] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // O código decide o que a tela oferece: removida de todas as organizações não tem "tente de novo".
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [openingCard, setOpeningCard] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const carregar = useCallback(
    async (quiet = false) => {
      const sequence = ++requestSequence.current;
      const requestedOrganization = organizationId;
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      setGuideFresh(false);
      if (!quiet) setLoading(true);
      const result = await requestExtensionApi<ExtensionGuideView>(
        `/api/v1/extensions/${encodeURIComponent(installationId)}`,
        {
          headers: { [EXPECTED_ORGANIZATION_HEADER]: requestedOrganization },
          signal: controller.signal,
        },
      );
      if (sequence !== requestSequence.current || requestedOrganization !== organizationId) return;
      setLoading(false);
      if (!result.ok) {
        if (controller.signal.aborted && result.uncertain) return;
        setGuide(null);
        setError(t(result.error.message));
        setErrorCode(result.error.code);
        if (result.error.code === "extension_context_changed") router.refresh();
        return;
      }
      if (
        result.data.organization_id !== requestedOrganization ||
        result.data.installation_id !== installationId
      ) {
        setGuide(null);
        setError(
          t("A organização ativa mudou em outra aba. Recarregue a página antes de continuar."),
        );
        setErrorCode("extension_context_changed");
        router.refresh();
        return;
      }
      setGuide(result.data);
      setGuideFresh(true);
      setError(null);
      setErrorCode(null);
    },
    [installationId, organizationId, router, t],
  );

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void carregar(), 0);
    return () => {
      window.clearTimeout(initialLoad);
      activeRequest.current?.abort();
    };
  }, [carregar]);

  useEffect(() => {
    const refresh = () => void carregar(true);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [carregar]);

  async function openTasks(cardId: string, capability: "tasks.open") {
    if (!guide || !guideFresh) return;
    setOpeningCard(cardId);
    setActionError(null);
    const result = await requestExtensionApi<{ href: "/app/tasks" }>(
      `/api/v1/extensions/${encodeURIComponent(guide.installation_id)}/open`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [EXPECTED_ORGANIZATION_HEADER]: organizationId,
        },
        // O card vai junto: depois de uma troca de versão, a rota confere que ele ainda existe.
        body: JSON.stringify({ capability, expected_revision: guide.revision, card_id: cardId }),
      },
    );
    setOpeningCard(null);
    if (!result.ok) {
      setActionError(t(result.error.message));
      if (result.error.code === "extension_context_changed") {
        setGuide(null);
        setGuideFresh(false);
        router.refresh();
        return;
      }
      await carregar(true);
      return;
    }
    if (result.data.href !== "/app/tasks") {
      setActionError(t("O servidor devolveu um destino que esta extensão não pode abrir."));
      return;
    }
    router.push(result.data.href);
  }

  if (loading && !guide) {
    return (
      <main className="mx-auto w-full max-w-4xl p-4 sm:p-6" data-testid="extension-guide-loading">
        <Card className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
          <CircleNotch className="animate-spin" aria-hidden />
          {t("Conferindo se o guia continua ativo…")}
        </Card>
      </main>
    );
  }

  if (!guide || error) {
    const removed = errorCode === "extension_removed";
    return (
      <main
        className="mx-auto w-full max-w-4xl p-4 sm:p-6"
        data-testid="extension-guide-unavailable"
      >
        <Card className="border-warning/40 bg-warning-bg p-5 sm:p-6" role="alert">
          <Warning size={24} weight="duotone" aria-hidden className="text-warning-fg" />
          <h1 className="mt-3 text-xl font-semibold">{t("Este guia não está disponível")}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {error ?? t("Não foi possível confirmar o estado atual desta extensão.")}
          </p>
          {removed ? null : (
            <p className="mt-2 text-sm text-muted-foreground">
              {t("Volte à gestão para conferir se ela está ativa e qual é o próximo passo.")}
            </p>
          )}
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <Button asChild variant="outline">
              <Link href="/app/extensions">
                <CaretLeft aria-hidden />
                {t("Voltar às extensões")}
              </Link>
            </Button>
            {removed ? null : (
              <Button onClick={() => void carregar()}>
                <ArrowsClockwise aria-hidden />
                {t("Tentar novamente")}
              </Button>
            )}
          </div>
        </Card>
      </main>
    );
  }

  const manifest = guide.manifest;
  const displayTitle = localize(manifest.display.title, locale);
  const displaySummary = localize(manifest.display.summary, locale);
  const cards = [...manifest.contributions.crm_cards].sort((left, right) => {
    if (left.id === selectedCardId) return -1;
    if (right.id === selectedCardId) return 1;
    return 0;
  });
  const compact = guide.configuration.density === "compact";
  // Um link para um card que a versão vigente não tem: antes o destaque só se perdia, calado.
  const missingCard =
    selectedCardId !== undefined && !cards.some((card) => card.id === selectedCardId);

  return (
    <main
      className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6"
      data-testid="extension-guide"
    >
      <Link
        href="/app/extensions"
        className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium text-muted-foreground hover:text-text focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-hidden"
      >
        <CaretLeft aria-hidden />
        {t("Voltar às extensões")}
      </Link>

      <header className="overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
        <div className="border-b border-border bg-accent-soft/45 px-5 py-4 sm:px-7">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success">{t("Ativa")}</Badge>
            <span className="font-mono text-xs text-muted-foreground">v{guide.version}</span>
          </div>
        </div>
        <div className="p-5 sm:p-7">
          <h1 className="text-2xl font-semibold tracking-tight">{displayTitle.text}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {displaySummary.text}
          </p>
          {displayTitle.fallback || displaySummary.fallback ? <FallbackNotice /> : null}
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <ListChecks size={16} weight="duotone" aria-hidden className="text-accent" />
            {t("Abre Tarefas; não lê seus dados.")}
          </div>
        </div>
      </header>

      {missingCard ? (
        <Card className="border-info/40 bg-info-bg p-4" role="status" data-testid="extension-guide-missing-card">
          <p className="text-sm">
            {t("O card indicado não existe na versão {versao} desta extensão.").replace(
              "{versao}",
              guide.version,
            )}
          </p>
        </Card>
      ) : null}

      {actionError ? (
        <Card className="border-warning/40 bg-warning-bg p-4" role="alert">
          <p className="text-sm font-medium">{t("A ação não foi aberta")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{actionError}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("O estado foi conferido novamente. Revise o guia antes de tentar outra vez.")}
          </p>
        </Card>
      ) : null}

      <div className={compact ? "space-y-3" : "space-y-5"}>
        {cards.map((card) => {
          const Icon = EXTENSION_ICONS[card.icon];
          const title = localize(card.title, locale);
          const description = localize(card.description, locale);
          const action = localize(card.action.label, locale);
          const cardFallback =
            title.fallback ||
            (guide.configuration.show_description && description.fallback) ||
            action.fallback ||
            card.blocks.some(
              (block) =>
                localize(block.heading, locale).fallback || localize(block.body, locale).fallback,
            );
          return (
            <article
              key={card.id}
              id={`extension-card-${card.id}`}
              data-testid={`extension-guide-card-${card.id}`}
              className={`scroll-mt-6 rounded-xl border bg-surface shadow-xs ${
                card.id === selectedCardId
                  ? "border-accent ring-1 ring-accent-200"
                  : "border-border"
              } ${compact ? "p-4" : "p-5 sm:p-6"}`}
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                  <Icon size={22} weight="duotone" aria-hidden />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">{title.text}</h2>
                  {guide.configuration.show_description ? (
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {description.text}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className={compact ? "mt-4 space-y-3" : "mt-5 space-y-4"}>
                {card.blocks.map((block, index) => {
                  const heading = localize(block.heading, locale);
                  const body = localize(block.body, locale);
                  return (
                    <section
                      key={`${card.id}:${index}`}
                      className="border-l-2 border-accent-200 pl-4"
                    >
                      <h3 className="text-sm font-semibold">{heading.text}</h3>
                      <p className="mt-1 text-sm leading-relaxed whitespace-pre-line text-muted-foreground">
                        {body.text}
                      </p>
                    </section>
                  );
                })}
              </div>

              {cardFallback ? <FallbackNotice /> : null}

              <div className="mt-5 border-t border-border pt-4">
                <Button
                  disabled={openingCard !== null || !guideFresh}
                  data-testid={`extension-open-${card.id}`}
                  onClick={() => void openTasks(card.id, card.action.capability)}
                >
                  {openingCard === card.id ? (
                    <CircleNotch className="animate-spin" aria-hidden />
                  ) : (
                    <ArrowRight aria-hidden />
                  )}
                  {openingCard === card.id ? t("Conferindo acesso…") : action.text}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(
                    "A ativação e a permissão serão verificadas novamente antes de abrir Tarefas.",
                  )}
                </p>
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}

function FallbackNotice() {
  const t = useT();
  return (
    <p className="mt-2 text-xs text-warning-fg">
      {t("Parte deste conteúdo está disponível apenas em português.")}
    </p>
  );
}
