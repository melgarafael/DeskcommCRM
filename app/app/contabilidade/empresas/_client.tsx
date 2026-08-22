"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

function maskCnpj(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 14);
  if (digits.length <= 2) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  if (digits.length <= 8) return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5)}`;
  if (digits.length <= 12)
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

const formSchema = z.object({
  legal_name: z.string().min(2, "Mínimo 2 caracteres"),
  cnpj: z.string().min(14, "CNPJ incompleto"),
  tax_regime: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

export interface ClientCompanyRow {
  id: string;
  legal_name: string;
  trade_name: string | null;
  cnpj: string;
  tax_regime: string | null;
  status: string;
}

export function NovaEmpresaForm({ canWrite }: { canWrite: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  if (!canWrite) return null;

  const onSubmit = handleSubmit(async (values) => {
    try {
      await apiClient.post("/api/v1/accounting/client-companies", values);
      toast.success("Empresa cadastrada");
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erro ao cadastrar empresa");
    }
  });

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} className="w-fit">
        Nova empresa
      </Button>
    );
  }

  return (
    <Card className="max-w-md p-6">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="legal_name">Razão social</Label>
          <Input id="legal_name" {...register("legal_name")} autoFocus />
          {errors.legal_name && (
            <p className="text-xs text-destructive">{errors.legal_name.message}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cnpj">CNPJ</Label>
          <Input
            id="cnpj"
            inputMode="numeric"
            maxLength={18}
            {...register("cnpj")}
            onChange={(e) => setValue("cnpj", maskCnpj(e.target.value))}
          />
          {errors.cnpj && <p className="text-xs text-destructive">{errors.cnpj.message}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tax_regime">Regime tributário</Label>
          <Input id="tax_regime" placeholder="Simples Nacional" {...register("tax_regime")} />
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Salvando..." : "Cadastrar"}
          </Button>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function ListaDeEmpresas({ empresas }: { empresas: ClientCompanyRow[] }) {
  if (empresas.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nenhuma empresa cadastrada ainda. Cadastre a primeira empresa que seu escritório atende.
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      {empresas.map((e) => (
        <Link key={e.id} href={`/app/contabilidade/empresas/${e.id}`}>
          <Card className="p-4 transition-colors hover:bg-muted/40">
            <p className="font-medium">{e.trade_name || e.legal_name}</p>
            <p className="text-sm text-muted-foreground">
              {e.cnpj}
              {e.tax_regime ? ` · ${e.tax_regime}` : ""}
            </p>
          </Card>
        </Link>
      ))}
    </div>
  );
}
