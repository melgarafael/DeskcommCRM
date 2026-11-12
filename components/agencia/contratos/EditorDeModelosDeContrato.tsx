"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { salvarModeloDeContrato } from "@/app/actions/agencia/contratos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CAMPOS_DO_CONTRATO, preencherModelo, type CampoDoContrato } from "@/lib/agencia/contratos/regras";
import { cn } from "@/lib/utils";

/** Editor dos modelos de contrato: o texto da agência, com os campos no lugar dos dados (K1). */
interface Modelo {
  id: string | null;
  nome: string;
  corpo: string;
  ativo: boolean;
}

export function EditorDeModelosDeContrato({ modelos }: { modelos: Array<{ id: string; nome: string; corpo: string; ativo: boolean }> }) {
  const router = useRouter();
  const [escolhido, setEscolhido] = useState<number | "novo">(modelos.length ? 0 : "novo");
  const [rascunho, setRascunho] = useState<Modelo>(() => (modelos[0] ? { ...modelos[0] } : { id: null, nome: "", corpo: "", ativo: true }));
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [pendente, startTransition] = useTransition();
  const area = useRef<HTMLTextAreaElement>(null);

  const { desconhecidos } = preencherModelo(rascunho.corpo, {});
  const usados = new Set([...rascunho.corpo.matchAll(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g)].map((m) => m[1]));

  function escolher(i: number | "novo") {
    setEscolhido(i);
    setRascunho(i === "novo" ? { id: null, nome: "", corpo: "", ativo: true } : { ...modelos[i]! });
    setMsg(null);
  }

  function inserir(campo: CampoDoContrato) {
    const el = area.current;
    const marca = `{{${campo}}}`;
    if (!el) return setRascunho({ ...rascunho, corpo: rascunho.corpo + marca });
    const ini = el.selectionStart ?? rascunho.corpo.length;
    const fim = el.selectionEnd ?? ini;
    setRascunho({ ...rascunho, corpo: rascunho.corpo.slice(0, ini) + marca + rascunho.corpo.slice(fim) });
  }

  /** Remove a última ocorrência de {{campo}} do texto (desfaz a inserção mais recente). */
  function remover(campo: CampoDoContrato) {
    const marca = `{{${campo}}}`;
    const idx = rascunho.corpo.lastIndexOf(marca);
    if (idx === -1) return;
    setRascunho({ ...rascunho, corpo: rascunho.corpo.slice(0, idx) + rascunho.corpo.slice(idx + marca.length) });
  }

  /** Clique no botão de campo: insere se ainda não usado, remove a última ocorrência se já usado. */
  function alternar(campo: CampoDoContrato) {
    if (usados.has(campo)) remover(campo);
    else inserir(campo);
  }

  return (
    <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <nav className="flex gap-2 overflow-x-auto md:flex-col" aria-label="Modelos">
        {modelos.map((m, i) => (
          <button key={m.id} type="button" onClick={() => escolher(i)} className={cn("shrink-0 rounded-md border px-3 py-2 text-left text-sm", escolhido === i && "border-foreground font-medium")}>
            {m.nome}
            {!m.ativo && <span className="block text-xs text-muted-foreground">desativado</span>}
          </button>
        ))}
        <button type="button" onClick={() => escolher("novo")} className={cn("shrink-0 rounded-md border border-dashed px-3 py-2 text-left text-sm", escolhido === "novo" && "border-foreground")}>
          + Novo modelo
        </button>
      </nav>
      <div className="min-w-0 space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="modelo-contrato-nome">Nome</Label>
            <Input id="modelo-contrato-nome" value={rascunho.nome} onChange={(e) => setRascunho({ ...rascunho, nome: e.target.value })} />
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input type="checkbox" checked={rascunho.ativo} onChange={(e) => setRascunho({ ...rascunho, ativo: e.target.checked })} />
            Ativo
          </label>
        </div>
        <div className="space-y-1">
          <span className="text-sm font-medium">Campos (clique para pôr onde está o cursor)</span>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(CAMPOS_DO_CONTRATO) as CampoDoContrato[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => alternar(c)}
                className={cn("rounded-md border px-2 py-0.5 text-xs", usados.has(c) && "border-primary text-primary")}
                title={usados.has(c) ? `{{${c}}} — clique para remover a última ocorrência` : `{{${c}}} — clique para inserir no cursor`}
              >
                {CAMPOS_DO_CONTRATO[c]}
                {usados.has(c) && <span className="ml-1">×</span>}
              </button>
            ))}
          </div>
        </div>
        <textarea
          ref={area}
          aria-label="Texto do modelo"
          rows={24}
          value={rascunho.corpo}
          onChange={(e) => setRascunho({ ...rascunho, corpo: e.target.value })}
          className="w-full rounded-md border bg-background p-3 font-mono text-xs leading-relaxed"
        />
        {desconhecidos.length > 0 && <p className="text-sm text-destructive">Campos que não existem: {desconhecidos.join(", ")}.</p>}
        {msg && <p className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>{msg.texto}</p>}
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={pendente || desconhecidos.length > 0}
            onClick={() =>
              startTransition(async () => {
                const r = await salvarModeloDeContrato({ ...(rascunho.id ? { id: rascunho.id } : {}), nome: rascunho.nome, corpo: rascunho.corpo, ativo: rascunho.ativo });
                setMsg(r.ok ? { ok: true, texto: "Modelo salvo." } : { ok: false, texto: r.erro });
                if (r.ok) router.refresh();
              })
            }
          >
            Salvar modelo
          </Button>
        </div>
      </div>
    </div>
  );
}
