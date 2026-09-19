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
  type OperadorDeBusca,
  type SalvarCatalogoBody,
} from "@/hooks/external-db/useCatalogoMapeamento";

const SEM_COLUNA = "__none__";

/** Papéis de coluna do catálogo (migration 0244), na ordem que a tela mostra. */
const PAPEIS: Array<{ chave: keyof SalvarCatalogoBody; rotulo: string; obrigatoria?: boolean }> = [
  { chave: "col_nome", rotulo: "Nome / modelo", obrigatoria: true },
  { chave: "col_ano", rotulo: "Ano" },
  { chave: "col_cor", rotulo: "Cor" },
  { chave: "col_km", rotulo: "Quilometragem" },
  { chave: "col_preco", rotulo: "Preço" },
  { chave: "col_imagem", rotulo: "Foto (URL da imagem)" },
  { chave: "col_estoque", rotulo: "Estoque" },
  { chave: "col_cilindrada", rotulo: "Cilindrada" },
  { chave: "col_tipo", rotulo: "Tipo" },
];

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

type Escolhas = Record<string, string>;

export function ConfigurarCatalogo({ connectionId, tabela, aberto, aoMudarAberto }: Props) {
  const mapeamento = useCatalogoMapeamento(aberto);
  const salvar = useSalvarCatalogoMapeamento();

  const [escolhas, setEscolhas] = useState<Escolhas>({});
  const [operador, setOperador] = useState<OperadorDeBusca>("contem");

  const colunas = tabela.colunas.map((c) => c.nome);

  // Reinicializa o formulário quando abre: reaproveita o mapeamento existente se
  // for da MESMA tabela; senão começa em branco.
  useEffect(() => {
    if (!aberto) return;
    const m = mapeamento.data;
    const mesmaTabela = m && m.table_name === tabela.nome && m.schema_name === tabela.schema;
    const proximas: Escolhas = {};
    for (const papel of PAPEIS) {
      const valor = mesmaTabela ? (m[papel.chave as keyof typeof m] as string | null) : null;
      proximas[papel.chave] = valor && colunas.includes(valor) ? valor : SEM_COLUNA;
    }
    setEscolhas(proximas);
    setOperador((mesmaTabela ? m?.busca_operador : "contem") ?? "contem");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto, tabela.schema, tabela.nome, mapeamento.data]);

  function salvarMapeamento() {
    if (escolhas.col_nome === undefined || escolhas.col_nome === SEM_COLUNA) {
      toast.error("Escolha a coluna de nome/modelo.");
      return;
    }
    const base: SalvarCatalogoBody = {
      connection_id: connectionId,
      schema_name: tabela.schema,
      table_name: tabela.nome,
      col_nome: escolhas.col_nome,
      busca_operador: operador,
      enabled: true,
    };
    const extras: Record<string, string> = {};
    for (const papel of PAPEIS) {
      if (papel.chave === "col_nome") continue;
      const valor = escolhas[papel.chave];
      if (valor !== undefined && valor !== SEM_COLUNA) extras[papel.chave] = valor;
    }
    const body = { ...base, ...extras } as SalvarCatalogoBody;
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
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Usar “{tabela.nome}” como catálogo</DialogTitle>
          <DialogDescription>
            Diga qual coluna desta tabela é o nome da moto e quais guardam ano, cor, quilometragem,
            preço e foto. O agente usa isso para montar as mensagens — sem nada fixo no código.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 py-2 sm:grid-cols-2">
          {PAPEIS.map((papel) => (
            <div key={papel.chave} className="flex flex-col gap-1.5">
              <Label htmlFor={`cat-${papel.chave}`}>
                {papel.rotulo}
                {papel.obrigatoria ? " *" : ""}
              </Label>
              <Select
                value={escolhas[papel.chave] ?? SEM_COLUNA}
                onValueChange={(v) => setEscolhas((atual) => ({ ...atual, [papel.chave]: v }))}
              >
                <SelectTrigger id={`cat-${papel.chave}`} className="h-9">
                  <SelectValue placeholder="— não usar —" />
                </SelectTrigger>
                <SelectContent>
                  {!papel.obrigatoria && (
                    <SelectItem value={SEM_COLUNA}>— não usar —</SelectItem>
                  )}
                  {colunas.map((coluna) => (
                    <SelectItem key={coluna} value={coluna}>
                      {coluna}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}

          <div className="flex flex-col gap-1.5">
            <Label>Como buscar pelo nome</Label>
            <Select value={operador} onValueChange={(v) => setOperador(v as OperadorDeBusca)}>
              <SelectTrigger className="h-9">
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
