"use client";
import * as React from "react";
import Link from "next/link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  type CredentialRow,
  type Provider,
  credentialStatus,
} from "@/hooks/ai/useCredentials";

interface Props {
  provider: Provider;
  credentials: CredentialRow[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  id?: string;
}

const STATUS_LABEL: Record<ReturnType<typeof credentialStatus>, string> = {
  validated: "validada",
  validating: "validando",
  invalid: "inválida",
  inactive: "inativa",
};

export function CredentialPicker({ provider, credentials, value, onChange, disabled, id }: Props) {
  const filtered = credentials.filter((c) => c.provider === provider);

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Credencial</Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Selecione uma credencial" />
        </SelectTrigger>
        <SelectContent>
          {filtered.map((c) => {
            const st = credentialStatus(c);
            return (
              <SelectItem key={c.id} value={c.id}>
                {c.label} · …{c.api_key_last4 ?? "????"} · {STATUS_LABEL[st]}
              </SelectItem>
            );
          })}
          {filtered.length === 0 ? (
            <SelectItem value="__none__" disabled>
              Nenhuma credencial {provider} cadastrada
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          <Link
            href="/app/ai/credentials"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Cadastrar credencial {provider}
          </Link>{" "}
          na aba Credenciais.
        </p>
      ) : null}
    </div>
  );
}

export function findCredential(credentials: CredentialRow[], id: string): CredentialRow | null {
  return credentials.find((c) => c.id === id) ?? null;
}
