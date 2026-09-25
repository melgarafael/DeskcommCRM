"use client";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
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
import { useT } from "@/hooks/i18n/useT";
import { useCallsQuery, useDialCall, type CallRow } from "@/hooks/calls/useCallsQuery";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";

function fmtDate(iso: string | null, idioma: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(idioma, { hour12: false });
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

/** Identificador de ligações: nome do contato, com fallback pro número — regra única em rotuloDoContato. */
function counterpartLabel(call: CallRow): string {
  return rotuloDoContato({
    display_name: call.contact?.display_name,
    name: call.contact?.name,
    phone_number: counterpartNumber(call),
  });
}

function DialerDialog() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [toNumber, setToNumber] = useState("");
  const dial = useDialCall();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    dial.mutate(
      { toNumber },
      {
        onSuccess: () => {
          setOpen(false);
          setToNumber("");
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{t("Nova ligação")}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("Nova ligação")}</DialogTitle>
            <DialogDescription>
              {t("A IA liga pra esse número e conduz a chamada — falar você mesmo ainda não está disponível.")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label htmlFor="dialer-number">{t("Número")}</Label>
            <Input
              id="dialer-number"
              type="tel"
              placeholder="+55 32 98479-3302"
              value={toNumber}
              onChange={(e) => setToNumber(e.target.value)}
              autoFocus
              required
              minLength={8}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={dial.isPending || toNumber.trim().length < 8}>
              {dial.isPending ? t("Ligando…") : t("Ligar com IA")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CallsClient() {
  const t = useT();
  // A data segue o idioma de quem lê — `tests/unit/i18n-a-data-segue-o-idioma`
  // reprova `toLocaleString("pt-BR")` fixo.
  const idioma = useTagDeIdioma();
  const { data: calls, isLoading } = useCallsQuery();
  const [selected, setSelected] = useState<CallRow | null>(null);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Chamadas")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Histórico de ligações (voz por IA) com transcrição.")}
          </p>
        </div>
        <DialerDialog />
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
                <TableHead>{t("Data")}</TableHead>
                <TableHead>{t("Direção")}</TableHead>
                <TableHead>{t("Quem é")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
                <TableHead>{t("Atendido por")}</TableHead>
                <TableHead>{t("Duração")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(calls ?? []).map((call) => (
                <TableRow
                  key={call.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(call)}
                >
                  <TableCell>{fmtDate(call.started_at, idioma)}</TableCell>
                  <TableCell>{call.direction === "outbound" ? t("Saída") : t("Entrada")}</TableCell>
                  <TableCell className="font-medium">{counterpartLabel(call)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{t(STATUS_LABEL[call.status])}</Badge>
                  </TableCell>
                  <TableCell>{call.handled_by === "ai" ? t("IA") : t("Humano")}</TableCell>
                  <TableCell>{fmtDuration(call.duration_seconds)}</TableCell>
                </TableRow>
              ))}
              {(calls ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    {t("Nenhuma chamada ainda.")}
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
                <DialogTitle>
                  {t("Chamada com")} {counterpartLabel(selected)}
                </DialogTitle>
                <DialogDescription>
                  {fmtDate(selected.started_at, idioma)} ·{" "}
                  {selected.direction === "outbound" ? t("Saída") : t("Entrada")} ·{" "}
                  {t(STATUS_LABEL[selected.status])}
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
                          {turn.speaker === "agent"
                            ? "Iara"
                            : counterpartLabel(selected)}
                        </div>
                        {turn.text || <span className="italic opacity-60">{t("(sem áudio detectado)")}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {t("Sem transcrição pra esta chamada.")}
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
