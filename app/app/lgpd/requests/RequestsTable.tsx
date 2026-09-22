"use client";
import { useState } from "react";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
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
import { Warning } from "@/lib/ui/icons";
import {
  useLgpdRequests,
  type LgpdRequestStatus,
  type LgpdRequestType,
  type SlaBucket,
} from "@/hooks/useLgpdRequests";
import { SlaBanner } from "./SlaBanner";

// ── Label helpers ─────────────────────────────────────────────────────────────

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

// ── Date helpers ──────────────────────────────────────────────────────────────

function fmtRelative(iso: string, t: (texto: string) => string): string {
  try {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return t("agora");
    if (diffMin < 60) return `${diffMin}${t("min atrás")}`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}${t("h atrás")}`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}${t("d atrás")}`;
  } catch {
    return iso;
  }
}

function fmtDistance(
  iso: string | null,
  t: (texto: string) => string,
): { label: string; urgent: boolean } {
  if (!iso) return { label: "—", urgent: false };
  try {
    const now = Date.now();
    const due = new Date(iso).getTime();
    const diffMs = due - now;
    const urgent = diffMs < 2 * 24 * 60 * 60 * 1000;
    if (diffMs < 0) {
      const overMs = Math.abs(diffMs);
      const overD = Math.floor(overMs / 86_400_000);
      return { label: overD > 0 ? `${overD}${t("d atrasado")}` : t("atrasado hoje"), urgent: true };
    }
    const diffD = Math.floor(diffMs / 86_400_000);
    if (diffD < 1) {
      const diffH = Math.floor(diffMs / 3_600_000);
      return { label: `${t("em")} ${diffH}h`, urgent };
    }
    return { label: `${t("em")} ${diffD}d`, urgent };
  } catch {
    return { label: iso, urgent: false };
  }
}

// ── Select options ────────────────────────────────────────────────────────────

const ALL = "__ALL__";

// ── Component ─────────────────────────────────────────────────────────────────

export function RequestsTable() {
  const t = useT();
  const [status, setStatus] = useState<LgpdRequestStatus | undefined>();
  const [type, setType] = useState<LgpdRequestType | undefined>();
  const [slaBucket, setSlaBucket] = useState<SlaBucket | undefined>();
  const [page, setPage] = useState(1);

  const q = useLgpdRequests({ status, type, sla_bucket: slaBucket, page, limit: 25 });
  const rows = q.data?.data ?? [];
  const meta = q.data?.meta;

  return (
    <div className="flex flex-col gap-4">
      {/* SLA Banner — shown based on full current page data */}
      {!q.isLoading && rows.length > 0 && <SlaBanner requests={rows} />}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <Select
          value={status ?? ALL}
          onValueChange={(v) => {
            setStatus(v === ALL ? undefined : (v as LgpdRequestStatus));
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-[170px]">
            <SelectValue placeholder={t("Status: todos")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("Status: todos")}</SelectItem>
            <SelectItem value="received">{t(STATUS_LABELS.received)}</SelectItem>
            <SelectItem value="processing">{t(STATUS_LABELS.processing)}</SelectItem>
            <SelectItem value="completed">{t(STATUS_LABELS.completed)}</SelectItem>
            <SelectItem value="failed">{t(STATUS_LABELS.failed)}</SelectItem>
            <SelectItem value="pending_review">{t(STATUS_LABELS.pending_review)}</SelectItem>
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
            <SelectValue placeholder={t("Tipo: todos")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("Tipo: todos")}</SelectItem>
            <SelectItem value="redact">{t(TYPE_LABELS.redact)}</SelectItem>
            <SelectItem value="data_request">{t(TYPE_LABELS.data_request)}</SelectItem>
            <SelectItem value="store_redact">{t(TYPE_LABELS.store_redact)}</SelectItem>
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
            <SelectValue placeholder={t("SLA: todos")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("SLA: todos")}</SelectItem>
            <SelectItem value="overdue">{t(SLA_LABELS.overdue)}</SelectItem>
            <SelectItem value="critical">{t(SLA_LABELS.critical)}</SelectItem>
            <SelectItem value="warning">{t(SLA_LABELS.warning)}</SelectItem>
            <SelectItem value="ok">{SLA_LABELS.ok}</SelectItem>
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
            {t("Limpar filtros")}
          </Button>
        )}

        {meta && (
          <span className="ml-auto text-xs text-muted-foreground">
            {meta.total} {t(meta.total === 1 ? "solicitação" : "solicitações")}
          </span>
        )}
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[90px]">ID</TableHead>
              <TableHead>{t("Tipo")}</TableHead>
              <TableHead>{t("Sujeito")}</TableHead>
              <TableHead>{t("Recebido")}</TableHead>
              <TableHead>{t("Vence")}</TableHead>
              <TableHead>SLA</TableHead>
              <TableHead>{t("Status")}</TableHead>
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
                    <Warning size={24} weight="fill" className="text-error" aria-hidden />
                    <p>{t("Erro ao carregar solicitações.")}</p>
                    <Button size="sm" variant="outline" onClick={() => q.refetch()}>
                      {t("Tentar novamente")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center">
                  <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
                    <Warning size={32} weight="thin" aria-hidden />
                    <p className="font-medium">{t("Nenhuma solicitação LGPD")}</p>
                    <p className="text-xs">
                      {t("Solicitações de dados e anonimizações aparecerão aqui.")}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const due = fmtDistance(r.due_at, t);
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
                        {t(TYPE_LABELS[r.request_type] ?? r.request_type)}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[140px] truncate font-mono text-xs">
                      {subject}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {fmtRelative(r.received_at, t)}
                    </TableCell>
                    <TableCell
                      className={`whitespace-nowrap text-xs font-medium ${due.urgent ? "text-error-fg" : "text-muted-foreground"}`}
                    >
                      {due.label}
                    </TableCell>
                    <TableCell>
                      <Badge variant={SLA_VARIANT[r.sla_bucket]} className="text-xs">
                        {t(SLA_LABELS[r.sla_bucket])}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={STATUS_VARIANT[r.status]}
                        className="whitespace-nowrap text-xs"
                      >
                        {t(STATUS_LABELS[r.status] ?? r.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                        <Link href={`/app/lgpd/requests/${r.id}`}>{t("Ver")}</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Pagination */}
      {meta && (meta.page > 1 || meta.has_more) && (
        <div className="flex items-center justify-between text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || q.isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t("Anterior")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("Página")} {meta.page}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!meta.has_more || q.isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("Próxima")}
          </Button>
        </div>
      )}
    </div>
  );
}
