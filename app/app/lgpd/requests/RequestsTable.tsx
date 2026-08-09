"use client";
import { useState } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  MobileCardList,
  MobileCardRow,
  MobileCardField,
} from "@/components/ui/responsive-table";
import { Warning } from "@/lib/ui/icons";
import {
  useLgpdRequests,
  type LgpdRequestStatus,
  type LgpdRequestType,
  type SlaBucket,
} from "@/hooks/useLgpdRequests";
import { SlaBanner } from "./SlaBanner";

const TYPE_LABELS: Record<LgpdRequestType, string> = {
  redact: "Anonimização cliente",
  data_request: "Solicitação dados",
  store_redact: "Anonimização tenant",
};

const STATUS_LABELS: Record<LgpdRequestStatus, string> = {
  received: "Recebido",
  processing: "Processando",
  completed: "Concluído",
  failed: "Falhou",
  pending_review: "Revisão pendente",
};

const STATUS_VARIANT: Record<
  LgpdRequestStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  received: "secondary",
  processing: "secondary",
  completed: "default",
  failed: "destructive",
  pending_review: "outline",
};

const SLA_VARIANT: Record<
  SlaBucket,
  "default" | "secondary" | "destructive" | "outline"
> = {
  overdue: "destructive",
  critical: "destructive",
  warning: "outline",
  ok: "default",
};

const SLA_LABELS: Record<SlaBucket, string> = {
  overdue: "Vencido",
  critical: "Crítico",
  warning: "Alerta",
  ok: "OK",
};

function fmtRelative(iso: string): string {
  try {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "agora";
    if (diffMin < 60) return `${diffMin}min atrás`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h atrás`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d atrás`;
  } catch {
    return iso;
  }
}

function fmtDistance(iso: string | null): { label: string; urgent: boolean } {
  if (!iso) return { label: "—", urgent: false };
  try {
    const now = Date.now();
    const due = new Date(iso).getTime();
    const diffMs = due - now;
    const urgent = diffMs < 2 * 24 * 60 * 60 * 1000;
    if (diffMs < 0) {
      const overMs = Math.abs(diffMs);
      const overD = Math.floor(overMs / 86_400_000);
      return { label: overD > 0 ? `${overD}d atrasado` : "atrasado hoje", urgent: true };
    }
    const diffD = Math.floor(diffMs / 86_400_000);
    if (diffD < 1) {
      const diffH = Math.floor(diffMs / 3_600_000);
      return { label: `em ${diffH}h`, urgent };
    }
    return { label: `em ${diffD}d`, urgent };
  } catch {
    return { label: iso, urgent: false };
  }
}

const ALL = "__ALL__";

