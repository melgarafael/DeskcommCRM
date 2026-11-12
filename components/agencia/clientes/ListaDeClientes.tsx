"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { excluirCliente, importarOrganizacoes } from "@/app/actions/agencia/clientes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ROTULO_DA_SITUACAO, SITUACOES_DO_CLIENTE, type SituacaoDoCliente } from "@/lib/agencia/clientes/vocabulario";
import { cn } from "@/lib/utils";

import { EtiquetaDaSituacao } from "./EtiquetaDaSituacao";
import { FormularioDoCliente } from "./FormularioDoCliente";

export interface ClienteDaLista {
  id: string;
  nome: string;
  segmento: string | null;
  situacao: SituacaoDoCliente;
  temOrganizacao: boolean;
  temPasta: boolean;
  equipe: string[];
  tarefasAbertas: number;
}

export interface OrganizacaoImportavel {
  id: string;
  nome: string;
}

export function ListaDeClientes({
  clientes,
  importaveis,
  podeGerenciar,
}: {
  clientes: ClienteDaLista[];
  importaveis: OrganizacaoImportavel[];
  podeGerenciar: boolean;
}) {
  const router = useRouter();
  const [texto, setTexto] = useState("");
  const [situacao, setSituacao] = useState("");
  const [novo, setNovo] = useState(false);
  const [importar, setImportar] = useState(false);
  const [marcadas, setMarcadas] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [pendente, startTransition] = useTransition();

  const visiveis = clientes.filter(
    (c) => (!texto || c.nome.toLowerCase().includes(texto.toLowerCase())) && (!situacao || c.situacao === situacao),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-9 w-full sm:w-64" placeholder="Buscar cliente" value={texto} onChange={(e) => setTexto(e.target.value)} />
        <select
          aria-label="Situação"
          value={situacao}
          onChange={(e) => setSituacao(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Todas as situações</option>
          {SITUACOES_DO_CLIENTE.map((s) => (
            <option key={s} value={s}>
              {ROTULO_DA_SITUACAO[s]}
            </option>
          ))}
        </select>
        {podeGerenciar && (
          <div className="ml-auto flex gap-2">
            {importaveis.length > 0 && (
              <Button variant="outline" onClick={() => setImportar(true)}>
                Importar das organizações
              </Button>
            )}
            <Button onClick={() => setNovo(true)} data-testid="novo-cliente">
              Novo cliente
            </Button>
          </div>
        )}
      </div>

      {msg && (
        <p role="status" className={cn("rounded-md border px-3 py-2 text-sm", !msg.ok && "border-destructive text-destructive")}>
          {msg.texto}
        </p>
      )}

      {visiveis.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {clientes.length === 0 ? "Nenhum cliente ainda." : "Nenhum cliente com esse filtro."}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {visiveis.map((c) => (
            <li key={c.id} className="flex items-stretch">
              <Link
                href={`/agencia/clientes/${c.id}`}
                className="flex min-w-0 flex-1 flex-col gap-1 p-4 hover:bg-accent/40 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.nome}</span>
                    <EtiquetaDaSituacao situacao={c.situacao} />
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {[c.segmento, c.equipe.length ? `Equipe: ${c.equipe.join(", ")}` : "Sem equipe"].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex shrink-0 gap-3 text-xs text-muted-foreground">
                  <span>{c.tarefasAbertas} tarefa(s) aberta(s)</span>
                  <span>{c.temOrganizacao ? "Com organização" : "Sem organização"}</span>
                  <span>{c.temPasta ? "Pasta no Drive" : "Sem pasta"}</span>
                </div>
              </Link>
              {podeGerenciar && (
                <button
                  type="button"
                  aria-label={`Excluir ${c.nome}`}
                  disabled={pendente}
                  className="shrink-0 px-4 text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
                  onClick={() => {
                    if (!window.confirm(`Excluir o cliente "${c.nome}"? Isso remove também contratações, tarefas, arquivos e demais dados ligados a ele. Não dá para desfazer.`)) return;
                    startTransition(async () => {
                      const r = await excluirCliente(c.id);
                      setMsg(r.ok ? { ok: true, texto: `Cliente "${c.nome}" excluído.` } : { ok: false, texto: r.erro });
                      router.refresh();
                    });
                  }}
                >
                  Excluir
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={novo} onOpenChange={setNovo}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Novo cliente</DialogTitle>
            <DialogDescription>A pasta no Google Drive é criada sozinha, se o Drive estiver conectado.</DialogDescription>
          </DialogHeader>
          <FormularioDoCliente
            aoSalvar={(id) => {
              setNovo(false);
              router.push(`/agencia/clientes/${id}`);
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={importar} onOpenChange={setImportar}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Importar das organizações</DialogTitle>
            <DialogDescription>Cada organização marcada vira um cliente da agência, já ligado a ela.</DialogDescription>
          </DialogHeader>
          <div className="flex justify-between text-xs">
            <button type="button" className="underline" onClick={() => setMarcadas(importaveis.map((o) => o.id))}>
              Marcar todas
            </button>
            <button type="button" className="underline" onClick={() => setMarcadas([])}>
              Desmarcar
            </button>
          </div>
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {importaveis.map((o) => (
              <li key={o.id}>
                <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm">
                  <input
                    type="checkbox"
                    checked={marcadas.includes(o.id)}
                    onChange={() => setMarcadas((m) => (m.includes(o.id) ? m.filter((x) => x !== o.id) : [...m, o.id]))}
                  />
                  {o.nome}
                </label>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button
              disabled={marcadas.length === 0 || pendente}
              onClick={() =>
                startTransition(async () => {
                  const r = await importarOrganizacoes(marcadas);
                  setImportar(false);
                  setMarcadas([]);
                  setMsg(r.ok ? { ok: true, texto: `${r.dados.criados} cliente(s) importado(s).` } : { ok: false, texto: r.erro });
                  router.refresh();
                })
              }
            >
              {pendente ? "Importando…" : `Importar ${marcadas.length}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
