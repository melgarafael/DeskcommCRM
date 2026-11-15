"use client";
import { useId, type ReactNode, type SelectHTMLAttributes } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Named } from "./_types";
import type { useAmigoMutation } from "./_hooks";
export function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Pick({
  label,
  options,
  placeholder = "Selecione…",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 lg:min-h-9"
        {...props}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((x) => (
          <option key={x.value} value={x.value}>
            {x.label}
          </option>
        ))}
      </select>
    </div>
  );
}
export const options = (items: Named[] | null | undefined) =>
  (items ?? []).map((x) => ({ value: String(x.id), label: x.name || `Registro ${x.id}` }));
export function Notice({ error, loading }: { error?: string; loading?: boolean }) {
  return (
    <>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Consultando Amigo…
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
    </>
  );
}
export function MutationNotice({
  mutation,
  success = "Alteração confirmada no Amigo.",
}: {
  mutation: ReturnType<typeof useAmigoMutation>;
  success?: string;
}) {
  return (
    <div className="space-y-2" aria-live="polite">
      <Notice error={mutation.error} loading={mutation.pending} />
      {mutation.receipt?.operation_id && (
        <p className="text-xs break-all text-muted-foreground">
          Protocolo: {mutation.receipt.operation_id}
        </p>
      )}
      {mutation.blocked && mutation.error && (
        <>
          <p className="text-sm">
            Confira a consulta ou o cadastro no Amigo. A conferência abaixo consulta o mesmo
            protocolo, sem criar uma nova solicitação.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={mutation.pending}
            onClick={() => void mutation.retry()}
          >
            Conferir resultado
          </Button>
        </>
      )}
      {mutation.receipt && !mutation.error && !mutation.receipt.uncertain && (
        <p role="status" className="text-sm">
          {success}
        </p>
      )}
    </div>
  );
}
export function CatalogTable({
  items,
}: {
  items: (Named & {
    specialty?: string | null;
    address?: string;
    contact_cellphone?: string | null;
  })[];
}) {
  if (!items.length)
    return <p className="text-sm text-muted-foreground">Nenhum registro para estes filtros.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Nome</TableHead>
          <TableHead>Detalhes</TableHead>
          <TableHead>Referência</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id}>
            <TableCell className="font-medium">{item.name || "Sem nome informado"}</TableCell>
            <TableCell>{item.specialty || item.address || item.contact_cellphone || "—"}</TableCell>
            <TableCell className="text-muted-foreground">{item.id}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
export function clinicDate(timezone: string, tomorrow = false) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const value = `${get("year")}-${get("month")}-${get("day")}`;
  if (!tomorrow) return value;
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
export function civilTime(value: string, timezone: string): string {
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value))
    return value.replace("T", " ").slice(0, 16);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
export const shifts: Record<string, string> = {
  MORNING: "Manhã",
  AFTERNOON: "Tarde",
  NIGHT: "Noite",
};
