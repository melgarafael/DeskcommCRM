"use client";
import Link from "next/link";
import { formatDistanceToNow, format } from "date-fns";
import { pt as ptBR } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CaretLeft } from "@/lib/ui/icons";
import { useAdminUser } from "@/hooks/useAdminUser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROLE_VARIANTS: Record<
  string,
  "success" | "info" | "warning" | "error" | "neutral"
> = {
  admin: "error",
  manager: "warning",
  agent: "info",
  viewer: "neutral",
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  agent: "Agente",
  viewer: "Viewer",
};

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge variant={ROLE_VARIANTS[role] ?? "neutral"}>
      {ROLE_LABELS[role] ?? role}
    </Badge>
  );
}

function relativeDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ptBR });
  } catch {
    return iso;
  }
}

function absoluteDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "dd/MM/yyyy HH:mm", { locale: ptBR });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface UserDetailClientProps {
  id: string;
}

export function UserDetailClient({ id }: UserDetailClientProps) {
  const { data, isLoading, isError } = useAdminUser(id);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !data?.data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
        <p className="text-sm font-medium">Usuário não encontrado</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/users">
            <CaretLeft size={14} aria-hidden />
            Voltar
          </Link>
        </Button>
      </div>
    );
  }

  const { user, memberships, recent_audit } = data.data;
  const hasMfa = user.factors.some((f) => f.status === "verified");

  return (
    <div className="space-y-6">
      {/* Back link */}
      <div>
        <Link
          href="/admin/users"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <CaretLeft size={14} aria-hidden />
          Usuários
        </Link>
      </div>

      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {user.full_name ?? user.email ?? "Usuário sem nome"}
        </h1>
        {user.full_name && (
          <p className="font-mono text-sm text-muted-foreground">{user.email}</p>
        )}
        <p className="text-xs text-muted-foreground font-mono">{user.id}</p>
      </div>

      <Separator />

      {/* User info card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Informações do usuário</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground mb-0.5">Email confirmado</dt>
              <dd>{user.email_confirmed_at ? absoluteDate(user.email_confirmed_at) : <Badge variant="warning">Pendente</Badge>}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground mb-0.5">Último acesso</dt>
              <dd className="text-sm">{relativeDate(user.last_sign_in_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground mb-0.5">Criado em</dt>
              <dd className="text-sm">{absoluteDate(user.created_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground mb-0.5">MFA</dt>
              <dd>
                {hasMfa ? (
                  <Badge variant="success">Ativo</Badge>
                ) : (
                  <Badge variant="neutral">Inativo</Badge>
                )}
              </dd>
            </div>
            {user.phone && (
              <div>
                <dt className="text-xs text-muted-foreground mb-0.5">Telefone</dt>
                <dd className="font-mono text-sm">{user.phone}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Memberships table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Memberships ({memberships.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {memberships.length === 0 ? (
            <p className="px-6 py-4 text-xs text-muted-foreground">
              Sem memberships registrados.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead className="w-[100px]">Role</TableHead>
                  <TableHead className="w-[140px]">Aceito em</TableHead>
                  <TableHead className="w-[100px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {memberships.map((m) => (
                  <TableRow key={m.organization_id}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <Link
                          href={`/admin/tenants/${m.organization_id}`}
                          className="text-sm font-medium text-accent hover:underline"
                        >
                          {m.tenant_name ?? m.organization_id}
                        </Link>
                        {m.tenant_slug && (
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {m.tenant_slug}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <RoleBadge role={m.role} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {absoluteDate(m.accepted_at)}
                    </TableCell>
                    <TableCell>
                      {m.revoked_at ? (
                        <Badge variant="error">Revogado</Badge>
                      ) : (
                        <Badge variant="success">Ativo</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Recent audit timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Audit recente ({recent_audit.length}{recent_audit.length === 50 ? "+" : ""})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recent_audit.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nenhuma entrada de auditoria encontrada para este usuário.
            </p>
          ) : (
            <div className="space-y-3 max-h-96 overflow-auto pr-1">
              {recent_audit.map((entry) => (
                <div key={entry.id} className="flex items-start gap-2 text-xs">
                  <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-muted-foreground/50" />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-muted-foreground">
                        {entry.action}
                      </span>
                      <span className="text-muted-foreground/60">
                        {format(new Date(entry.created_at), "dd/MM HH:mm:ss", {
                          locale: ptBR,
                        })}
                      </span>
                    </div>
                    {entry.resource_type && (
                      <p className="text-muted-foreground/60">
                        {entry.resource_type}
                        {entry.resource_id ? ` · ${entry.resource_id.slice(0, 8)}…` : ""}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
