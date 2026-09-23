"use client";
/**
 * A lista de campanhas (PRD §24).
 *
 * Mostra o que decide o próximo clique: em que pé está, para quantas pessoas,
 * quantas saíram e quando. Quem quiser o detalhe abre a campanha — a lista não
 * tenta ser o painel.
 */
import Link from "next/link";
import { useMemo, useState } from "react";

import { EstadoDaCampanha } from "@/components/campanhas/EstadoDaCampanha";
import { EmptyState } from "@/components/empty";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCampanhas } from "@/hooks/campanhas/useCampanhas";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { Megaphone, Plus } from "@/lib/ui/icons";
import { STATUS_DA_CAMPANHA } from "@/lib/campanhas/tipos";

export function ListaDeCampanhas() {
  const t = useT();
  // A data segue quem está lendo, não o idioma de quem escreveu a tela.
  const idioma = useTagDeIdioma();
  const [status, setStatus] = useState<string>("");
  const filtros = useMemo(() => ({ status: status || undefined, limit: 30 }), [status]);
  const q = useCampanhas(filtros);
  const campanhas = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Campanhas")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Escolha o público, escreva a mensagem e acompanhe quem recebeu.")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" asChild>
          <Link href="/app/campaigns/settings">{t("Configuração")}</Link>
        </Button>
        <Button asChild>
          <Link href="/app/campaigns/new">
            <Plus size={16} weight="bold" aria-hidden />
            <span>{t("Nova campanha")}</span>
          </Link>
        </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <label className="text-sm text-muted-foreground" htmlFor="filtro-status">
          {t("Situação")}
        </label>
        <select
          id="filtro-status"
          className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">{t("Todas")}</option>
          {STATUS_DA_CAMPANHA.map((s) => (
            <option key={s} value={s}>
              {t(rotulo(s))}
            </option>
          ))}
        </select>
      </div>

      {q.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : q.isError ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-error-fg">{t("Erro ao carregar as campanhas.")}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => q.refetch()}>
            {t("Tentar novamente")}
          </Button>
        </Card>
      ) : campanhas.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={Megaphone}
            headline={t("Nenhuma campanha ainda.")}
            subcopy={t(
              "Uma campanha fala com uma lista de contatos que você escolhe, no ritmo do número — nunca em rajada.",
            )}
            primary={{ label: t("Nova campanha"), href: "/app/campaigns/new" }}
          />
        </Card>
      ) : (
        <>
          <Card className="divide-y divide-border">
            {campanhas.map((c) => (
              <Link
                key={c.id}
                href={`/app/campaigns/${c.id}`}
                className="flex flex-col gap-2 p-4 transition-colors hover:bg-surface-elevated sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{c.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {c.snapshot_eligible > 0
                      ? `${c.snapshot_eligible} ${t("contatos na lista")}`
                      : t("lista ainda não preparada")}
                    {c.snapshot_excluded > 0 ? ` · ${c.snapshot_excluded} ${t("fora")}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-sm text-muted-foreground">{quando(c, t, idioma)}</span>
                  <EstadoDaCampanha status={c.status} />
                </div>
              </Link>
            ))}
          </Card>
          {q.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => q.fetchNextPage()}
                disabled={q.isFetchingNextPage}
              >
                {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function rotulo(status: string): string {
  const mapa: Record<string, string> = {
    draft: "Rascunho",
    preparing: "Montando a lista",
    ready: "Pronta para iniciar",
    scheduled: "Agendada",
    running: "Enviando",
    paused: "Pausada",
    completed: "Concluída",
    cancelled: "Cancelada",
    failed: "Falhou",
  };
  return mapa[status] ?? status;
}

/** A data que importa depende do estado — mostrar "criada em" numa campanha que já terminou é ruído. */
function quando(
  c: { status: string; scheduled_at: string | null; started_at: string | null; completed_at: string | null; created_at: string },
  t: (s: string) => string,
  idioma: string,
): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(idioma, { dateStyle: "short", timeStyle: "short" });
  if (c.status === "scheduled" && c.scheduled_at) return `${t("começa")} ${fmt(c.scheduled_at)}`;
  if (c.completed_at) return `${t("terminou")} ${fmt(c.completed_at)}`;
  if (c.started_at) return `${t("começou")} ${fmt(c.started_at)}`;
  return `${t("criada")} ${fmt(c.created_at)}`;
}