export function RequestsTable() {
  const [status, setStatus] = useState<LgpdRequestStatus | undefined>();
  const [type, setType] = useState<LgpdRequestType | undefined>();
  const [slaBucket, setSlaBucket] = useState<SlaBucket | undefined>();
  const [page, setPage] = useState(1);

  const q = useLgpdRequests({ status, type, sla_bucket: slaBucket, page, limit: 25 });
  const rows = q.data?.data ?? [];
  const meta = q.data?.meta;

  return (
    <div className="flex flex-col gap-4">
      {!q.isLoading && rows.length > 0 && <SlaBanner requests={rows} />}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <Select
          value={status ?? ALL}
          onValueChange={(v) => {
            setStatus(v === ALL ? undefined : (v as LgpdRequestStatus));
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-[170px]">
            <SelectValue placeholder="Status: todos" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Status: todos</SelectItem>
            <SelectItem value="received">Recebido</SelectItem>
            <SelectItem value="processing">Processando</SelectItem>
            <SelectItem value="completed">Concluído</SelectItem>
            <SelectItem value="failed">Falhou</SelectItem>
            <SelectItem value="pending_review">Revisão pendente</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={type ?? ALL}
          onValueChange={(v) => {
            setType(v === ALL ? undefined : (v as LgpdRequestType));
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue placeholder="Tipo: todos" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tipo: todos</SelectItem>
            <SelectItem value="redact">Anonimização cliente</SelectItem>
            <SelectItem value="data_request">Solicitação dados</SelectItem>
            <SelectItem value="store_redact">Anonimização tenant</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={slaBucket ?? ALL}
          onValueChange={(v) => {
            setSlaBucket(v === ALL ? undefined : (v as SlaBucket));
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-[160px]">
            <SelectValue placeholder="SLA: todos" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>SLA: todos</SelectItem>
            <SelectItem value="overdue">Vencido</SelectItem>
            <SelectItem value="critical">Crítico</SelectItem>
            <SelectItem value="warning">Alerta</SelectItem>
            <SelectItem value="ok">OK</SelectItem>
          </SelectContent>
        </Select>

        {(status || type || slaBucket) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus(undefined);
              setType(undefined);
              setSlaBucket(undefined);
              setPage(1);
            }}
          >
            Limpar filtros
          </Button>
        )}

        {meta && (
          <span className="ml-auto text-xs text-muted-foreground">
            {meta.total} {meta.total === 1 ? "solicitação" : "solicitações"}
          </span>
        )}
      </div>

      <Card className="hidden overflow-hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[90px]">ID</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Sujeito</TableHead>
              <TableHead>Recebido</TableHead>
              <TableHead>Vence</TableHead>
              <TableHead>SLA</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 8 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : q.isError ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center">
                  <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
                    <Warning size={24} weight="fill" className="text-red-500" aria-hidden />
                    <p>Erro ao carregar solicitações.</p>
                    <Button size="sm" variant="outline" onClick={() => q.refetch()}>
                      Tentar novamente
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center">
                  <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
                    <Warning size={32} weight="thin" aria-hidden />
                    <p className="font-medium">Nenhuma solicitação LGPD</p>
                    <p className="text-xs">
                      Solicitações de dados e anonimizações aparecerão aqui.
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const due = fmtDistance(r.due_at);
                const subject = r.external_customer_id
                  ? r.external_customer_id.slice(0, 16)
                  : r.contact_id
                    ? `ctt:${r.contact_id.slice(0, 8)}`
                    : "—";

                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.id.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="whitespace-nowrap text-xs">
                        {TYPE_LABELS[r.request_type] ?? r.request_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[140px] truncate font-mono text-xs">
                      {subject}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {fmtRelative(r.received_at)}
                    </TableCell>
                    <TableCell
                      className={`whitespace-nowrap text-xs font-medium ${due.urgent ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
                    >
                      {due.label}
                    </TableCell>
                    <TableCell>
                      <Badge variant={SLA_VARIANT[r.sla_bucket]} className="text-xs">
                        {SLA_LABELS[r.sla_bucket]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={STATUS_VARIANT[r.status]}
                        className="whitespace-nowrap text-xs"
                      >
                        {STATUS_LABELS[r.status] ?? r.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                        <Link href={`/app/lgpd/requests/${r.id}`}>Ver</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <MobileCardList className="md:hidden">
        {q.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-3">
              <Skeleton className="h-20 w-full" />
            </Card>
          ))
        ) : q.isError ? (
          <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
            <Warning size={24} weight="fill" className="text-red-500" aria-hidden />
            <p>Erro ao carregar solicitações.</p>
            <Button size="sm" variant="outline" onClick={() => q.refetch()}>
              Tentar novamente
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
            <Warning size={32} weight="thin" aria-hidden />
            <p className="font-medium">Nenhuma solicitação LGPD</p>
          </div>
        ) : (
          rows.map((r) => {
            const due = fmtDistance(r.due_at);
            const subject = r.external_customer_id
              ? r.external_customer_id.slice(0, 16)
              : r.contact_id
                ? `ctt:${r.contact_id.slice(0, 8)}`
                : "—";
            return (
              <MobileCardRow key={r.id}>
                <MobileCardField label="Tipo">
                  <Badge variant="secondary" className="text-xs">
                    {TYPE_LABELS[r.request_type] ?? r.request_type}
                  </Badge>
                </MobileCardField>
                <MobileCardField label="Sujeito">{subject}</MobileCardField>
                <MobileCardField label="Recebido">{fmtRelative(r.received_at)}</MobileCardField>
                <MobileCardField label="Vence">
                  <span className={due.urgent ? "text-red-600 dark:text-red-400" : undefined}>
                    {due.label}
                  </span>
                </MobileCardField>
                <MobileCardField label="SLA">
                  <Badge variant={SLA_VARIANT[r.sla_bucket]} className="text-xs">
                    {SLA_LABELS[r.sla_bucket]}
                  </Badge>
                </MobileCardField>
                <MobileCardField label="Status">
                  <Badge variant={STATUS_VARIANT[r.status]} className="text-xs">
                    {STATUS_LABELS[r.status] ?? r.status}
                  </Badge>
                </MobileCardField>
                <Link
                  href={`/app/lgpd/requests/${r.id}`}
                  className="mt-1 text-right text-xs text-accent-foreground underline"
                >
                  Ver detalhe
                </Link>
              </MobileCardRow>
            );
          })
        )}
      </MobileCardList>

      {meta && (meta.page > 1 || meta.has_more) && (
        <div className="flex items-center justify-between text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || q.isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Anterior
          </Button>
          <span className="text-xs text-muted-foreground">
            Página {meta.page}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!meta.has_more || q.isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            Próxima
          </Button>
        </div>
      )}
    </div>
  );
}
