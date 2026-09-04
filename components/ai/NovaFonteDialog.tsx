"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Cadastro de fonte de conhecimento pela tela.
 *
 * O botão que existia aqui era um stub: `disabled` fixo com um toast "Em
 * breve." que, por estar desabilitado, nunca aparecia. A API
 * (POST /api/v1/ai/knowledge/sources) sempre funcionou e já aceita markdown —
 * ela mesma converte em itens de FAQ. Faltava só a tela.
 *
 * Um único campo de texto em vez de um editor de itens: o formato de duas
 * linhas por pergunta é o que alguém consegue colar de um documento que já
 * tem, e é o que a API parseia. Editor item-a-item viria depois, se pedirem.
 *
 * `tipo === "catalog"` é diferente dos outros três: não tem ingestão por
 * pergunta/resposta colada à mão (ninguém digita 200 perguntas de produto),
 * e sim por planilha — CSV colado ou arquivo `.csv` — que a API converte
 * internamente no mesmo formato de pergunta/resposta. Existe porque o
 * catálogo "de verdade" da tela só vem de sincronização de e-commerce; quem
 * não usa loja integrada não tinha NENHUM jeito de preencher esse card.
 */
const EXEMPLO = `## Pergunta: Qual o prazo de entrega?
## Resposta: De 2 a 3 dias úteis após a confirmação do pagamento.

## Pergunta: Vocês fazem troca?
## Resposta: Sim, em até 30 dias, com o produto sem uso.`;

const MODELO_CSV = "nome,preco,sku,categoria,variantes,estoque\n" +
  "Camisa social azul,1500,CAM-AZ-001,Vestuário,\"P, M, G, GG\",Em estoque\n";

function baixarModeloCsv() {
  const blob = new Blob([MODELO_CSV], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "modelo-catalogo.csv";
  a.click();
  URL.revokeObjectURL(url);
}

interface Props {
  agentId: string;
  tipo: "faq" | "policy" | "conversations" | "catalog";
  rotulo: string;
  aberto: boolean;
  onFechar: () => void;
  onCriada: () => void;
}

export function NovaFonteDialog({ agentId, tipo, rotulo, aberto, onFechar, onCriada }: Props) {
  const [nome, setNome] = useState(`${rotulo} da loja`);
  const [conteudo, setConteudo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [linhasIgnoradas, setLinhasIgnoradas] = useState<Array<{ row: number; reason: string }>>(
    [],
  );

  const ehCatalogo = tipo === "catalog";

  function lerArquivo(file: File) {
    const reader = new FileReader();
    reader.onload = () => setConteudo(String(reader.result ?? ""));
    reader.onerror = () => toast.error("Não consegui ler o arquivo.");
    reader.readAsText(file, "utf-8");
  }

  async function criar() {
    if (conteudo.trim().length === 0) {
      toast.error(ehCatalogo ? "Cole ou envie a planilha antes de criar." : "Cole o conteúdo antes de criar.");
      return;
    }
    setEnviando(true);
    setLinhasIgnoradas([]);
    try {
      const res = await fetch("/api/v1/ai/knowledge/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          // 'conversations' não tem ingestão de texto colado; 'catalog' usa
          // csv_blob (planilha), os demais usam markdown_blob (pergunta/resposta).
          source_type: ehCatalogo ? "catalog" : tipo === "policy" ? "policy" : "faq",
          name: nome.trim(),
          ...(ehCatalogo ? { csv_blob: conteudo } : { markdown_blob: conteudo }),
        }),
      });
      const json = (await res.json()) as {
        error?: { message?: string; details?: { row_errors?: Array<{ row: number; reason: string }> } };
        data?: { items_count?: number; row_errors?: Array<{ row: number; reason: string }> };
      };
      if (!res.ok) {
        const rowErrors = json.error?.details?.row_errors;
        if (rowErrors && rowErrors.length > 0) {
          setLinhasIgnoradas(rowErrors);
          toast.error("Nenhuma linha da planilha era válida — veja os motivos abaixo.");
        } else {
          toast.error(json.error?.message ?? "Não consegui criar a fonte.");
        }
        return;
      }
      const rowErrors = json.data?.row_errors ?? [];
      if (rowErrors.length > 0) {
        setLinhasIgnoradas(rowErrors);
        toast.warning(
          `Fonte criada com ${json.data?.items_count ?? 0} produto(s). ${rowErrors.length} linha(s) foram ignoradas — veja abaixo.`,
        );
      } else {
        toast.success("Fonte criada. A indexação começa em instantes.");
        onCriada();
        onFechar();
      }
    } catch {
      toast.error("Não consegui falar com o servidor.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cadastrar {rotulo.toLowerCase()}</DialogTitle>
          <DialogDescription>
            {ehCatalogo
              ? "Cole uma planilha (do Excel/Sheets) ou envie um arquivo .csv com seus produtos."
              : "Cole as perguntas e respostas. O agente passa a consultar isso antes de responder."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="fonte-nome">Nome da fonte</Label>
            <Input id="fonte-nome" value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>

          {ehCatalogo ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="fonte-csv">Planilha de produtos</Label>
                <Button type="button" variant="link" size="sm" onClick={baixarModeloCsv}>
                  Baixar modelo
                </Button>
              </div>
              <Input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) lerArquivo(file);
                }}
              />
              <Textarea
                id="fonte-csv"
                rows={10}
                placeholder="Ou cole aqui: nome, preço, sku, categoria, variantes, estoque"
                value={conteudo}
                onChange={(e) => setConteudo(e.target.value)}
              />
              <p className="text-xs text-text-muted">
                Colunas: <code>nome</code> e <code>preco</code> são obrigatórias. <code>sku</code>,{" "}
                <code>categoria</code>, <code>variantes</code> e <code>estoque</code> são opcionais.
                Pode colar direto de uma planilha ou enviar um arquivo <code>.csv</code>.
              </p>
              {linhasIgnoradas.length > 0 ? (
                <div className="rounded-md border border-warning-bg bg-warning-bg/30 p-2 text-xs text-warning-fg">
                  <p className="font-medium">Linhas ignoradas:</p>
                  <ul className="mt-1 list-disc pl-4">
                    {linhasIgnoradas.map((e) => (
                      <li key={e.row}>
                        Linha {e.row}: {e.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="fonte-conteudo">Conteúdo</Label>
              <Textarea
                id="fonte-conteudo"
                rows={12}
                placeholder={EXEMPLO}
                value={conteudo}
                onChange={(e) => setConteudo(e.target.value)}
              />
              <p className="text-xs text-text-muted">
                Uma linha <code>## Pergunta:</code> e uma <code>## Resposta:</code> por item, separados
                por uma linha em branco.
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onFechar} disabled={enviando}>
            Cancelar
          </Button>
          <Button onClick={criar} disabled={enviando}>
            {enviando ? "Criando…" : "Criar fonte"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
