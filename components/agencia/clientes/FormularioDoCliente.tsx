"use client";

import { useState, useTransition } from "react";

import { salvarCliente } from "@/app/actions/agencia/clientes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROTULO_DA_SITUACAO, SITUACOES_DO_CLIENTE, type SituacaoDoCliente } from "@/lib/agencia/clientes/vocabulario";

export interface DadosDoCliente {
  id?: string;
  nome: string;
  razaoSocial: string;
  documento: string;
  segmento: string;
  responsavelNome: string;
  whatsapp: string;
  email: string;
  cidade: string;
  instagram: string;
  site: string;
  observacoes: string;
  situacao: SituacaoDoCliente;
  empresas: Array<{ nome: string; documento: string }>;
}

const VAZIO: DadosDoCliente = {
  nome: "",
  razaoSocial: "",
  documento: "",
  segmento: "",
  responsavelNome: "",
  whatsapp: "",
  email: "",
  cidade: "",
  instagram: "",
  site: "",
  observacoes: "",
  situacao: "prospeccao",
  empresas: [],
};

const CAMPOS: Array<{ chave: keyof Omit<DadosDoCliente, "id" | "situacao" | "empresas" | "observacoes">; rotulo: string; tipo?: string }> = [
  { chave: "nome", rotulo: "Nome (como a equipe chama)" },
  { chave: "razaoSocial", rotulo: "Razão social" },
  { chave: "documento", rotulo: "CNPJ ou CPF" },
  { chave: "segmento", rotulo: "Segmento" },
  { chave: "responsavelNome", rotulo: "Responsável" },
  { chave: "whatsapp", rotulo: "WhatsApp", tipo: "tel" },
  { chave: "email", rotulo: "E-mail", tipo: "email" },
  { chave: "cidade", rotulo: "Cidade" },
  { chave: "instagram", rotulo: "Instagram" },
  { chave: "site", rotulo: "Site" },
];

export function FormularioDoCliente({
  inicial,
  somenteLeitura = false,
  aoSalvar,
}: {
  inicial?: DadosDoCliente;
  somenteLeitura?: boolean;
  aoSalvar: (id: string) => void;
}) {
  const [d, setD] = useState<DadosDoCliente>(inicial ?? VAZIO);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    startTransition(async () => {
      const r = await salvarCliente({
        ...d,
        empresas: d.empresas.filter((x) => x.nome.trim()).map((x) => ({ nome: x.nome, documento: x.documento || undefined })),
      });
      if (r.ok) aoSalvar(r.dados.id);
      else setErro(r.erro);
    });
  }

  return (
    <form onSubmit={salvar} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CAMPOS.map((c) => (
          <div key={c.chave} className="space-y-1.5">
            <Label htmlFor={`cliente-${c.chave}`}>{c.rotulo}</Label>
            <Input
              id={`cliente-${c.chave}`}
              type={c.tipo ?? "text"}
              value={d[c.chave]}
              disabled={somenteLeitura}
              required={c.chave === "nome"}
              onChange={(e) => setD({ ...d, [c.chave]: e.target.value })}
            />
          </div>
        ))}
        <div className="space-y-1.5">
          <Label htmlFor="cliente-situacao">Situação</Label>
          <select
            id="cliente-situacao"
            value={d.situacao}
            disabled={somenteLeitura}
            onChange={(e) => setD({ ...d, situacao: e.target.value as SituacaoDoCliente })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            {SITUACOES_DO_CLIENTE.map((s) => (
              <option key={s} value={s}>
                {ROTULO_DA_SITUACAO[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cliente-observacoes">Observações</Label>
        <textarea
          id="cliente-observacoes"
          rows={3}
          value={d.observacoes}
          disabled={somenteLeitura}
          onChange={(e) => setD({ ...d, observacoes: e.target.value })}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Outras empresas do grupo</legend>
        {d.empresas.map((e, i) => (
          <div key={i} className="grid grid-cols-[1fr_10rem_auto] gap-2">
            <Input
              aria-label="Nome da empresa"
              value={e.nome}
              disabled={somenteLeitura}
              onChange={(ev) => setD({ ...d, empresas: d.empresas.map((x, j) => (j === i ? { ...x, nome: ev.target.value } : x)) })}
            />
            <Input
              aria-label="CNPJ da empresa"
              value={e.documento}
              disabled={somenteLeitura}
              onChange={(ev) =>
                setD({ ...d, empresas: d.empresas.map((x, j) => (j === i ? { ...x, documento: ev.target.value } : x)) })
              }
            />
            {!somenteLeitura && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-destructive"
                onClick={() => setD({ ...d, empresas: d.empresas.filter((_, j) => j !== i) })}
              >
                remover
              </button>
            )}
          </div>
        ))}
        {!somenteLeitura && (
          <button
            type="button"
            className="text-xs underline underline-offset-4"
            onClick={() => setD({ ...d, empresas: [...d.empresas, { nome: "", documento: "" }] })}
          >
            + Adicionar empresa
          </button>
        )}
      </fieldset>

      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}
      {!somenteLeitura && (
        <div className="flex justify-end">
          <Button type="submit" disabled={pendente}>
            {pendente ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      )}
    </form>
  );
}
