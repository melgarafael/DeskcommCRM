"use client";

import * as React from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buscarCep, ErroDeCep } from "@/lib/brasil/cep";

/**
 * Bloco de endereço (0230) — o que a ficha do Mercos mostra e a nossa não
 * mostrava: rua, número, complemento, bairro, cidade, UF, CEP.
 *
 * Burro de propósito: recebe valor/onChange por campo para servir a qualquer
 * react-hook-form sem amarrar tipagem de formulário.
 */
export interface ValoresEndereco {
  logradouro: string;
  numero_end: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  cep: string;
}

export const ENDERECO_VAZIO: ValoresEndereco = {
  logradouro: "",
  numero_end: "",
  complemento: "",
  bairro: "",
  cidade: "",
  uf: "",
  cep: "",
};

export function EnderecoFields({
  idPrefixo,
  valores,
  aoMudar,
}: {
  idPrefixo: string;
  valores: ValoresEndereco;
  aoMudar: (campo: keyof ValoresEndereco, valor: string) => void;
}) {
  const t = useT();
  const [buscando, setBuscando] = React.useState(false);

  // ViaCEP preenche rua/bairro/cidade/UF. Número o CEP não tem e o
  // "complemento" do ViaCEP é faixa de numeração ("de 611/612 ao fim"),
  // não sala/apto — esses dois ficam intactos (o Buscar nunca apaga).
  async function buscarEndereco() {
    setBuscando(true);
    try {
      const e = await buscarCep(valores.cep);
      aoMudar("logradouro", e.logradouro);
      aoMudar("bairro", e.bairro);
      aoMudar("cidade", e.cidade);
      aoMudar("uf", e.uf);
      toast.success(t("Endereço preenchido pelo CEP."));
    } catch (err) {
      const codigo = err instanceof ErroDeCep ? err.codigo : "servico_indisponivel";
      toast.error(
        codigo === "cep_invalido"
          ? t("CEP inválido. Use 8 dígitos.")
          : codigo === "nao_encontrado"
            ? t("CEP não encontrado.")
            : t("Não foi possível buscar o CEP."),
      );
    } finally {
      setBuscando(false);
    }
  }

  const campo = (
    chave: keyof ValoresEndereco,
    rotulo: string,
    resto?: { placeholder?: string; classe?: string; maxLength?: number },
  ): React.ReactNode => (
    <div className={`space-y-2 ${resto?.classe ?? ""}`}>
      <Label htmlFor={`${idPrefixo}-${chave}`}>{rotulo}</Label>
      <Input
        id={`${idPrefixo}-${chave}`}
        value={valores[chave]}
        maxLength={resto?.maxLength}
        placeholder={resto?.placeholder}
        onChange={(e) => aoMudar(chave, e.target.value)}
      />
    </div>
  );
  return (
    <fieldset className="space-y-3 rounded-2xl border p-3">
      <legend className="px-1 text-sm font-medium">{t("Endereço")}</legend>
      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        {campo("logradouro", t("Rua / Avenida"), { placeholder: "Av. Brasil" })}
        {campo("numero_end", t("Número"), { placeholder: "123", maxLength: 20 })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {campo("complemento", t("Complemento"), { placeholder: "Sala 2" })}
        {campo("bairro", t("Bairro"), { placeholder: "Centro" })}
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_80px_140px]">
        {campo("cidade", t("Cidade"))}
        {campo("uf", t("UF"), { placeholder: "SC", maxLength: 2 })}
        {campo("cep", t("CEP"), { placeholder: "89460000", maxLength: 9 })}
      </div>
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="outline" onClick={() => void buscarEndereco()} disabled={buscando}>
          {buscando ? t("Buscando…") : t("Buscar pelo CEP")}
        </Button>
      </div>
    </fieldset>
  );
}

/** Linha de endereço em uma frase, para ficha e lista. */
export function enderecoEmLinha(c: {
  logradouro?: string | null;
  numero_end?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cep?: string | null;
}): string | null {
  const rua = [c.logradouro, c.numero_end].filter(Boolean).join(", ");
  const resto = [c.bairro, [c.cidade, c.uf].filter(Boolean).join("/"), c.cep].filter(Boolean).join(" - ");
  const tudo = [rua, resto].filter(Boolean).join(" - ");
  return tudo || null;
}
