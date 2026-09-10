"use client";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCallsQuery, type CallRow } from "@/hooks/calls/useCallsQuery";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", { hour12: false });
  } catch {
    return iso;
  }
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const STATUS_LABEL: Record<CallRow["status"], string> = {
  ringing: "Chamando",
  in_progress: "Em andamento",
  completed: "Concluída",
  no_answer: "Não atendida",
  busy: "Ocupado",
  failed: "Falhou",
  canceled: "Cancelada",
};

/** Número de quem ligou/foi ligado — o CLIENTE, não a linha da clínica. */
function counterpartNumber(call: CallRow): string {
  return call.direction === "outbound" ? call.to_number : call.from_number;
}

export function CallsClient() {
  const { data: calls, isLoading } = useCallsQuery();
  const [selected, setSelected] = useState<CallRow | null>(null);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Chamadas</h1>
        <p className="text-sm text-muted-foreground">
          Histórico de ligações (voz por IA) com transcrição.
        </p>
      </header>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Direção</TableHead>
                <TableHead>Número do cliente</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Atendido por</TableHead>
                <TableHead>Duração</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(calls ?? []).map((call) => (
                <TableRow
                  key={call.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(call)}
                >
                  <TableCell>{fmtDate(call.started_at)}</TableCell>
                  <TableCell>{call.direction === "outbound" ? "Saída" : "Entrada"}</TableCell>
                  <TableCell className="font-medium">{counterpartNumber(call)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{STATUS_LABEL[call.status]}</Badge>
                  </TableCell>
                  <TableCell>{call.handled_by === "ai" ? "IA" : "Humano"}</TableCell>
                  <TableCell>{fmtDuration(call.duration_seconds)}</TableCell>
                </TableRow>
              ))}
              {(calls ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    Nenhuma chamada ainda.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>Chamada com {counterpartNumber(selected)}</DialogTitle>
                <DialogDescription>
                  {fmtDate(selected.started_at)} · {selected.direction === "outbound" ? "Saída" : "Entrada"} ·{" "}
                  {STATUS_LABEL[selected.status]}
                </DialogDescription>
              </DialogHeader>
              <ScrollArea className="max-h-[60vh] pr-4">
                {selected.transcript && selected.transcript.length > 0 ? (
                  <div className="flex flex-col gap-3 py-2">
                    {selected.transcript.map((turn, i) => (
                      <div
                        key={i}
                        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                          turn.speaker === "agent"
                            ? "self-start bg-muted"
                            : "self-end bg-primary text-primary-foreground"
                        }`}
                      >
                        <div className="mb-1 text-xs opacity-70">
                          {turn.speaker === "agent" ? "Iara" : counterpartNumber(selected)}
                        </div>
                        {turn.text || <span className="italic opacity-60">(sem áudio detectado)</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Sem transcrição pra esta chamada.
                  </p>
                )}
              </ScrollArea>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
