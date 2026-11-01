"use client";

import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import type { Sector } from "@/hooks/team/useSectors";
import {
  copiarParaDiasUteis,
  LIMITE_DE_JANELAS,
  podeCopiarParaDiasUteis,
  resumoDaJornada,
  ROTULOS_DOS_DIAS,
} from "@/lib/agenda/editor-de-jornada";
import { FUSOS_OFERECIDOS, fusoOferecidoOuPadrao } from "@/lib/tempo/fusos";
import type { AvailabilitySchedule, ScheduleWindow } from "@/lib/schemas/routing";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash } from "@/lib/ui/icons";

/**
 * Horário do SETOR (migration 9062) — a janela em que o setor aceita conversa.
 *
 * ─── A régua é a MESMA da jornada do atendente ─────────────────────────────
 *
 * O setor é o destino da conversa (a "fila"); este diálogo configura o horário
 * dele. Mesmo shape (`{ timezone, windows: [{ dow, start, end }] }`), mesmas funções
 * puras do editor da jornada (`lib/agenda/editor-de-jornada`): copiar para os
 * dias úteis, resumo do que foi gravado, limite de janelas. O que muda é o
 * SUJEITO: aqui é a fila, lá é a pessoa.
 *
 * ─── Janela vazia é 24/7 (e isso não é a mesma coisa que a Agenda) ─────────
 *
 * No roteamento, vazio = aceita conversa a qualquer hora. A Agenda usa a MESMA
 * coluna com o significado oposto (vazio = nada publicado). A descrição abaixo
 * diz QUAL dos dois está valendo aqui, para ninguém procurar defeito no lugar
 * errado.
 *
 * ─── O resumo lê o RETORNO da gravação ─────────────────────────────────────
 *
 * Não o formulário: o rascunho pode divergir do que o servidor guardou, e o
 * resumo existe para mostrar a diferença. É a lição da issue #2312, aplicada
 * aqui de propósito — o diálogo só fecha quando a pessoa pede.
 *
 * Fora do horário, a conversa NÃO é descartada: o roteamento reenfileira e ela
 * espera a abertura. A fila fechada adia, não perde.
 */
export function HorarioDoSetorDialog({
  setor,
  open,
  onOpenChange,
  onSave,
  isPending,
  organizationTimezone,
}: {
  setor: Sector;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Devolve o horário como o SERVIDOR guardou — é daqui que o resumo lê. */
  onSave: (schedule: AvailabilitySchedule) => Promise<AvailabilitySchedule | null>;
  isPending: boolean;
  organizationTimezone?: string;
}) {
  const t = useT();
  const inicial = setor.schedule;
  const fusoPadrao = fusoOferecidoOuPadrao(organizationTimezone);
  const [timezone, setTimezone] = useState(inicial?.timezone || fusoPadrao);
  const [windows, setWindows] = useState<ScheduleWindow[]>(inicial?.windows ?? []);
  const [gravado, setGravado] = useState<{
    rascunho: ScheduleWindow[];
    timezone: string;
    janelas: ScheduleWindow[];
  } | null>(null);

  const publicado =
    gravado && gravado.rascunho === windows && gravado.timezone === timezone
      ? gravado.janelas
      : null;
  const podeCopiar = podeCopiarParaDiasUteis(windows);
  const podeAdicionar = windows.length < LIMITE_DE_JANELAS;

  async function salvar() {
    try {
      const salvo = await onSave({ timezone, windows });
      setGravado({
        rascunho: windows,
        timezone,
        janelas: salvo?.windows ?? [],
      });
    } catch {
      // O erro já virou toast no hook; o diálogo fica aberto.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("Horário do setor")} {setor.name}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Sem janelas, este setor aceita conversa a qualquer hora. Com janelas, quem chega fora do horário espera a abertura — a conversa não é descartada.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fila-tz">{t("Fuso horário")}</Label>
            <select
              id="fila-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {FUSOS_OFERECIDOS.map((f) => (
                <option key={f.codigo} value={f.codigo}>
                  {f.rotulo} — {f.codigo}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            {windows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("Nenhuma janela: este setor atende 24 horas, todos os dias.")}
              </p>
            ) : null}
            {windows.map((w, i) => (
              <div key={i} data-testid="janela-da-fila" data-dow={w.dow} className="flex items-center gap-2">
                <Select
                  value={String(w.dow)}
                  onValueChange={(v) =>
                    setWindows((ws) => ws.map((x, j) => (j === i ? { ...x, dow: Number(v) } : x)))
                  }
                >
                  <SelectTrigger className="w-[90px]" aria-label={t("Dia da semana")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROTULOS_DOS_DIAS.map((d, idx) => (
                      <SelectItem key={idx} value={String(idx)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="time"
                  className="min-w-0 max-md:px-2"
                  value={w.start}
                  aria-label={t("Início")}
                  onChange={(e) =>
                    setWindows((ws) =>
                      ws.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  type="time"
                  className="min-w-0 max-md:px-2"
                  value={w.end}
                  aria-label={t("Fim")}
                  onChange={(e) =>
                    setWindows((ws) =>
                      ws.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("Remover janela")}
                  onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))}
                >
                  <Trash size={16} />
                </Button>
              </div>
            ))}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!podeAdicionar}
                onClick={() =>
                  setWindows((ws) => {
                    // Primeiro dia da semana que ainda não tem janela; se todos
                    // têm, segunda — a pessoa ajusta na hora.
                    const ocupados = new Set(ws.map((x) => x.dow));
                    const dow = [1, 2, 3, 4, 5, 6, 0].find((d) => !ocupados.has(d)) ?? 1;
                    return [...ws, { dow, start: "09:00", end: "18:00" }];
                  })
                }
              >
                <Plus size={16} className="mr-1" />
                {t("Adicionar janela")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!podeCopiar}
                onClick={() => setWindows((ws) => copiarParaDiasUteis(ws))}
              >
                {t("Copiar estes horários para os outros dias úteis")}
              </Button>
            </div>
          </div>

          {publicado ? (
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="text-xs font-semibold">
                {t("É isto que ficou gravado — confira os dias e os horários antes de sair.")}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {resumoDaJornada(publicado, t).map((linha) => (
                  <li key={linha}>{linha}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Fechar")}
          </Button>
          <Button type="button" disabled={isPending} onClick={salvar}>
            {t("Salvar horário")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
