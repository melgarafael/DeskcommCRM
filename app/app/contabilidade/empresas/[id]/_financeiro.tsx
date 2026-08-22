"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

export interface LedgerRow {
  id: string;
  description: string;
  amount_cents: number;
  due_date: string;
  paid_at: string | null;
  status: string;
}

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const ledgerFormSchema = z.object({
  description: z.string().min(2, "Mínimo 2 caracteres"),
  amount: z
    .string()
    .min(1, "Obrigatório")
    .refine((v) => Number(v) > 0, "Deve ser maior que zero"),
  due_date: z.string().min(1, "Obrigatório"),
});
type LedgerFormValues = z.infer<typeof ledgerFormSchema>;

function LedgerSection({
  title,
  endpoint,
  clientCompanyId,
  rows,
  canWrite,
}: {
  title: string;
  endpoint: "payables" | "receivables";
  clientCompanyId: string;
  rows: LedgerRow[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<LedgerFormValues>({ resolver: zodResolver(ledgerFormSchema) });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await apiClient.post(`/api/v1/accounting/${endpoint}`, {
        client_company_id: clientCompanyId,
        description: values.description,
        amount_cents: Math.round(Number(values.amount) * 100),
        due_date: values.due_date,
      });
      toast.success("Lançamento criado");
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erro ao criar lançamento");
    }
  });

  const marcarPago = async (id: string) => {
    try {
      await apiClient.patch(`/api/v1/accounting/${endpoint}/${id}`, {});
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erro ao marcar como pago");
    }
  };

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {canWrite && !open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Novo
          </Button>
        )}
      </div>

      {open && (
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3" noValidate>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Descrição</Label>
            <Input {...register("description")} autoFocus />
            {errors.description && (
              <p className="text-xs text-destructive">{errors.description.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Valor</Label>
            <Input type="number" step="0.01" min="0" {...register("amount")} />
            {errors.amount && <p className="text-xs text-destructive">{errors.amount.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Vencimento</Label>
            <Input type="date" {...register("due_date")} />
            {errors.due_date && (
              <p className="text-xs text-destructive">{errors.due_date.message}</p>
            )}
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Salvando..." : "Criar"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nada por aqui ainda.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Descrição</TableHead>
              <TableHead>Valor</TableHead>
              <TableHead>Vencimento</TableHead>
              <TableHead>Status</TableHead>
              {canWrite && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.description}</TableCell>
                <TableCell>{formatCents(r.amount_cents)}</TableCell>
                <TableCell>{new Date(r.due_date).toLocaleDateString("pt-BR")}</TableCell>
                <TableCell>
                  <Badge variant={r.status === "paid" ? "default" : "secondary"}>
                    {r.status === "paid" ? "Pago" : "Em aberto"}
                  </Badge>
                </TableCell>
                {canWrite && (
                  <TableCell>
                    {r.status !== "paid" && (
                      <Button size="sm" variant="ghost" onClick={() => marcarPago(r.id)}>
                        Marcar pago
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function CashFlowSummary({ clientCompanyId }: { clientCompanyId: string }) {
  const [summary, setSummary] = useState<{
    total_received_cents: number;
    total_paid_cents: number;
    net_cents: number;
  } | null>(null);

  useEffect(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    apiClient
      .get<{ data: typeof summary }>(
        `/api/v1/accounting/cash-flow?client_company_id=${clientCompanyId}&period_start=${start}&period_end=${end}`,
      )
      .then((res) => setSummary(res.data))
      .catch(() => setSummary(null));
  }, [clientCompanyId]);

  return (
    <Card className="p-6 space-y-2">
      <h3 className="text-sm font-semibold">Fluxo de caixa — mês atual</h3>
      {summary ? (
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Recebido</p>
            <p className="font-semibold">{formatCents(summary.total_received_cents)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Pago</p>
            <p className="font-semibold">{formatCents(summary.total_paid_cents)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Saldo</p>
            <p className="font-semibold">{formatCents(summary.net_cents)}</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Carregando...</p>
      )}
    </Card>
  );
}

export function Financeiro({
  clientCompanyId,
  payables,
  receivables,
  canWrite,
}: {
  clientCompanyId: string;
  payables: LedgerRow[];
  receivables: LedgerRow[];
  canWrite: boolean;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight">Financeiro</h2>
      <CashFlowSummary clientCompanyId={clientCompanyId} />
      <LedgerSection
        title="Contas a pagar"
        endpoint="payables"
        clientCompanyId={clientCompanyId}
        rows={payables}
        canWrite={canWrite}
      />
      <LedgerSection
        title="Contas a receber"
        endpoint="receivables"
        clientCompanyId={clientCompanyId}
        rows={receivables}
        canWrite={canWrite}
      />
    </div>
  );
}
