"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { salvarFuncao } from "@/app/actions/agencia/funcoes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DESCRICAO_DA_PERMISSAO,
  PERMISSOES_EM_USO,
  type PermissaoDaAgencia,
} from "@/lib/agencia/permissoes";

export interface FuncaoEditavel {
  id: string;
  nome: string;
  cor: string;
  permissoes: string[];
  ativa: boolean;
}

export function FuncoesCliente({ funcoes }: { funcoes: FuncaoEditavel[] }) {
  const router = useRouter();
  const [editando, setEditando] = useState<FuncaoEditavel | "nova" | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditando("nova")}>Nova função</Button>
      </div>
      <ul className="divide-y rounded-md border">
        {funcoes.map((f) => (
          <li key={f.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: f.cor }} aria-hidden />
                <span className="font-medium">{f.nome}</span>
                {!f.ativa && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Desativada</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                {f.permissoes.filter((p) => (PERMISSOES_EM_USO as readonly string[]).includes(p)).length === 0
                  ? "Sem permissões extras"
                  : f.permissoes
                      .filter((p): p is PermissaoDaAgencia => (PERMISSOES_EM_USO as readonly string[]).includes(p))
                      .map((p) => DESCRICAO_DA_PERMISSAO[p])
                      .join(" · ")}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditando(f)}>
              Editar
            </Button>
          </li>
        ))}
      </ul>

      <Dialog open={editando !== null} onOpenChange={(v) => !v && setEditando(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {editando !== null && (
            <FormularioDeFuncao
              funcao={editando === "nova" ? null : editando}
              onFeito={() => {
                setEditando(null);
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FormularioDeFuncao({ funcao, onFeito }: { funcao: FuncaoEditavel | null; onFeito: () => void }) {
  const [nome, setNome] = useState(funcao?.nome ?? "");
  const [cor, setCor] = useState(funcao?.cor ?? "#64748b");
  const [permissoes, setPermissoes] = useState<string[]>(funcao?.permissoes ?? ["tarefas.criar"]);
  const [ativa, setAtiva] = useState(funcao?.ativa ?? true);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  function alternar(p: PermissaoDaAgencia) {
    setPermissoes((atual) => (atual.includes(p) ? atual.filter((x) => x !== p) : [...atual, p]));
  }

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    startTransition(async () => {
      // Itens de fases futuras que a função já tinha são preservados: a tela só
      // mostra os que já têm efeito, e não pode apagar o resto por omissão.
      const r = await salvarFuncao({
        id: funcao?.id,
        nome,
        cor,
        permissoes: permissoes as PermissaoDaAgencia[],
        ativa,
      });
      if (r.ok) onFeito();
      else setErro(r.erro);
    });
  }

  return (
    <form onSubmit={salvar} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{funcao ? "Editar função" : "Nova função"}</DialogTitle>
        <DialogDescription>O que muda aqui vale para todos os membros com esta função.</DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="funcao-nome">Nome</Label>
          <Input id="funcao-nome" value={nome} onChange={(e) => setNome(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="funcao-cor">Cor</Label>
          <input
            id="funcao-cor"
            type="color"
            value={cor}
            onChange={(e) => setCor(e.target.value)}
            className="h-10 w-14 cursor-pointer rounded-md border bg-background"
          />
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Pode</legend>
        {PERMISSOES_EM_USO.map((p) => (
          <label key={p} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm">
            <input type="checkbox" checked={permissoes.includes(p)} onChange={() => alternar(p)} />
            {DESCRICAO_DA_PERMISSAO[p]}
          </label>
        ))}
      </fieldset>
      {funcao && (
        <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
          <span>Função ativa</span>
          <Switch checked={ativa} onCheckedChange={setAtiva} />
        </label>
      )}
      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={pendente}>
          {pendente ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </form>
  );
}
