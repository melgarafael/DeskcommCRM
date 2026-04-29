"use client";
import Link from "next/link";
import { formatDistanceToNow, format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { CaretLeft } from "@/lib/ui/icons";
import { useAdminIncident } from "@/hooks/useAdminIncident";
import { ResolveIncidentDialog } from "@/components/admin/incidents/ResolveIncidentDialog";
import type { IncidentSeverity, IncidentStatus } from "@/hooks/useAdminIncidents";

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

const SEVERITY_VARIANTS: Record<IncidentSeverity, "error" | "warning" | "info"> = {
  critical: "error",
  warning: "warning",
  info: "info",
};

const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  critical: "Crítico",
  warning: "Atenção",
  info: "Info",
};

const STATUS_VARIANTS: Record<IncidentStatus, "neutral" | "info" | "success"> = {
  open: "neutral",
  acknowledged: "info",
  resolved: "success",
};

const STATUS_LABELS: Record<IncidentStatus, string> = {
  open: "Aberto",
  acknowledged: "Reconhecido",
  resolved: "Resolvido",
};

// ---------------------------------------------------------------------------
// Client component
// ---------------------------------------------------------------------------

interface IncidentDetailClientProps {
  id: string;
}

export function IncidentDetailClient({ id }: IncidentDetailClientProps) {
  const { data, isLoading, error } = useAdminIncident(id);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !data?.data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
        <p className="text-sm font-medium">Incidente não encontrado</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/incidents">
            <CaretLeft size={14} aria-hidden />
            Voltar
          </Link>
        </Button>
      </div>
    );
  }

  const incident = data.data;
  const severity = incident.severity as IncidentSeverity;
  const status = incident.status as IncidentStatus;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <div>
        <Link
          href="/admin/incidents"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <CaretLeft size={14} aria-hidden />
          Incidentes
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight font-mono">
            {incident.type}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={SEVERITY_VARIANTS[severity]}>
              {SEVERITY_LABELS[severity]}
            </Badge>
            <Badge variant={STATUS_VARIANTS[status]}>
              {STATUS_LABELS[status]}
            </Badge>
            {incident.tenant && (
              <Badge variant="neutral" className="font-mono text-xs">
                {incident.tenant.slug}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Criado{" "}
            {formatDistanceToNow(new Date(incident.created_at), {
              addSuffix: true,
              locale: ptBR,
            })}
            {" · "}
            {format(new Date(incident.created_at), "dd/MM/yyyy HH:mm", {
              locale: ptBR,
            })}
          </p>
        </div>

        {status !== "resolved" && (
          <ResolveIncidentDialog incidentId={id} />
        )}
      </div>

      <Separator />

      {/* 2-col layout */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Payload JSON viewer */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Payload</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-auto rounded-md bg-muted p-4 text-xs leading-relaxed max-h-80">
              {JSON.stringify(incident.payload, null, 2)}
            </pre>
          </CardContent>
        </Card>

        {/* Audit timeline */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Audit Trail</CardTitle>
          </CardHeader>
          <CardContent>
            {incident.audit_trail.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nenhuma entrada de auditoria encontrada.
              </p>
            ) : (
              <div className="space-y-3 max-h-80 overflow-auto pr-1">
                {incident.audit_trail.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-start gap-2 text-xs"
                  >
                    <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-muted-foreground/60 mt-1.5" />
                    <div className="min-w-0 flex-1">
                      <span className="font-mono text-muted-foreground">
                        {entry.action}
                      </span>
                      <span className="ml-2 text-muted-foreground/70">
                        {format(new Date(entry.created_at), "dd/MM HH:mm:ss", {
                          locale: ptBR,
                        })}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Resolution note (if resolved) */}
      {status === "resolved" && incident.resolution_note && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Resolução</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-foreground whitespace-pre-wrap">
              {incident.resolution_note}
            </p>
            {incident.resolved_at && (
              <p className="text-xs text-muted-foreground">
                Resolvido em{" "}
                {format(new Date(incident.resolved_at), "dd/MM/yyyy HH:mm", {
                  locale: ptBR,
                })}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
