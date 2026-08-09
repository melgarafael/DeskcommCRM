"use client";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
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
import { useAuditQuery, type AuditFilters } from "@/hooks/audit/useAuditQuery";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-BR", { hour12: false });
  } catch {
    return iso;
  }
}

function truncJson(v: unknown, max = 80): string {
  if (v == null) return "—";
  const s = JSON.stringify(v);
  if (!s) return "—";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function AuditClient() {
  const [actionInput, setActionInput] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const filters = useMemo<AuditFilters>(
    () => ({
      action: actionInput || undefined,
      resource_type: resourceType || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
    }),
    [actionInput, resourceType, from, to],
  );

  const q = useAuditQuery(filters);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);

  function handleExport() {
    const qs = new URLSearchParams();
    if (filters.action) qs.set("action", filters.action);
    if (filters.resource_type) qs.set("resource_type", filters.resource_type);
    if (filters.from) qs.set("from", filters.from);
    if (filters.to) qs.set("to", filters.to);
    window.location.href = `/api/v1/audit/export?${qs.toString()}`;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Ação contém</label>
            <Input
              value={actionInput}
              onChange={(e) => setActionInput(e.target.value)}
              placeholder="ex: lead.created"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Tipo de recurso</label>
            <Input
              value={resourceType}
              onChange={(e) => setResourceType(e.target.value)}
              placeholder="ex: contact"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">De</label>
            <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Até</label>
            <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button variant="outline" className="w-full" onClick={handleExport}>
              Exportar CSV
            </Button>
          </div>
        </div>
      </Card>

      {/* Desktop/tablet: tabela cheia. Mobile: cards empilhados (mesmas
          linhas, mesmos dados) — ver docs/design-system/screen-flow/07-responsive-strategy.md. */}
      <Card className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Quando</TableHead>
              <TableHead>Ator</TableHead>
              <TableHead>Ação</TableHead>
              <TableHead>Recurso</TableHead>
              <TableHead>Request ID</TableHead>
              <TableHead>Metadata</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  Nenhum log no período.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {fmtDate(r.created_at)}
                  </TableCell>
                  <TableCell className="text-xs font-mono">
                    {r.acting_as_platform_admin
                      ? "platform_admin"
                      : r.actor_user_id
                        ? r.actor_user_id.slice(0, 8)
                        : r.actor_api_token_id
                          ? `token:${r.actor_api_token_id.slice(0, 8)}`
                          : "system"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.action}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.resource_type ?? "—"}
                    {r.resource_id ? `:${r.resource_id.slice(0, 8)}` : ""}
                  </TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {r.request_id ? r.request_id.slice(0, 8) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {truncJson(r.metadata)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <MobileCardList className="md:hidden">
        {q.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-3">
              <Skeleton className="h-16 w-full" />
            </Card>
          ))
        ) : rows.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">
            Nenhum log no período.
          </p>
        ) : (
          rows.map((r) => (
            <MobileCardRow key={r.id}>
              <MobileCardField label="Quando">{fmtDate(r.created_at)}</MobileCardField>
              <MobileCardField label="Ator">
                {r.acting_as_platform_admin
                  ? "platform_admin"
                  : r.actor_user_id
                    ? r.actor_user_id.slice(0, 8)
                    : r.actor_api_token_id
                      ? `token:${r.actor_api_token_id.slice(0, 8)}`
                      : "system"}
              </MobileCardField>
              <MobileCardField label="Ação">{r.action}</MobileCardField>
              <MobileCardField label="Recurso">
                {r.resource_type ?? "—"}
                {r.resource_id ? `:${r.resource_id.slice(0, 8)}` : ""}
              </MobileCardField>
              <MobileCardField label="Metadata">{truncJson(r.metadata, 40)}</MobileCardField>
            </MobileCardRow>
          ))
        )}
      </MobileCardList>

      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
          >
            {q.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
          </Button>
        </div>
      )}
    </div>
  );
}
