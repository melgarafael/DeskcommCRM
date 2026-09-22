"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Users } from "@/lib/ui/icons";
import type { AdminUserRow } from "@/hooks/useAdminUsers";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Role badge
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
  const t = useT();
  return (
    <Badge variant={ROLE_VARIANTS[role] ?? "neutral"}>
      {t(ROLE_LABELS[role] ?? role)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeDate(iso: string | null, locale: Locale): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), {
      addSuffix: true,
      locale: locale,
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export function UsersTableAdminSkeleton() {
  const t = useT();
  return (
    <div className="rounded-3xl border">
      <Table>
        <TableHeader>
          <TableRow>
            {["Email", t("Nome"), "Tenant", "Role", t("Último acesso"), t("Status"), ""].map(
              (h) => (
                <TableHead key={h}>{h}</TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              {Array.from({ length: 7 }).map((__, j) => (
                <TableCell key={j}>
                  <Skeleton className="h-4 w-full max-w-[140px]" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface UsersTableAdminProps {
  data: AdminUserRow[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

export function UsersTableAdmin({
  data,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: UsersTableAdminProps) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  if (data.length === 0) {
    return (
      <EmptyState
        icon={Users}
        headline="Nenhum usuário encontrado"
        subcopy="Ajuste os filtros para refinar a busca."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead className="w-[160px]">{t("Nome")}</TableHead>
              <TableHead className="w-[160px]">Tenant</TableHead>
              <TableHead className="w-[100px]">Role</TableHead>
              <TableHead className="w-[160px]">{t("Último acesso")}</TableHead>
              <TableHead className="w-[100px]">{t("Status")}</TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={`${row.user_id}:${row.organization_id}`}>
                <TableCell className="font-mono text-xs">
                  {row.email ?? "—"}
                </TableCell>
                <TableCell className="font-medium">
                  {row.full_name ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium">{row.tenant_name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {row.tenant_slug}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <RoleBadge role={row.role} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {relativeDate(row.last_sign_in_at, localeDaData)}
                </TableCell>
                <TableCell>
                  {row.revoked_at ? (
                    <Badge variant="error">{t("Revogado")}</Badge>
                  ) : (
                    <Badge variant="success">{t("Ativo")}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Link
                    href={`/admin/users/${row.user_id}`}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    {t("Ver")}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? t("Carregando...") : t("Carregar mais")}
          </Button>
        </div>
      )}
    </div>
  );
}
