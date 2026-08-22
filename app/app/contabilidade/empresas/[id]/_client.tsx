"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  account_type: string;
}
export interface EntryRow {
  id: string;
  entry_date: string;
  description: string;
  status: string;
}

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  asset: "Ativo",
  liability: "Passivo",
  equity: "Patrimônio líquido",
  revenue: "Receita",
  expense: "Despesa",
};

// ---------------------------------------------------------------------------
// Plano de contas
// ---------------------------------------------------------------------------

const accountFormSchema = z.object({
  code: z.string().min(1, "Obrigatório").max(20),
  name: z.string().min(2, "Mínimo 2 caracteres"),
  account_type: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
});
type AccountFormValues = z.infer<typeof accountFormSchema>;

export function PlanoDeContas({
  clientCompanyId,
  contas,
  canWrite,
}: {
  clientCompanyId: string;
  contas: AccountRow[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AccountFormValues>({ resolver: zodResolver(accountFormSchema) });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await apiClient.post("/api/v1/accounting/chart-of-accounts", {
        client_company_id: clientCompanyId,
        ...values,
      });
      toast.success("Conta criada");
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erro ao criar conta");
    }
  });

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Plano de contas</h2>
        {canWrite && !open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Nova conta
          </Button>
        )}
      </div>

      {open && (
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="code">Código</Label>
            <Input id="code" {...register("code")} autoFocus />
            {errors.code && <p className="text-xs text-destructive">{errors.code.message}</p>}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="name">Nome</Label>
            <Input id="name" {...register("name")} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="account_type">Tipo</Label>
            <Select
              value={watch("account_type")}
              onValueChange={(v) => setValue("account_type", v as AccountFormValues["account_type"])}
            >
              <SelectTrigger id="account_type">
                <SelectValue placeholder="Escolha" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ACCOUNT_TYPE_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2 sm:col-span-4">
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Salvando..." : "Criar conta"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}

      {contas.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma conta cadastrada ainda.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Nome</TableHead>
              <TableHead>Tipo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contas.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono">{c.code}</TableCell>
                <TableCell>{c.name}</TableCell>
                <TableCell>{ACCOUNT_TYPE_LABEL[c.account_type] ?? c.account_type}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Lançamentos — MVP: uma linha de débito + uma de crédito, mesmo valor.
// Lançamentos com mais de duas linhas ficam para uma iteração futura (dívida
// declarada, não escondida): o schema e a API já suportam N linhas.
// ---------------------------------------------------------------------------

const entryFormSchema = z.object({
  entry_date: z.string().min(1, "Obrigatório"),
  description: z.string().min(2, "Mínimo 2 caracteres"),
  debit_account_id: z.string().min(1, "Obrigatório"),
  credit_account_id: z.string().min(1, "Obrigatório"),
  amount: z
    .string()
    .min(1, "Obrigatório")
    .refine((v) => Number(v) > 0, "Deve ser maior que zero"),
});
type EntryFormValues = z.infer<typeof entryFormSchema>;

export function Lancamentos({
  clientCompanyId,
  contas,
  lancamentos,
  canWrite,
}: {
  clientCompanyId: string;
  contas: AccountRow[];
  lancamentos: EntryRow[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EntryFormValues>({ resolver: zodResolver(entryFormSchema) });

  const onSubmit = handleSubmit(async (values) => {
    const cents = Math.round(Number(values.amount) * 100);
    try {
      await apiClient.post("/api/v1/accounting/journal-entries", {
        client_company_id: clientCompanyId,
        entry_date: values.entry_date,
        description: values.description,
        lines: [
          { account_id: values.debit_account_id, debit_cents: cents, credit_cents: 0 },
          { account_id: values.credit_account_id, debit_cents: 0, credit_cents: cents },
        ],
      });
      toast.success("Lançamento criado");
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erro ao criar lançamento");
    }
  });

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Lançamentos</h2>
        {canWrite && !open && contas.length >= 2 && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Novo lançamento
          </Button>
        )}
      </div>

      {canWrite && contas.length < 2 && (
        <p className="text-sm text-muted-foreground">
          Cadastre ao menos duas contas no plano de contas para lançar.
        </p>
      )}

      {open && (
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="entry_date">Data</Label>
            <Input id="entry_date" type="date" {...register("entry_date")} autoFocus />
            {errors.entry_date && (
              <p className="text-xs text-destructive">{errors.entry_date.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="amount">Valor</Label>
            <Input id="amount" type="number" step="0.01" min="0" {...register("amount")} />
            {errors.amount && <p className="text-xs text-destructive">{errors.amount.message}</p>}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="description">Descrição</Label>
            <Input id="description" {...register("description")} />
            {errors.description && (
              <p className="text-xs text-destructive">{errors.description.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="debit_account_id">Conta debitada</Label>
            <Select
              value={watch("debit_account_id")}
              onValueChange={(v) => setValue("debit_account_id", v)}
            >
              <SelectTrigger id="debit_account_id">
                <SelectValue placeholder="Escolha" />
              </SelectTrigger>
              <SelectContent>
                {contas.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credit_account_id">Conta creditada</Label>
            <Select
              value={watch("credit_account_id")}
              onValueChange={(v) => setValue("credit_account_id", v)}
            >
              <SelectTrigger id="credit_account_id">
                <SelectValue placeholder="Escolha" />
              </SelectTrigger>
              <SelectContent>
                {contas.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2 sm:col-span-2">
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Salvando..." : "Lançar"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}

      {lancamentos.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum lançamento ainda.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Descrição</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lancamentos.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{new Date(l.entry_date).toLocaleDateString("pt-BR")}</TableCell>
                <TableCell>{l.description}</TableCell>
                <TableCell className="capitalize">{l.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
