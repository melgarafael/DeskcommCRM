"use client";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
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
import {
  MobileCardList,
  MobileCardRow,
  MobileCardField,
} from "@/components/ui/responsive-table";
import type { AdminAuditRow } from "@/hooks/useAdminAuditLog";

function maskEmail(email: string | null | undefined): string {
  if (!email) return "—";
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const first = local[0] ?? "";
  const masked = `${first}${"*".repeat(Math.min(local.length - 1, 4))}`;
  return `${masked}@${domain}`;
}

function relativeDate(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ptBR });
  } catch {
    return iso;
  }
}

function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  if (id.length <= 8) return id;
  return `${id.slice(0, 8)}…`;
}

export function AuditTableSkeleton() {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {["Quando", "Action", "Tenant", "Actor", "Recurso", ""].map((h) => (
              <TableHead key={h}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 8 }).map((_, i) => (
            <TableRow key={i}>
              {Array.from({ length: 6 }).map((__, j) => (
                <TableCell key={j}>
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <p className="text-sm font-medium text-muted-foreground">
        Nenhum evento encontrado
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Ajuste os filtros para ver entradas do audit log.
      </p>
    </div>
  );
}

interface AuditTableProps {
  data: AdminAuditRow[];
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
}

export function AuditTable({
  data,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: AuditTableProps) {
  if (data.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-3">
      {/* Área super-admin degrada pra leitura em mobile (sem mutação aqui de
          qualquer forma — só o link "Ver"); mesma troca tabela↔cards das
          outras telas. */}
      <div className="hidden rounded-md border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[130px]">Quando</TableHead>
              <TableHead>Action</TableHead>
              <TableHead className="w-[130px]">Tenant</TableHead>
              <TableHead className="w-[160px]">Actor</TableHead>
              <TableHead className="w-[180px]">Recurso</TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {relativeDate(row.created_at)}
                </TableCell>
                <TableCell className="font-mono text-xs">{row.action}</TableCell>
                <TableCell>
                  {row.organizations ? (
                    <Badge variant="neutral" className="font-mono text-[10px]">
                      {row.organizations.slug}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {maskEmail(row.actor_user_id ?? undefined)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.resource_type ? (
                    <span>
                      {row.resource_type}&nbsp;
                      <span className="font-mono">{shortId(row.resource_id)}</span>
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                    <Link href={`/admin/audit/${row.id}`}>Ver</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <MobileCardList className="md:hidden">
        {data.map((row) => (
          <MobileCardRow key={row.id}>
            <MobileCardField label="Quando">{relativeDate(row.created_at)}</MobileCardField>
            <MobileCardField label="Action">{row.action}</MobileCardField>
            <MobileCardField label="Tenant">
              {row.organizations ? row.organizations.slug : "—"}
            </MobileCardField>
            <MobileCardField label="Actor">
              {maskEmail(row.actor_user_id ?? undefined)}
            </MobileCardField>
            <MobileCardField label="Recurso">
              {row.resource_type
                ? `${row.resource_type} ${shortId(row.resource_id)}`
                : "—"}
            </MobileCardField>
            <Link
              href={`/admin/audit/${row.id}`}
              className="mt-1 text-right text-xs text-accent-foreground underline"
            >
              Ver detalhe
            </Link>
          </MobileCardRow>
        ))}
      </MobileCardList>

      {hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={isFetchingNextPage}
            onClick={onLoadMore}
          >
            {isFetchingNextPage ? "Carregando..." : "Carregar mais"}
          </Button>
        </div>
      )}
    </div>
  );
}
