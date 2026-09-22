"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";

export interface DadosDaReceita {
  cnpj: string;
  name: string;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
  fantasia: string | null;
  logradouro: string | null;
  numero_end: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
}

/**
 * Campo CNPJ com busca na Receita (BrasilAPI).
 *
 * Digita → Buscar → o formulário completa sozinho (razão, fantasia, email,
 * telefone). CNPJ já cadastrado na org: avisa em vez de deixar duplicar (o
 * unique do banco barraria com 500 técnico — aqui a recusa é legível).
 */
export function CnpjLookup({
  id,
  valor,
  aoMudar,
  aoPreencher,
}: {
  id: string;
  valor: string;
  aoMudar: (v: string) => void;
  aoPreencher: (dados: DadosDaReceita) => void;
}) {
  const t = useT();
  const [buscando, setBuscando] = React.useState(false);
  const [aviso, setAviso] = React.useState<string | null>(null);

  async function buscar() {
    const digitos = valor.replace(/\D/g, "");
    if (digitos.length !== 14) {
      toast.error(t("CNPJ precisa de 14 dígitos."));
      return;
    }
    setBuscando(true);
    setAviso(null);
    try {
      const r = await apiClient.get<
        | { ja_cadastrado: true; contact_id: string; nome: string | null }
        | ({ ja_cadastrado: false } & DadosDaReceita)
      >(`/api/v1/contacts/cnpj-lookup?cnpj=${digitos}`);
      if (r.ja_cadastrado) {
        setAviso(t(`Já cadastrado como "${r.nome ?? "contato"}".`));
        return;
      }
      aoPreencher(r);
      toast.success(t("Dados puxados do CNPJ"));
    } catch (e) {
      showApiError(e);
    } finally {
      setBuscando(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("CNPJ")}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={valor}
          onChange={(e) => aoMudar(e.target.value)}
          placeholder="00.000.000/0001-00"
          inputMode="numeric"
        />
        <Button type="button" variant="outline" disabled={buscando} onClick={buscar}>
          {buscando ? t("Buscando…") : t("Buscar dados")}
        </Button>
      </div>
      {aviso && <p className="text-sm text-orange-600">{aviso}</p>}
    </div>
  );
}
