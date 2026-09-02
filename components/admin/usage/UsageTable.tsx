"use client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChartBar } from "@/lib/ui/icons";
import type { UsageTenantRow } from "@/app/api/v1/admin/usage/route";
import type { UsageRange } from "@/hooks/useAdminUsage";
import { formatCentsUSD } from "@/lib/money";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

// DÓLAR: o número é `llm_calls.cost_cents`, e `pricing.ts` cota o provedor em USD.
const fmtUSD = formatCentsUSD;

function fmtNum(n: number): string {
  return n.toLocaleString("pt-PT");
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function exportCSV(tenants: UsageTenantRow[], range: UsageRange): void {
  const headers = [
    "organization_id",
    "tenant",
    "slug",
    "mensagens",
    "conversas",
    "invocacoes_ai",
    "tokens",
    "custo_reais",
  ];

  const rows = tenants.map((t) => [
    t.organization_id,
    `"${t.tenant_name.replace(/"/g, '""')}"`,
    t.tenant_slug,
    t.messages_count,
    t.conversations_count,
    t.ai_invocations_count,
    t.ai_tokens_total,
    (t.ai_cost_cents / 100).toFixed(2),
  ]);

  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `usage-${range}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface UsageTableProps {
  tenants: UsageTenantRow[];
  range: UsageRange;
}

export function UsageTable({ tenants, range }: UsageTableProps) {
  if (tenants.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-md border py-16 text-center text-muted-foreground">
        <ChartBar size={36} weight="duotone" className="opacity-40" aria-hidden />
        <p className="text-sm font-medium">Nenhum tenant encontrado</p>
        <p className="max-w-xs text-xs opacity-70">
          Não há dados de uso no período selecionado.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          Uso por tenant
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => exportCSV(tenants, range)}
          className="gap-1.5 text-xs"
        >
          Exportar CSV
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tenant</TableHead>
              <TableHead className="text-right">Mensagens</TableHead>
              <TableHead className="text-right">Conversas</TableHead>
              <TableHead className="text-right">Invoc. AI</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Custo AI</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.map((row) => (
              <TableRow key={row.organization_id}>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-sm">{row.tenant_name}</span>
                    <Badge variant="secondary" className="w-fit text-[10px] px-1.5 py-0">
                      {row.tenant_slug}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {fmtNum(row.messages_count)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {fmtNum(row.conversations_count)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {fmtNum(row.ai_invocations_count)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {fmtNum(row.ai_tokens_total)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm font-medium">
                  {fmtUSD(row.ai_cost_cents)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
