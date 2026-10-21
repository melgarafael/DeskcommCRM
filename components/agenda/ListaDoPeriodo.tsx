"use client";
import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { dataDeParede, diaLocalISO } from "@/lib/agenda/fuso";
import { ROTULO_DA_SITUACAO } from "@/lib/agenda/tipos";
import { cn } from "@/lib/utils";
import type { Agendamento } from "./tipos";

/** The same authorized period, grouped in the organization's time zone. No availability inference. */
export function ListaDoPeriodo({
  items,
  fuso,
  onOpen,
  className,
}: {
  items: Agendamento[];
  fuso: string;
  onOpen?: (id: string) => void;
  className?: string;
}) {
  const t = useT();
  const locale = useLocaleDeData();
  const groups = new Map<string, Agendamento[]>();
  for (const item of [...items].sort((a, b) => Date.parse(a.comeca) - Date.parse(b.comeca))) {
    const day = diaLocalISO(new Date(item.comeca), fuso);
    const group = groups.get(day) ?? [];
    group.push(item);
    groups.set(day, group);
  }
  return (
    <section
      aria-label={t("Compromissos do período")}
      className={cn("min-h-0 overflow-y-auto", className)}
    >
      {groups.size === 0 ? (
        <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
          {t("Nenhum compromisso neste período.")}
        </p>
      ) : (
        [...groups].map(([day, items]) => (
          <div key={day} className="mb-3">
            <h2 className="sticky top-0 bg-background px-3 py-2 text-sm font-medium">
              {format(dataDeParede(new Date(items[0]!.comeca), fuso), t("EEEE, d 'de' MMMM"), {
                locale,
              })}
            </h2>
            <ul>
              {items.map((item) => (
                <li key={item.id} className="border-b border-border">
                  <button
                    type="button"
                    disabled={item.origem === "google_sync" || !onOpen}
                    onClick={() => onOpen?.(item.id)}
                    className="flex min-h-11 w-full items-start gap-3 px-3 py-2 text-left disabled:opacity-80"
                  >
                    <span className="shrink-0 text-xs tabular-nums">
                      {format(dataDeParede(new Date(item.comeca), fuso), "HH:mm")}
                      <br />
                      {format(dataDeParede(new Date(item.termina), fuso), "HH:mm")}
                    </span>
                    <span className="min-w-0 flex-1 text-sm break-words">
                      {item.origem === "google_sync"
                        ? t("Ocupado na agenda do Google")
                        : (item.quemSeraAtendido ?? item.titulo)}
                      <span className="block text-xs text-muted-foreground">
                        {t(ROTULO_DA_SITUACAO[item.situacao])}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
