"use client";
import { useState, type CSSProperties } from "react";
import {
  HistoricoDaAgenda,
  FiltrosDoHistorico,
  type AbaDoHistorico,
} from "@/components/agenda/HistoricoDaAgenda";
import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import { ListaDoPeriodo } from "@/components/agenda/ListaDoPeriodo";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";
import { ScoreSlot } from "@/components/kanban/ScoreSlot";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { calendarArea, pipelineArea } from "@/lib/ui-themes/areas";
import { cn } from "@/lib/utils";
import { UiThemeArea, useUiThemeArea } from "./Area";

/** Read-only host samples: no queries, mutations, booking callbacks or business calculations. */
export function PipelineThemePreview() {
  const t = useT();
  const { regionClass } = useUiThemeArea(pipelineArea);
  const toolbar = (
    <header className={cn("flex items-center justify-between gap-3", regionClass("toolbar"))}>
      <h3 className="font-semibold">{t("Funil de exemplo")}</h3>
      <Button title={t("Amostra visual: use esta ação na página correspondente.")} disabled>{t("Novo negócio")}</Button>
    </header>
  );
  const board = (
    <div className={cn("flex min-h-80 gap-3 overflow-x-auto", regionClass("board"))}>
      {[t("Entrada"), t("Em análise")].map((stage, i) => (
        <section
          key={stage}
          className={cn(
            "min-w-64 flex-1 rounded-lg border border-border bg-surface",
            regionClass("column"),
          )}
          style={{ "--ui-stage-color": i === 0 ? "#71899e" : "#8979a1" } as CSSProperties}
        >
          <h4
            className={cn(
              "border-b border-border p-3 text-sm font-medium",
              regionClass("column-header"),
            )}
          >
            {stage}
          </h4>
          <article
            className={cn("m-2 rounded-lg border border-border bg-bg p-3", regionClass("card"))}
          >
            <h5 data-ui-part="card-title" className="mb-2 h-10 text-sm font-medium">
              {t(i === 0 ? "Negócio de exemplo" : "Outro negócio de exemplo")}
            </h5>
            <p className="text-sm">R$ 150</p>
            <div
              data-ui-state={i === 0 ? "meter" : "awaiting"}
              className={cn("mt-1.5 flex min-h-6 items-center gap-2 text-xs", regionClass("state"))}
            >
              {i === 0 ? (
                <span className={regionClass("score")}>
                  <ScoreSlot
                    probability={72}
                    band="quente"
                    reason={t("Valor fictício para a amostra visual.")}
                    factors={[]}
                  />
                </span>
              ) : (
                <span>{t("Aguardando revisão")}</span>
              )}
            </div>
            <p className="mt-3 text-xs text-text-muted">{t("Responsável de exemplo")}</p>
          </article>
        </section>
      ))}
    </div>
  );
  return (
    <div className="h-[540px] overflow-auto p-3 text-text" inert>
      <UiThemeArea
        contract={pipelineArea}
        slots={{ toolbar, board }}
        rootProps={{ className: "flex min-h-full flex-col gap-3" }}
        fallback={
          <div className="flex flex-col gap-3">
            {toolbar}
            {board}
          </div>
        }
      />
    </div>
  );
}

const anchor = new Date("2026-10-21T12:00:00Z");
const people: Pessoa[] = [{ id: "preview-person", nome: "Pessoa de exemplo", trilha: 1 }];
const appointments: Agendamento[] = [
  {
    id: "preview-a",
    titulo: "Compromisso de exemplo",
    tipo: "Serviço de exemplo",
    responsavelId: "preview-person",
    comeca: "2026-10-21T13:00:00Z",
    termina: "2026-10-21T13:30:00Z",
    origem: "ui",
    situacao: "confirmed",
  },
  {
    id: "preview-b",
    titulo: "Outro compromisso",
    tipo: "Outro serviço",
    responsavelId: "preview-person",
    comeca: "2026-10-22T14:00:00Z",
    termina: "2026-10-22T14:30:00Z",
    origem: "ui",
    situacao: "pending",
  },
];
export function CalendarThemePreview() {
  const t = useT();
  const { contribution, regionClass } = useUiThemeArea(calendarArea);
  const config = contribution?.configuration ?? {};
  const [aba, setAba] = useState<AbaDoHistorico>(() =>
    config.historyAllFirst ? "todos" : "proximos",
  );
  const controls = (
    <header className="flex flex-col gap-3">
      <h3 className="font-semibold">{t("Agenda de exemplo")}</h3>
      <div className={cn("flex flex-wrap gap-2", regionClass("services"))}>
        {config.allServices === true && <Button title={t("Amostra visual: use esta ação na página correspondente.")} disabled>{t("Todos")}</Button>}
        <Button title={t("Amostra visual: use esta ação na página correspondente.")} disabled variant="outline">
          {t("Serviço de exemplo")}
        </Button>
      </div>
    </header>
  );
  const history = (
    <HistoricoDaAgenda
      aba={config.historyControlsBeforeGrid ? aba : undefined}
      ocultarFiltros={config.historyControlsBeforeGrid === true}
      agendamentos={appointments}
      pessoas={people}
      agora={anchor}
      fuso="America/Sao_Paulo"
    />
  );
  const grid = (
    <div className="flex min-h-0 flex-col gap-2">
      {config.periodList === true && (
        <ListaDoPeriodo
          items={appointments}
          fuso="America/Sao_Paulo"
          className={regionClass("period-list")}
        />
      )}
      <GradeDaAgenda
        visao="semana"
        ancora={anchor}
        agora={anchor}
        fuso="America/Sao_Paulo"
        pessoas={people}
        agendamentos={appointments}
        className={cn("h-80", config.periodList === true && regionClass("grid"))}
      />
    </div>
  );
  const content = (
    <div className="flex min-h-0 flex-col gap-3">
      {config.historyControlsBeforeGrid === true && (
        <div data-ui-part="calendar-history-controls">
          <span className="text-[11px] text-text-muted">{t("Filtrar o histórico")}</span>
          <FiltrosDoHistorico
            agendamentos={appointments}
            agora={anchor}
            aba={aba}
            onChange={setAba}
          />
        </div>
      )}
      {config.gridFirst === true ? (
        <>
          {grid}
          {history}
        </>
      ) : (
        <>
          {history}
          {grid}
        </>
      )}
    </div>
  );
  return (
    <div className="h-[540px] overflow-auto p-3 text-text" inert>
      <UiThemeArea
        contract={calendarArea}
        slots={{ notice: null, controls, content }}
        rootProps={{ className: "flex min-h-full flex-col gap-3" }}
        fallback={
          <div className="flex flex-col gap-3">
            {controls}
            {content}
          </div>
        }
      />
    </div>
  );
}
