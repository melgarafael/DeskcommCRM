"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { format, formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Clock, MagnifyingGlass, Trash } from "@/lib/ui/icons";
import { rotuloDoStatus, tomDoStatus } from "@/lib/followup/eventos-legiveis";
import { useFollowupFlows } from "@/hooks/followup/useFollowupFlows";
import {
  useCancelFollowupEnrollment,
  useCancelFollowupPromise,
  useFollowupQueue,
  type FollowupEnrollmentStatus,
  type FollowupQueueRow,
} from "@/hooks/followup/useFollowupQueue";

interface Props {
  canWrite: boolean;
}

/**
 * Os status filtráveis, na ordem em que fazem sentido para quem opera: primeiro
 * o que está andando, depois o que parou, depois o que terminou. O RÓTULO vem de
 * `rotuloDoStatus` — a tabela morava aqui, e a segunda tela que mostrasse status
 * (o dossiê) nasceria com a segunda cópia.
 */
const STATUS_OPTIONS: FollowupEnrollmentStatus[] = [
  "active",
  "waiting_reply",
  "paused_manual",
  "paused_handoff",
  "completed",
  "cancelled",
  "dead",
];

const LIVE_ENROLLMENT_STATUSES = new Set(["active", "waiting_reply", "paused_handoff", "paused_manual"]);

/**
 * O que ainda dá para desmarcar.
 *
 * A fila mostrava promessa e enrollment lado a lado e só oferecia o botão para o
 * segundo: o agente prometia voltar, a pessoa via na tela e não tinha o que
 * fazer. As duas famílias são canceláveis agora, por rotas diferentes — o
 * significado do cancelamento não é o mesmo, e um comando único atingiria a
 * linha errada em silêncio.
 */
function podeCancelar(row: FollowupQueueRow): boolean {
  return row.source === "enrollment"
    ? LIVE_ENROLLMENT_STATUSES.has(row.status)
    : row.status === "agendada";
}

function QueueStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={tomDoStatus(status)} aria-label={`status: ${rotuloDoStatus(status)}`}>
      {rotuloDoStatus(status)}
    </Badge>
  );
}

function NextFireCell({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-text-muted">—</span>;
  const d = new Date(iso);
  const relative = formatDistanceToNowStrict(d, { addSuffix: true, locale: ptBR });
  const absolute = format(d, "dd/MM/yyyy HH:mm", { locale: ptBR });
  return (
    <div title={absolute} className="flex flex-col">
      <span className="text-sm">{relative}</span>
      <span className="text-xs text-text-muted">{absolute}</span>
    </div>
  );
}

export function QueueTab({ canWrite }: Props) {
  const [status, setStatus] = useState<FollowupEnrollmentStatus | "all">("all");
  const [pointerId, setPointerId] = useState<string>("all");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [pendingCancel, setPendingCancel] = useState<FollowupQueueRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data: flows } = useFollowupFlows();
  const filters = useMemo(
    () => ({
      status: status === "all" ? undefined : status,
      pointer_id: pointerId === "all" ? undefined : pointerId,
      q: q || undefined,
    }),
    [status, pointerId, q],
  );
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useFollowupQueue(filters);
  const cancelEnrollment = useCancelFollowupEnrollment();
  const cancelPromise = useCancelFollowupPromise();

  const rows: FollowupQueueRow[] = data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-56">
          <MagnifyingGlass
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
            aria-hidden
          />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar contato…"
            className="h-9 w-full pl-8 text-sm"
            aria-label="Buscar contato"
          />
        </div>

        <Select value={status} onValueChange={(v) => setStatus(v as FollowupEnrollmentStatus | "all")}>
          <SelectTrigger className="h-9 w-48 text-sm" aria-label="Filtrar por status">
            <SelectValue placeholder="Todos os status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {rotuloDoStatus(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={pointerId} onValueChange={setPointerId}>
          <SelectTrigger className="h-9 w-48 text-sm" aria-label="Filtrar por fluxo">
            <SelectValue placeholder="Todos os fluxos" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os fluxos</SelectItem>
            {(flows ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!isLoading && rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-border py-16 text-center">
          <Clock size={36} className="text-text-muted" aria-hidden />
          <h2 className="font-medium">Nenhum item na fila</h2>
          <p className="max-w-sm text-sm text-text-muted">
            Enrollments ativos e promessas de retorno agendadas pela IA aparecem aqui.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Contato</TableHead>
                <TableHead>Fluxo / Promessa</TableHead>
                <TableHead>Nó atual / Motivo</TableHead>
                <TableHead>Próximo disparo</TableHead>
                <TableHead>Status</TableHead>
                {canWrite && <TableHead className="w-[100px]" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const canCancel = canWrite && podeCancelar(row);
                return (
                  <TableRow key={`${row.source}:${row.id}`} data-testid="queue-row">
                    <TableCell className="font-medium">
                      {/*
                        A porta do dossiê. Só enrollment tem história para contar:
                        a promessa (`cron_jobs`) é uma linha só — um horário e um
                        motivo — e um link que abrisse uma tela vazia ensinaria
                        que o dossiê às vezes não funciona.
                      */}
                      {row.source === "enrollment" ? (
                        <Link
                          href={`/app/ai/followups/enrollments/${row.id}`}
                          className="underline-offset-2 hover:underline"
                          data-testid="queue-abrir-dossie"
                        >
                          {row.contact.name}
                        </Link>
                      ) : (
                        row.contact.name
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>{row.flow_name ?? <span className="text-text-muted">Promessa</span>}</span>
                        {row.agent_name && (
                          <span className="text-xs text-text-muted">agente {row.agent_name}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[280px] truncate text-sm" title={row.node_or_reason}>
                      {row.node_or_reason}
                    </TableCell>
                    <TableCell>
                      <NextFireCell iso={row.next_fire_at} />
                    </TableCell>
                    <TableCell>
                      <QueueStatusBadge status={row.status} />
                    </TableCell>
                    {canWrite && (
                      <TableCell>
                        {canCancel && (
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid="cancelar-item-da-fila"
                            aria-label={
                              row.source === "promise" ? "Cancelar retorno" : "Cancelar follow-up"
                            }
                            onClick={() => setPendingCancel(row)}
                          >
                            <Trash size={14} aria-hidden className="mr-1 text-error" /> Cancelar
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? "Carregando..." : "Carregar mais"}
          </Button>
        </div>
      )}

      <AlertDialog open={pendingCancel !== null} onOpenChange={(open) => !open && setPendingCancel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingCancel?.source === "promise"
                ? "Cancelar este retorno?"
                : "Cancelar este follow-up?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCancel?.source === "promise"
                ? "O agente não voltará a falar com esta pessoa no horário combinado, e vai saber que você desmarcou."
                : "O lead não receberá mais mensagens deste fluxo. Essa ação não pode ser desfeita."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (pendingCancel?.source === "promise") cancelPromise.mutate(pendingCancel.id);
                else if (pendingCancel) cancelEnrollment.mutate(pendingCancel.id);
                setPendingCancel(null);
              }}
            >
              {pendingCancel?.source === "promise" ? "Cancelar retorno" : "Cancelar follow-up"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
