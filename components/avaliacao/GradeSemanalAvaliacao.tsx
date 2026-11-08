"use client";

import { addDays, format, isSameDay, startOfWeek } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { partesNoFuso } from "@/lib/agenda/fuso";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { ROTULO_STATUS } from "@/lib/avaliacao/status";

import type { AgendamentoAvaliacao } from "./tipos";

const INICIO_MIN = 9 * 60;
const FIM_MIN = 18 * 60 + 40;
const PASSO_MIN = 20;

function slotsDoDia(): number[] {
  const slots: number[] = [];
  for (let m = INICIO_MIN; m < FIM_MIN; m += PASSO_MIN) slots.push(m);
  return slots;
}

function minutoNoFuso(iso: string, fuso: string): { dia: Date; minuto: number } {
  const d = new Date(iso);
  const p = partesNoFuso(d, fuso);
  const dia = new Date(p.ano, p.mes - 1, p.dia);
  return { dia, minuto: p.hora * 60 + p.minuto };
}

function embedNome(item: AgendamentoAvaliacao): string {
  const c = item.contacts;
  if (!c) return "Cliente";
  const um = Array.isArray(c) ? c[0] : c;
  return um?.name ?? "Cliente";
}

export function GradeSemanalAvaliacao({
  ancoraSemana,
  agendamentos,
  fuso,
  onSelecionar,
}: {
  ancoraSemana: Date;
  agendamentos: AgendamentoAvaliacao[];
  fuso: string | null;
  onSelecionar: (id: string) => void;
}) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const fusoGrade = fusoUtilizavel(fuso);
  const inicioSemana = startOfWeek(ancoraSemana, { weekStartsOn: 1 });
  const dias = Array.from({ length: 7 }, (_, i) => addDays(inicioSemana, i));
  const slots = slotsDoDia();

  const porDiaSlot = new Map<string, AgendamentoAvaliacao[]>();
  for (const ag of agendamentos) {
    const { dia, minuto } = minutoNoFuso(ag.scheduled_at, fusoGrade);
    const slotBase = Math.floor((minuto - INICIO_MIN) / PASSO_MIN) * PASSO_MIN + INICIO_MIN;
    if (slotBase < INICIO_MIN || slotBase >= FIM_MIN) continue;
    const chave = `${format(dia, "yyyy-MM-dd")}-${slotBase}`;
    const lista = porDiaSlot.get(chave) ?? [];
    lista.push(ag);
    porDiaSlot.set(chave, lista);
  }

  return (
    <div className="min-h-0 overflow-auto rounded-lg border">
      <div
        className="grid min-w-[720px]"
        style={{ gridTemplateColumns: `4.5rem repeat(7, minmax(6rem, 1fr))` }}
      >
        <div className="sticky top-0 z-10 border-b bg-muted/80 p-2 text-xs font-medium backdrop-blur">
          {t("Horário")}
        </div>
        {dias.map((dia) => (
          <div
            key={dia.toISOString()}
            className="sticky top-0 z-10 border-b border-l bg-muted/80 p-2 text-center text-xs font-medium backdrop-blur"
          >
            {format(dia, "EEE dd/MM", { locale: localeDaData })}
          </div>
        ))}

        {slots.map((minSlot) => {
          const rotulo = `${String(Math.floor(minSlot / 60)).padStart(2, "0")}:${String(minSlot % 60).padStart(2, "0")}`;
          return (
            <div key={minSlot} className="contents">
              <div className="border-b p-1 text-right text-[10px] text-muted-foreground">{rotulo}</div>
              {dias.map((dia) => {
                const chave = `${format(dia, "yyyy-MM-dd")}-${minSlot}`;
                const celula = porDiaSlot.get(chave) ?? [];
                const hoje = isSameDay(dia, new Date());
                return (
                  <div
                    key={chave}
                    className={cn(
                      "min-h-[2.75rem] border-b border-l p-0.5",
                      hoje && "bg-primary/5",
                    )}
                  >
                    <div className="flex flex-col gap-0.5">
                      {celula.map((ag) => (
                        <button
                          key={ag.id}
                          type="button"
                          onClick={() => onSelecionar(ag.id)}
                          className="w-full rounded-md border bg-card px-1 py-0.5 text-left text-[10px] leading-tight shadow-sm hover:bg-accent"
                        >
                          <span className="block truncate font-medium">{embedNome(ag)}</span>
                          <Badge variant="secondary" className="mt-0.5 h-4 px-1 text-[9px] font-normal">
                            {ROTULO_STATUS[ag.status]}
                          </Badge>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
