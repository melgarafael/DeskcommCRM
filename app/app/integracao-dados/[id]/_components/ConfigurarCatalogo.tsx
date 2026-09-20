"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  useCatalogoMapeamento,
  useSalvarCatalogoMapeamento,
  type CatalogoMapeamentoDTO,
  type OperadorDeBusca,
  type PapelColuna,
  type SalvarCatalogoBody,
} from "@/hooks/external-db/useCatalogoMapeamento";
import {
  PAPEIS_COLUNA,
  ROTULO_DO_PAPEL,
  detectarPapelColuna,
} from "@/lib/external-db/catalogo";

/** Papel → coluna correspondente na linha de `catalog_mappings`. */
const CAMPO_DO_PAPEL: Record<PapelColuna, keyof SalvarCatalogoBody> = {
  nome: "col_nome",
  ano: "col_ano",
  cor: "col_cor",
  km: "col_km",
  preco: "col_preco",
  imagem: "col_imagem",
  estoque: "col_estoque",
  cilindrada: "col_cilindrada",
  tipo: "col_tipo",
};

export interface TabelaParaCatalogo {
  schema: string;
  nome: string;
  colunas: Array<{ nome: string }>;
}

interface Props {
  connectionId: string;
  tabela: TabelaParaCatalogo;
  aberto: boolean;
  aoMudarAberto: (aberto: boolean) => void;
}

interface Linha {
  coluna: string;
  usar: boolean;
  papel: PapelColuna | null;
  ordem: string;
}

