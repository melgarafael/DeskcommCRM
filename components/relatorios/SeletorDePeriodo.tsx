"use client";

/**
 * UM campo para o período: "01/11/2026 - 19/11/2026" com o ícone de calendário.
 * Clicar abre o calendário com os atalhos ("Hoje", "7 dias", "Este mês"…) ao
 * lado. No calendário, o primeiro clique marca o início e o segundo o fim (se
 * vier antes do início, os dois trocam de lugar), e o período se aplica.
 *
 * As datas são strings AAAA-MM-DD na parede da empresa, como a rota recebe; o
 * calendário calcula tudo em UTC para o fuso do navegador nunca mudar o dia.
 */
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import {
  ATALHOS_DE_PERIODO,
  atalhoDoPeriodo,
  periodoDoAtalho,
  type AtalhoDePeriodo,
  type Periodo,
} from "@/lib/relatorios/atalhos-de-periodo";
import { cn } from "@/lib/utils";

/** "2026-11-01" → "01/11/2026". */
export function dataCurta(data: string): string {
  const [ano, mes, dia] = data.split("-");
  return `${dia}/${mes}/${ano}`;
}

function somarMeses(mes: string, n: number): string {
  const [ano, m] = mes.split("-").map(Number);
  const d = new Date(Date.UTC(ano!, m! - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Os dias da grade do mês (AAAA-MM), com `null` nas casas antes do dia 1. */
function diasDoMes(mes: string): Array<string | null> {
  const [ano, m] = mes.split("-").map(Number);
  const primeiro = new Date(Date.UTC(ano!, m! - 1, 1));
  const total = new Date(Date.UTC(ano!, m!, 0)).getUTCDate();
  const casas: Array<string | null> = Array.from({ length: primeiro.getUTCDay() }, () => null);
  for (let d = 1; d <= total; d++) casas.push(`${mes}-${String(d).padStart(2, "0")}`);
  return casas;
}

export function SeletorDePeriodo({
  periodo,
  tz,
  aoMudar,
}: {
  periodo: Periodo;
  tz: string;
  aoMudar: (p: Periodo) => void;
}) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  const [aberto, setAberto] = useState(false);
  const [mes, setMes] = useState(periodo.ate.slice(0, 7));
  // O início escolhido no calendário, esperando o segundo clique.
  const [inicio, setInicio] = useState<string | null>(null);

  const rotuloDoAtalho: Record<AtalhoDePeriodo, string> = {
    hoje: t("Hoje"),
    "7d": t("7 dias"),
    "30d": t("30 dias"),
    mes: t("Este mês"),
    mes_passado: t("Mês passado"),
  };
  const atalhoAtivo = atalhoDoPeriodo(periodo, new Date(), tz);

  const nomeDoMes = useMemo(
    () => new Intl.DateTimeFormat(tagDeIdioma, { month: "long", year: "numeric", timeZone: "UTC" }),
    [tagDeIdioma],
  );
  const diasDaSemana = useMemo(() => {
    const f = new Intl.DateTimeFormat(tagDeIdioma, { weekday: "narrow", timeZone: "UTC" });
    // 2026-11-01 é um domingo: sete dias a partir dele.
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2026, 10, 1 + i))));
  }, [tagDeIdioma]);

  function abrir(novo: boolean) {
    setAberto(novo);
    if (novo) {
      setMes(periodo.ate.slice(0, 7));
      setInicio(null);
    }
  }

  function aplicar(p: Periodo) {
    aoMudar(p);
    setInicio(null);
    setAberto(false);
  }

  function clicarNoDia(dia: string) {
    if (inicio === null) {
      setInicio(dia);
      return;
    }
    aplicar(dia < inicio ? { de: dia, ate: inicio } : { de: inicio, ate: dia });
  }

  const marcado = (dia: string) =>
    inicio !== null ? dia === inicio : dia >= periodo.de && dia <= periodo.ate;

  return (
    <Popover open={aberto} onOpenChange={abrir}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="periodo-do-painel"
          aria-label={t("Escolher o período")}
          className="flex min-w-60 items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm tabular-nums hover:bg-surface-elevated max-md:min-h-11"
        >
          <span>
            {dataCurta(periodo.de)} - {dataCurta(periodo.ate)}
          </span>
          <CalendarDays className="size-4 text-text-muted" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-auto gap-4 p-3 max-sm:flex-col">
        <div className="flex flex-col gap-1 sm:border-r sm:border-border sm:pr-3">
          {ATALHOS_DE_PERIODO.map((atalho) => (
            <button
              key={atalho}
              type="button"
              data-testid={`atalho-${atalho}`}
              aria-pressed={atalhoAtivo === atalho}
              onClick={() => aplicar(periodoDoAtalho(atalho, new Date(), tz))}
              className={cn(
                "rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap transition-colors",
                atalhoAtivo === atalho ? "bg-accent text-accent-foreground" : "hover:bg-surface-elevated",
              )}
            >
              {rotuloDoAtalho[atalho]}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2" data-testid="calendario-do-periodo">
          <div className="flex items-center justify-between">
            <button
              type="button"
              aria-label={t("Mês anterior")}
              onClick={() => setMes((m) => somarMeses(m, -1))}
              className="rounded-md p-1 hover:bg-surface-elevated"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <span className="inline-block text-sm font-medium first-letter:uppercase">{nomeDoMes.format(new Date(`${mes}-01T00:00:00Z`))}</span>
            <button
              type="button"
              aria-label={t("Próximo mês")}
              onClick={() => setMes((m) => somarMeses(m, 1))}
              className="rounded-md p-1 hover:bg-surface-elevated"
            >
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
            {diasDaSemana.map((d, i) => (
              <span key={i} className="py-1 text-text-muted">
                {d}
              </span>
            ))}
            {diasDoMes(mes).map((dia, i) =>
              dia === null ? (
                <span key={`v${i}`} />
              ) : (
                <button
                  key={dia}
                  type="button"
                  data-testid={`dia-${dia}`}
                  aria-pressed={marcado(dia)}
                  onClick={() => clicarNoDia(dia)}
                  className={cn(
                    "size-8 rounded-md tabular-nums transition-colors",
                    marcado(dia) ? "bg-accent text-accent-foreground" : "hover:bg-surface-elevated",
                  )}
                >
                  {Number(dia.slice(8))}
                </button>
              ),
            )}
          </div>
          <p className="text-xs text-text-muted">
            {inicio === null ? t("Clique no dia inicial e depois no final.") : t("Agora clique no dia final.")}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
