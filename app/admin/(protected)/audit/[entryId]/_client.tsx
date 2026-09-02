"use client";
import Link from "next/link";
import { formatDistanceToNow, format } from "date-fns";
import { pt as ptBR } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CaretLeft } from "@/lib/ui/icons";
import { useAdminAuditEntry } from "@/hooks/useAdminAuditEntry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskEmail(email: string | null | undefined): string {
  if (!email) return "—";
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const first = local[0] ?? "";
  const masked = `${first}${"*".repeat(Math.min(local.length - 1, 4))}`;
  return `${masked}@${domain}`;
}

function formatDate(iso: string): string {
  try {
    return format(new Date(iso), "dd/MM/yyyy HH:mm:ss", { locale: ptBR });
  } catch {
    return iso;
  }
}

function relativeDate(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ptBR });
  } catch {
    return iso;
  }
}

/** Resolve a deep-link URL for known resource types */
function resourceDeepLink(
  resourceType: string | null | undefined,
  resourceId: string | null | undefined,
): string | null {
  if (!resourceType || !resourceId) return null;
  switch (resourceType) {
    case "conversation":
      return `/admin/inbox/${resourceId}`;
    case "organization":
      return `/admin/tenants/${resourceId}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AuditDetailClientProps {
  entryId: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditDetailClient({ entryId }: AuditDetailClientProps) {
  const { data, isLoading, isError } = useAdminAuditEntry(entryId);
  const detail = data?.data;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      </div>
    );
  }

  if (isError || !detail) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center text-sm text-destructive">
        Entrada de audit não encontrada.
      </div>
    );
  }

  const { entry, tenant, actor } = detail;
  const deepLink = resourceDeepLink(entry.resource_type, entry.resource_id);

  return (
    <div className="space-y-6">
      {/* Back */}
      <Button asChild variant="ghost" size="sm" className="gap-1.5 -ml-2">
        <Link href="/admin/audit">
          <CaretLeft size={14} aria-hidden />
          Audit Log
        </Link>
      </Button>

      {/* Header */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold">{entry.action}</h1>
          {tenant && (
            <Badge variant="neutral" className="font-mono text-xs">
              {tenant.slug}
            </Badge>
          )}
          {entry.acting_as_platform_admin && (
            <Badge variant="warning" className="text-xs">
              Platform Admin
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {formatDate(entry.created_at)}&nbsp;·&nbsp;{relativeDate(entry.created_at)}
        </p>
      </div>

      {/* Body — 2 columns */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Metadata JSON viewer */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Metadata</h2>
          <pre className="overflow-auto rounded-md border bg-muted/40 p-4 text-xs leading-relaxed">
            {JSON.stringify(entry.metadata, null, 2)}
          </pre>

          {/* Extra entry fields */}
          <div className="rounded-md border p-4 space-y-2 text-sm">
            <Row label="Request ID" value={entry.request_id ?? "—"} mono />
            <Row label="Resource Type" value={entry.resource_type ?? "—"} />
            <Row label="Resource ID" value={entry.resource_id ?? "—"} mono />
            <Row label="Bypassed RLS" value={entry.bypassed_rls ? "Sim" : "Não"} />
            <Row label="Actor IP" value={entry.actor_ip ?? "—"} mono />
            <Row
              label="User Agent"
              value={entry.actor_user_agent ?? "—"}
              truncate
            />
          </div>
        </div>

        {/* Right sidebar: actor + tenant + resource link */}
        <div className="space-y-4">
          {/* Actor card */}
          <div className="rounded-md border p-4 space-y-2">
            <h2 className="text-sm font-medium">Actor</h2>
            {actor ? (
              <div className="space-y-1 text-sm">
                <Row label="User ID" value={actor.id} mono />
                <Row label="Email" value={maskEmail(actor.email)} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {entry.actor_user_id
                  ? `ID: ${entry.actor_user_id}`
                  : "Sem actor registrado"}
              </p>
            )}
          </div>

          {/* Tenant card */}
          {tenant && (
            <div className="rounded-md border p-4 space-y-2">
              <h2 className="text-sm font-medium">Tenant</h2>
              <div className="space-y-1 text-sm">
                <Row label="Nome" value={tenant.display_name} />
                <Row label="Slug" value={tenant.slug} mono />
                <Row label="Status" value={tenant.status} />
              </div>
              <Button asChild variant="outline" size="sm" className="mt-2">
                <Link href={`/admin/tenants/${tenant.id}`}>
                  Ver tenant
                </Link>
              </Button>
            </div>
          )}

          {/* Resource deep link */}
          {deepLink && (
            <div className="rounded-md border p-4">
              <h2 className="text-sm font-medium mb-2">Recurso</h2>
              <p className="text-sm text-muted-foreground mb-3">
                {entry.resource_type}&nbsp;·&nbsp;
                <span className="font-mono">{entry.resource_id}</span>
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href={deepLink}>
                  Abrir recurso
                </Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row helper
// ---------------------------------------------------------------------------

function Row({
  label,
  value,
  mono,
  truncate,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span
        className={`flex-1 break-all ${mono ? "font-mono" : ""} ${truncate ? "truncate" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
