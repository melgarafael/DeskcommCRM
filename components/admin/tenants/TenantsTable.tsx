"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import Link from "next/link";
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
import { Buildings } from "@/lib/ui/icons";
import type { AdminTenantRow } from "@/hooks/useAdminTenants";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_VARIANTS: Record<
  string,
  "success" | "info" | "warning" | "error" | "neutral"
> = {
  active: "success",
  onboarding: "info",
  suspended: "warning",
  redacted: "error",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Ativo",
  onboarding: "Onboarding",
  suspended: "Suspenso",
  redacted: "Redigido",
};

function StatusBadge({
  status,
  onboardedAt,
}: {
  status: string;
  onboardedAt: string | null;
}) {
  const t = useT();
  // 'onboarding' não existe no banco — é derivado: ativo sem onboarding concluído.
  const effective = status === "active" && !onboardedAt ? "onboarding" : status;
  return (
    <Badge variant={STATUS_VARIANTS[effective] ?? "neutral"}>
      {t(STATUS_LABELS[effective] ?? effective)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null, idioma: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(idioma, {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).format(new Date(iso));
}

function extractCount(
  arr: Array<{ count: number }> | null | undefined,
): number {
  if (!arr || arr.length === 0) return 0;
  return arr[0]?.count ?? 0;
}

function shortCnpj(cnpj: string | null): string {
  if (!cnpj) return "—";
  // Show first 8 digits (company root) + ...
  const digits = cnpj.replace(/\D/g, "");
  if (digits.length < 8) return cnpj;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/...`;
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

export function TenantsTableSkeleton() {
  const t = useT();
  return (
    <div className="rounded-3xl border">
      <Table>
        <TableHeader>
          <TableRow>
            {["Slug", t("Nome"), "CNPJ", t("Status"), t("Users"), t("Conversas"), t("Criado em"), ""].map(
              (h) => (
                <TableHead key={h}>{h}</TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              {Array.from({ length: 8 }).map((__, j) => (
                <TableCell key={j}>
                  <Skeleton className="h-4 w-full max-w-[120px]" />
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

interface TenantsTableProps {
  data: AdminTenantRow[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

export function TenantsTable({
  data,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: TenantsTableProps) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  if (data.length === 0) {
    return (
      <EmptyState
        icon={Buildings}
        headline="Nenhum tenant encontrado"
        subcopy="Ajuste os filtros ou crie um novo tenant."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[140px]">Slug</TableHead>
              <TableHead>{t("Nome")}</TableHead>
              <TableHead className="w-[130px]">CNPJ</TableHead>
              <TableHead className="w-[110px]">{t("Status")}</TableHead>
              <TableHead className="w-[70px] text-right">{t("Users")}</TableHead>
              <TableHead className="w-[90px] text-right">{t("Conversas")}</TableHead>
              <TableHead className="w-[90px]">{t("Criado em")}</TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-xs">{row.slug}</TableCell>
                <TableCell className="font-medium">{row.display_name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {shortCnpj(row.cnpj)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.status} onboardedAt={row.onboarded_at} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {extractCount(row.user_count)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {extractCount(row.conversations_count)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(row.created_at, tagDoIdioma)}
                </TableCell>
                <TableCell>
                  <Link
                    href={`/admin/tenants/${row.id}`}
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
