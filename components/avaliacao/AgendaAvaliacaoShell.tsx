"use client";

import { addWeeks, endOfWeek, format, startOfWeek } from "date-fns";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useAgendamentosAvaliacao } from "@/hooks/avaliacao/useAgendamentosAvaliacao";
import { useUnidadesAvaliacao } from "@/hooks/avaliacao/useUnidadesAvaliacao";
import { CalendarPlus } from "@/lib/ui/icons";

import { AlertaSemUnidades } from "./AlertaSemUnidades";
import { FiltrosAvaliacao } from "./FiltrosAvaliacao";
import { FormularioAgendamento } from "./FormularioAgendamento";
import { GradeSemanalAvaliacao } from "./GradeSemanalAvaliacao";
import { ListaAgendamentos } from "./ListaAgendamentos";
import type { FiltrosAvaliacaoState, VisaoAvaliacao } from "./tipos";

function intervaloSemana(ancora: Date): FiltrosAvaliacaoState {
  const inicio = startOfWeek(ancora, { weekStartsOn: 1 });
  const fim = endOfWeek(ancora, { weekStartsOn: 1 });
  fim.setHours(23, 59, 59, 999);
  return { de: inicio.toISOString(), ate: fim.toISOString(), status: "todos" };
}

export function AgendaAvaliacaoShell({ timezone }: { timezone: string | null }) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const [ancora, setAncora] = useState(() => new Date());
  const [visao, setVisao] = useState<VisaoAvaliacao>("lista");
  const [filtrosBase, setFiltrosBase] = useState<FiltrosAvaliacaoState>(() => intervaloSemana(new Date()));
  const [formAberto, setFormAberto] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);

  const filtros = useMemo(
    () => ({
      ...filtrosBase,
      de: intervaloSemana(ancora).de,
      ate: intervaloSemana(ancora).ate,
    }),
    [ancora, filtrosBase],
  );

  const lista = useAgendamentosAvaliacao(filtros);
  const unidades = useUnidadesAvaliacao();

  const semanaLabel = format(startOfWeek(ancora, { weekStartsOn: 1 }), "MMMM yyyy", {
    locale: localeDaData,
  });
  const edicao = lista.data?.find((a) => a.id === editandoId) ?? null;

  const abrirNovo = () => {
    setEditandoId(null);
    setFormAberto(true);
  };

  const abrirEditar = (id: string) => {
    setEditandoId(id);
    setFormAberto(true);
  };

  return (
    <div data-testid="tela-agenda-avaliacao" className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Agenda de avaliação")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Horários, unidades e status da operação veicular.")}
          </p>
        </div>
        <Button type="button" onClick={abrirNovo}>
          <CalendarPlus className="mr-2 h-4 w-4" />
          Novo agendamento
        </Button>
      </div>

      {(unidades.data?.length ?? 0) === 0 ? (
        <AlertaSemUnidades carregando={unidades.isLoading} />
      ) : null}

      <FiltrosAvaliacao
        semanaLabel={semanaLabel}
        filtros={filtros}
        unidades={unidades.data ?? []}
        onAnterior={() => setAncora((d) => addWeeks(d, -1))}
        onProxima={() => setAncora((d) => addWeeks(d, 1))}
        onHoje={() => setAncora(new Date())}
        onChange={(patch) => setFiltrosBase((f) => ({ ...f, ...patch }))}
      />

      <div className="flex gap-1 rounded-lg border bg-muted/40 p-1 w-fit">
        <Button
          type="button"
          size="sm"
          variant={visao === "lista" ? "secondary" : "ghost"}
          onClick={() => setVisao("lista")}
        >
          Lista
        </Button>
        <Button
          type="button"
          size="sm"
          variant={visao === "semana" ? "secondary" : "ghost"}
          onClick={() => setVisao("semana")}
        >
          Semana
        </Button>
      </div>

      {visao === "lista" ? (
        <ListaAgendamentos
          itens={lista.data ?? []}
          carregando={lista.isLoading}
          onEditar={abrirEditar}
          onNovo={abrirNovo}
        />
      ) : (
        <GradeSemanalAvaliacao
          ancoraSemana={ancora}
          agendamentos={lista.data ?? []}
          fuso={timezone}
          onSelecionar={abrirEditar}
        />
      )}

      <FormularioAgendamento
        aberto={formAberto}
        onAbertoChange={setFormAberto}
        edicao={edicao}
        unidades={unidades.data ?? []}
        onAgendamentoSalvo={(iso) => setAncora(new Date(iso))}
      />
    </div>
  );
}
