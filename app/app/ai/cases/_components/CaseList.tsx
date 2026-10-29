"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { formatDistanceToNowStrict } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCases, type CaseListItem } from "@/hooks/ai/useCases";
import { STATUS_BADGE_VARIANT, STATUS_LABEL, tipoDeCasoLabel } from "@/lib/ai/case-copy";
import { CaretLeft, Robot } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";
import { CaseDetail } from "./CaseDetail";

export function CaseList({ heading }: { heading?: ReactNode } = {}) {
  const t = useT();
  const [tab, setTab] = useState<"open" | "resolved">("open");
  // Deep link: o aviso "um atendimento espera decisão" na Central manda para cá
  // com o id do caso. Sem isto ele abriria a LISTA, e quem clicou teria que
  // caçar de qual caso o aviso falava — um aviso que não leva ao seu assunto é
  // meio aviso. Só o valor INICIAL: clicar na lista continua mandando, e a URL
  // não vira estado a sincronizar.
  // `?.` porque o hook devolve null fora de um contexto de navegação (o que
  // acontece em teste e em render estático). Sem a guarda, a tela inteira
  // quebra com "Cannot read properties of null".
  const idDaUrl = useSearchParams()?.get("caso") ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(idDaUrl);
  const { data, isLoading } = useCases(tab);
  const listRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const hasOpenedDetail = useRef(false);

  useEffect(() => {
    if (selectedId !== null) {
      hasOpenedDetail.current = true;
      if (window.matchMedia?.("(max-width: 767px)").matches) backRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!hasOpenedDetail.current) return;
    hasOpenedDetail.current = false;
    const target = selectedTrigger.current?.isConnected ? selectedTrigger.current
      : listRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    target?.focus({ preventScroll: true });
  }, [selectedId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:gap-6">
      {heading ? <div className={cn("shrink-0", selectedId !== null && "hidden md:block")}>{heading}</div> : null}
      <div className="flex min-h-0 flex-1 gap-4 md:gap-6">
        <div ref={listRef} data-testid="case-list" className={cn("min-h-0 w-full flex-col gap-4 md:max-w-xs md:shrink-0", selectedId === null ? "flex" : "hidden md:flex")}>

          <Tabs value={tab} onValueChange={(v) => setTab(v as "open" | "resolved")}>
            <TabsList>
              <TabsTrigger value="open">{t("Abertos")}{data ? ` (${data.open_count})` : ""}</TabsTrigger>
              <TabsTrigger value="resolved">{t("Concluídos")}</TabsTrigger>
            </TabsList>
          </Tabs>

          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : !data || data.cases.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
              <Robot size={28} className="text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">
                {tab === "open" ? t("Nenhum caso aberto") : t("Nenhum caso concluído")}
              </p>
              <p className="text-xs text-muted-foreground">
                {tab === "open"
                  ? t("Quando a IA precisar de você, aparece aqui.")
                  : t("Casos concluídos, cancelados ou repassados ficam aqui.")}
              </p>
            </div>
          ) : (
            <ul className="min-h-0 overflow-y-auto divide-y divide-border rounded-lg border border-border">
              {data.cases.map((c) => (
                <CaseRow
                  key={c.id}
                  item={c}
                  selected={c.id === selectedId}
                  onSelect={(trigger) => { selectedTrigger.current = trigger; setSelectedId(c.id); }}
                />
              ))}
            </ul>
          )}
        </div>

        <div data-testid="case-detail" role="region" aria-label={t("Detalhes do caso")} className={cn("min-h-0 min-w-0 flex-1 flex-col gap-3", selectedId === null ? "hidden md:flex" : "flex")}>
          {selectedId !== null ? (
            <Button ref={backRef} variant="ghost" className="h-11 shrink-0 self-start md:hidden" onClick={() => setSelectedId(null)}>
              <CaretLeft size={18} aria-hidden />
              {t("Voltar aos casos")}
            </Button>
          ) : null}
          <CaseDetail caseId={selectedId} />
        </div>
      </div>
    </div>
  );
}

function CaseRow({
  item,
  selected,
  onSelect,
}: {
  item: CaseListItem;
  selected: boolean;
  onSelect: (trigger: HTMLButtonElement) => void;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const when = formatDistanceToNowStrict(new Date(item.opened_at), { addSuffix: true, locale: localeDaData });
  return (
    <li>
      <button
        type="button"
        onClick={(event) => onSelect(event.currentTarget)}
        aria-current={selected ? "true" : undefined}
        data-testid="case-item"
        className={cn(
          "flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-accent-soft",
          selected && "bg-accent-soft",
        )}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{item.title}</p>
          <Badge variant={STATUS_BADGE_VARIANT[item.status]} className="shrink-0">
            {t(STATUS_LABEL[item.status])}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {/* O assunto vem ANTES do nome: quem tria a fila decide por ele, e o
              nome só importa depois de escolher o caso. */}
          {t(tipoDeCasoLabel(item.kind))} · {item.contact_name ?? t("Contato sem nome")} · {when}
        </p>
      </button>
    </li>
  );
}
