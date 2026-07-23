"use client";
import { useEffect, useMemo, useState } from "react";
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
import { useFollowupFlows } from "@/hooks/followup/useFollowupFlows";
import {
  useCancelFollowupEnrollment,
  useFollowupQueue,
  type FollowupEnrollmentStatus,
  type FollowupQueueRow,
} from "@/hooks/followup/useFollowupQueue";

interface Props {
  canWrite: boolean;
}

const STATUS_OPTIONS: { value: FollowupEnrollmentStatus; label: string }[] = [
  { value: "active", label: "Ativo" },
  { value: "waiting_reply", label: "Aguardando resposta" },
  { value: "paused_handoff", label: "Pausado (handoff)" },
  { value: "completed", label: "Concluído" },
  { value: "cancelled", label: "Cancelado" },
  { value: "dead", label: "Morto" },
];

const STATUS_LABEL: Record<string, string> = {
  active: "Ativo",
  waiting_reply: "Aguardando resposta",
  paused_handoff: "Pausado",
  completed: "Concluído",
  cancelled: "Cancelado",
  dead: "Morto",
  agendada: "Agendada",
  "concluída": "Concluída",
};

const STATUS_VARIANT: Record<string, "neutral" | "success" | "warning" | "error" | "info"> = {
  active: "success",
  waiting_reply: "info",
  paused_handoff: "warning",
  completed: "neutral",
  cancelled: "neutral",
  dead: "error",
  agendada: "info",
  "concluída": "neutral",
};

const LIVE_ENROLLMENT_STATUSES = new Set(["active", "waiting_reply", "paused_handoff"]);

function QueueStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? "neutral"} aria-label={`status: ${STATUS_LABEL[status] ?? status}`}>
      {STATUS_LABEL[status] ?? status}
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
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null);

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
  const cancelMutation = useCancelFollowupEnrollment();

  const rows: FollowupQueueRow[] = data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <MagnifyingGlass
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
            aria-hidden
          />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar contato…"
            className="h-9 w-56 pl-8 text-sm"
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
              <SelectItem key={s.value} value={s.value}>
                {s.label}
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
                const canCancel = canWrite && row.source === "enrollment" && LIVE_ENROLLMENT_STATUSES.has(row.status);
                return (
                  <TableRow key={`${row.source}:${row.id}`} data-testid="queue-row">
                    <TableCell className="font-medium">{row.contact.name}</TableCell>
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
                            aria-label="Cancelar follow-up"
                            onClick={() => setPendingCancelId(row.id)}
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

      <AlertDialog open={pendingCancelId !== null} onOpenChange={(open) => !open && setPendingCancelId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar este follow-up?</AlertDialogTitle>
            <AlertDialogDescription>
              O lead não receberá mais mensagens deste fluxo. Essa ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (pendingCancelId) cancelMutation.mutate(pendingCancelId);
                setPendingCancelId(null);
              }}
            >
              Cancelar follow-up
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
