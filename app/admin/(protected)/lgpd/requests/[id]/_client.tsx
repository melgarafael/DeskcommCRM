"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import Link from "next/link";
import { format } from "date-fns";
import { CaretLeft } from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantBadge } from "@/components/admin/inbox/TenantBadge";
import { useAdminLgpdRequest } from "@/hooks/useAdminLgpdRequest";
import type { AdminLgpdStatus, AdminLgpdRequestType } from "@/hooks/useAdminLGPDRequests";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Inline SLA Timeline (simplified — no approve button, admin observe-only)
// ---------------------------------------------------------------------------

interface SlaTimelineProps {
  received_at: string;
  due_at: string;
  request_type: string;
}

function SlaTimelineInline({ received_at, due_at, request_type }: SlaTimelineProps) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const receivedAt = new Date(received_at);
  const dueAt = new Date(due_at);
  const now = new Date();

  const elapsed = now.getTime() - receivedAt.getTime();
  const total = dueAt.getTime() - receivedAt.getTime();
  const progress = Math.min(1, Math.max(0, total > 0 ? elapsed / total : 0));
  const progressPct = Math.round(progress * 100);

  const daysElapsed = Math.floor(elapsed / (1000 * 60 * 60 * 24));
  const msUntilDue = dueAt.getTime() - now.getTime();
  const daysRemaining = Math.floor(msUntilDue / (1000 * 60 * 60 * 24));

  const progressColor =
    progress >= 1 ? "bg-red-500" : progress >= 0.75 ? "bg-yellow-500" : "bg-emerald-500";

  const milestones =
    request_type === "data_request"
      ? [
          { label: t("Recebido"), day: 0 },
          { label: t("Revisão intermediária"), day: 5 },
          { label: t("Entrega ao titular"), day: 7 },
        ]
      : [
          { label: t("Recebido"), day: 0 },
          { label: t("Processamento"), day: 10 },
          { label: t("Anonimização concluída"), day: 15 },
        ];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>D+{daysElapsed} ({t("hoje")})</span>
          <span>
            {daysRemaining > 0
              ? `${daysRemaining}d ${t("restantes")}`
              : daysRemaining === 0
                ? t("vence hoje")
                : `${Math.abs(daysRemaining)}d ${t("em atraso")}`}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${progressColor}`}
            style={{ width: `${progressPct}%` }}
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </div>

      <ol className="relative space-y-0">
        {milestones.map((m, idx) => {
          const milestoneDate = new Date(
            receivedAt.getTime() + m.day * 24 * 60 * 60 * 1000,
          );
          const isPast = milestoneDate.getTime() < now.getTime();
          const isLast = idx === milestones.length - 1;
          const dotColor = isPast
            ? "bg-emerald-500 border-emerald-500"
            : "bg-muted border-border";

          return (
            <li key={m.day} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div
                  className={`mt-0.5 h-3 w-3 rounded-full border-2 ${dotColor}`}
                  aria-hidden
                />
                {!isLast && <div className="mt-1 h-8 w-px bg-border" aria-hidden />}
              </div>
              <div className={`pb-1 text-sm ${isLast ? "" : "pb-3"}`}>
                <p className="leading-tight text-muted-foreground">
                  D+{m.day} — {m.label}
                </p>
                <p className="text-xs text-muted-foreground opacity-70">
                  {format(milestoneDate, "dd 'de' MMM yyyy", { locale: localeDaData })}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline audit trail
// ---------------------------------------------------------------------------

interface AuditEntry {
  id: string;
  action: string;
  actor_user_id: string | null;
  created_at: string;
}

function AuditTrailInline({ entries }: { entries: AuditEntry[] }) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("Nenhuma entrada de auditoria registrada para esta solicitação.")}
      </p>
    );
  }

  return (
    <ol className="relative space-y-0">
      {entries.map((entry, idx) => {
        const isLast = idx === entries.length - 1;
        return (
          <li key={entry.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div
                className="mt-1 h-2 w-2 rounded-full bg-border ring-2 ring-background"
                aria-hidden
              />
              {!isLast && (
                <div className="mt-1 h-full min-h-[24px] w-px bg-border" aria-hidden />
              )}
            </div>
            <div className={`pb-3 min-w-0 flex-1 ${isLast ? "pb-0" : ""}`}>
              <p className="text-sm font-mono font-medium truncate">{entry.action}</p>
              <p className="text-xs text-muted-foreground">
                {format(new Date(entry.created_at), "dd/MM/yyyy HH:mm:ss", { locale: localeDaData })}
                {entry.actor_user_id && (
                  <span className="ml-2 opacity-60">
                    {t("por")} {entry.actor_user_id.slice(0, 8)}…
                  </span>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<AdminLgpdRequestType, string> = {
  redact: "Anonimização cliente",
  data_request: "Solicitação de dados",
  store_redact: "Anonimização tenant",
};

const STATUS_LABELS: Record<AdminLgpdStatus, string> = {
  received: "Recebido",
  processing: "Processando",
  completed: "Concluído",
  failed: "Falhou",
  pending_review: "Revisão pendente",
};

const STATUS_VARIANT: Record<
  AdminLgpdStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  received: "secondary",
  processing: "default",
  completed: "outline",
  failed: "destructive",
  pending_review: "secondary",
};

// ---------------------------------------------------------------------------
// Row helper
// ---------------------------------------------------------------------------

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right truncate ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main client component
// ---------------------------------------------------------------------------

interface Props {
  id: string;
}

export function LgpdRequestAdminDetail({ id }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const { data, isLoading, error } = useAdminLgpdRequest(id);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-48 rounded-lg" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {t("Falha ao carregar solicitação.")}
      </div>
    );
  }

  const { request, tenant, audit_trail } = data.data;

  const shortId = request.id.slice(0, 8);
  const typeLabel = t(TYPE_LABELS[request.request_type] ?? request.request_type);
  const statusLabel = t(STATUS_LABELS[request.status] ?? request.status);

  return (
    <div className="flex flex-col gap-6">
      {/* Back nav */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="-ml-2 gap-1 text-muted-foreground"
        >
          <Link href="/admin/lgpd">
            <CaretLeft size={14} aria-hidden />
            {t("Proteção de Dados Cross-tenant")}
          </Link>
        </Button>
      </div>

      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight font-mono">#{shortId}</h1>
          <Badge variant={STATUS_VARIANT[request.status] ?? "secondary"}>{statusLabel}</Badge>
          <Badge variant="outline">{typeLabel}</Badge>
          {request.emergency && <Badge variant="destructive">{t("Urgente")}</Badge>}
          {tenant && <TenantBadge name={tenant.display_name} slug={tenant.slug} />}
        </div>

        <p className="text-sm text-muted-foreground">
          {t("Recebido em")}{" "}
          {format(new Date(request.received_at), `dd/MM/yyyy '${t("às")}' HH:mm`, { locale: localeDaData })}
          {request.due_at && (
            <>
              {" · "}
              {t("Vence em")} {format(new Date(request.due_at), "dd/MM/yyyy", { locale: localeDaData })}
            </>
          )}
        </p>

        <p className="text-xs text-muted-foreground italic">
          {t("Somente leitura — aprovação é feita pelo operador no contexto do tenant.")}
        </p>
      </div>

      {/* 2-col grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* SLA Timeline */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t("Linha do tempo SLA")}</CardTitle>
          </CardHeader>
          <CardContent>
            {request.due_at ? (
              <SlaTimelineInline
                received_at={request.received_at}
                due_at={request.due_at}
                request_type={request.request_type}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("SLA não definido.")}</p>
            )}
          </CardContent>
        </Card>

        {/* Details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t("Detalhes")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label={t("ID completo")} value={request.id} mono />
            <Row label={t("Tipo")} value={typeLabel} />
            <Row label={t("Status")} value={statusLabel} />
            <Row label={t("Origem")} value={(request as { source?: string | null }).source ?? "—"} />
            <Row label={t("Escopo")} value={request.scope} />
            <Row label={t("Tentativas")} value={String(request.attempts)} />
            {tenant && (
              <>
                <Row label="Tenant" value={tenant.display_name} />
                <Row label="Slug" value={tenant.slug} />
              </>
            )}
            {request.contact_id && (
              <Row label="Contact ID" value={request.contact_id} mono />
            )}
            {request.external_customer_id && (
              <Row label="External customer ID" value={request.external_customer_id} />
            )}
            {request.completed_at && (
              <Row
                label={t("Concluído em")}
                value={format(new Date(request.completed_at), "dd/MM/yyyy HH:mm", {
                  locale: localeDaData,
                })}
              />
            )}
            {request.error_message && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1">
                <p className="text-xs text-muted-foreground">{t("Erro")}</p>
                <p className="text-destructive text-xs">{request.error_message}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Audit trail — spans both cols */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              {t("Trilha de auditoria")} ({audit_trail.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AuditTrailInline entries={audit_trail} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