export function ConfigurarCatalogo({ connectionId, tabela, aberto, aoMudarAberto }: Props) {
  const mapeamento = useCatalogoMapeamento(aberto);
  const salvar = useSalvarCatalogoMapeamento();

  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [similaridade, setSimilaridade] = useState(false);
  const [qtd, setQtd] = useState(3);
  const [operador, setOperador] = useState<OperadorDeBusca>("contem");

  // Monta uma linha por coluna da tabela. Reaproveita o mapeamento existente se
  // for a MESMA tabela; senão começa com o papel detectado pelo nome.
  useEffect(() => {
    if (!aberto) return;
    const m = mapeamento.data;
    const mesma = m && m.table_name === tabela.nome && m.schema_name === tabela.schema;
    const papelParaColuna: Partial<Record<PapelColuna, string>> = {};
    if (mesma) {
      for (const papel of PAPEIS_COLUNA) {
        const col = m[CAMPO_DO_PAPEL[papel] as keyof CatalogoMapeamentoDTO] as string | null;
        if (col) papelParaColuna[papel] = col;
      }
      setEnabled(m.enabled);
      setSimilaridade(m.similaridade_deterministica);
      setQtd(m.similares_qtd);
      setOperador(m.busca_operador);
    } else {
      setEnabled(true);
      setSimilaridade(false);
      setQtd(3);
      setOperador("contem");
    }
    const ordem = (mesma ? m.ordem : {}) ?? {};
    setLinhas(
      tabela.colunas.map(({ nome }) => {
        const papelUsado =
          (Object.entries(papelParaColuna).find(([, c]) => c === nome)?.[0] as
            | PapelColuna
            | undefined) ?? null;
        const numero = papelUsado ? ordem[papelUsado] : undefined;
        return {
          coluna: nome,
          usar: papelUsado !== null,
          papel: papelUsado ?? detectarPapelColuna(nome),
          ordem: typeof numero === "number" ? String(numero) : "",
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto, tabela.schema, tabela.nome, mapeamento.data]);

  function atualizar(indice: number, patch: Partial<Linha>) {
    setLinhas((atual) => atual.map((l, i) => (i === indice ? { ...l, ...patch } : l)));
  }

  function salvarMapeamento() {
    const usadas = linhas.filter((l) => l.usar && l.papel !== null);
    if (!usadas.some((l) => l.papel === "nome")) {
      toast.error("Marque uma coluna com o papel Nome / modelo.");
      return;
    }
    // Ordem única: nenhum número pode repetir.
    const numeros = usadas.map((l) => l.ordem).filter((o) => o.trim() !== "");
    const valores = numeros.map(Number);
    if (new Set(valores).size !== valores.length) {
      toast.error("Cada número de ordem só pode ser usado uma vez.");
      return;
    }

    const body: SalvarCatalogoBody = {
      connection_id: connectionId,
      schema_name: tabela.schema,
      table_name: tabela.nome,
      col_nome: "",
      busca_operador: operador,
      enabled,
      similaridade_deterministica: similaridade,
      similares_qtd: qtd,
      ordem: {},
    };
    for (const linha of usadas) {
      const papel = linha.papel as PapelColuna;
      (body as unknown as Record<string, unknown>)[CAMPO_DO_PAPEL[papel]] = linha.coluna;
      if (linha.ordem.trim() !== "") body.ordem[papel] = Number(linha.ordem);
    }

    salvar.mutate(body, {
      onSuccess: () => {
        toast.success("Catálogo configurado. O agente já usa este mapeamento.");
        aoMudarAberto(false);
      },
      onError: (err) => showApiError(err),
    });
  }

  return (
    <Dialog open={aberto} onOpenChange={aoMudarAberto}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Catálogo do agente — “{tabela.nome}”</DialogTitle>
          <DialogDescription>
            Marque as colunas que o agente deve usar e dê uma ordem (1 = mais importante, sem
            repetir). O sistema reconhece o tipo de cada coluna pelo nome; a ordem define como
            as motos semelhantes são escolhidas e a ordem dos campos na legenda.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-4 py-2">
          <div className="flex items-center gap-2">
            <input
              id="cat-enabled"
              type="checkbox"
              className="h-4 w-4"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <Label htmlFor="cat-enabled">Usar este catálogo no agente</Label>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="cat-sim"
              type="checkbox"
              className="h-4 w-4"
              checked={similaridade}
              onChange={(e) => setSimilaridade(e.target.checked)}
            />
            <Label htmlFor="cat-sim">Escolher as semelhantes automaticamente</Label>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="cat-qtd">Quantas oferecer</Label>
            <Input
              id="cat-qtd"
              type="number"
              min={1}
              max={8}
              value={qtd}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setQtd(Math.min(8, Math.max(1, Math.round(n))));
              }}
              className="h-8 w-20"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label>Como buscar</Label>
            <Select value={operador} onValueChange={(v) => setOperador(v as OperadorDeBusca)}>
              <SelectTrigger className="h-8 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="contem">Contém (recomendado)</SelectItem>
                <SelectItem value="eq">Igual</SelectItem>
                <SelectItem value="comeca_com">Começa com</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex max-h-[42vh] flex-col gap-2 overflow-y-auto rounded-md border border-border/60 p-3">
          <div className="grid grid-cols-[1.5rem_1fr_10rem_4.5rem] items-center gap-2 text-xs font-semibold text-muted-foreground">
            <span />
            <span>Coluna</span>
            <span>Reconhecida como</span>
            <span>Ordem</span>
          </div>
          {linhas.map((linha, i) => (
            <div
              key={linha.coluna}
              className="grid grid-cols-[1.5rem_1fr_10rem_4.5rem] items-center gap-2"
            >
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={linha.usar}
                disabled={linha.papel === null}
                onChange={(e) => atualizar(i, { usar: e.target.checked })}
              />
              <span className="truncate font-mono text-xs" title={linha.coluna}>
                {linha.coluna}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {linha.papel === null ? "não reconhecida" : ROTULO_DO_PAPEL[linha.papel]}
              </span>
              <Input
                type="number"
                min={1}
                max={9}
                value={linha.ordem}
                placeholder="—"
                onChange={(e) => atualizar(i, { ordem: e.target.value })}
                disabled={!linha.usar || linha.papel === null}
                className="h-8"
              />
            </div>
          ))}
        </div>

        {mapeamento.data && mapeamento.data.table_name !== tabela.nome && (
          <p className="text-xs text-muted-foreground">
            Hoje o catálogo é a tabela “{mapeamento.data.table_name}”. Salvar aqui troca para esta.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => aoMudarAberto(false)}>
            Cancelar
          </Button>
          <Button onClick={salvarMapeamento} disabled={salvar.isPending}>
            {salvar.isPending ? "Salvando…" : "Salvar catálogo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
