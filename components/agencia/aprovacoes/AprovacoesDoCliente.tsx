"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cancelarAprovacao, pedirAprovacao } from "@/app/actions/agencia/aprovacoes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ROTULO_DA_SITUACAO_DA_APROVACAO,
  ROTULO_DO_TIPO_DE_APROVACAO,
  TIPOS_DE_APROVACAO,
  type SituacaoDaAprovacao,
  type TipoDeAprovacao,
} from "@/lib/agencia/aprovacoes/vocabulario";
import { formatarDataHora } from "@/lib/agencia/tarefas/regras";
import { cn } from "@/lib/utils";

/** A aba Aprovações da ficha (docs/agencia/SPEC-aprovacoes.md) — o lado da agência. */
export interface AprovacaoDaFicha {
  id: string;
  tipo: TipoDeAprovacao;
  titulo: string;
  link: string | null;
  versao: number;
  situacao: SituacaoDaAprovacao;
  comentario: string | null;
  pedidoEm: string;
  respondidoEm: string | null;
  tarefaId: string | null;
}

export function AprovacoesDoCliente(p: {
  clienteId: string;
  organizacaoLigada: boolean;
  aprovacoes: AprovacaoDaFicha[];
  arquivos: Array<{ id: string; nome: string }>;
  tarefas: Array<{ id: string; titulo: string }>;
  podePedir: boolean;
}) {
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [form, setForm] = useState({
    tipo: "video" as TipoDeAprovacao,
    titulo: "",
    descricao: "",
    link: "",
    arquivoId: "",
    tarefaId: "",
    origemId: "",
  });

  function pedir() {
    setMsg(null);
    startTransition(async () => {
      const r = await pedirAprovacao({
        clienteId: p.clienteId,
        tipo: form.tipo,
        titulo: form.titulo,
        descricao: form.descricao || null,
        link: form.link || null,
        arquivoId: form.arquivoId || null,
        tarefaId: form.tarefaId || null,
        origemId: form.origemId || null,
      });
      if (!r.ok) return setMsg({ ok: false, texto: r.erro });
      setMsg({ ok: true, texto: `Enviado para o cliente aprovar. ${r.dados.aviso}` });
      setForm({ tipo: form.tipo, titulo: "", descricao: "", link: "", arquivoId: "", tarefaId: "", origemId: "" });
      router.refresh();
    });
  }

  function novaVersao(a: AprovacaoDaFicha) {
    setForm({ tipo: a.tipo, titulo: a.titulo, descricao: "", link: "", arquivoId: "", tarefaId: a.tarefaId ?? "", origemId: a.id });
    setMsg({ ok: true, texto: "Preencha o link ou o arquivo da nova versão e envie." });
  }

  if (!p.organizacaoLigada) {
    return (
      <p className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="aprovacoes-sem-organizacao">
        Para o cliente aprovar pelo CRM dele, ligue este cliente a uma organização na aba Dados.
      </p>
    );
  }

  return (
    <section className="space-y-4" data-testid="aprovacoes-do-cliente">
      {p.podePedir && (
        <div className="space-y-3 rounded-md border p-4">
          <h3 className="font-semibold">{form.origemId ? "Nova versão para aprovar" : "Pedir aprovação"}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="aprovacao-tipo">O quê</Label>
              <select id="aprovacao-tipo" value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value as TipoDeAprovacao })} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {TIPOS_DE_APROVACAO.map((t) => (
                  <option key={t} value={t}>
                    {ROTULO_DO_TIPO_DE_APROVACAO[t]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="aprovacao-titulo">Título</Label>
              <Input id="aprovacao-titulo" value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} placeholder="Ex.: Reels da promoção de novembro" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="aprovacao-link">Link (Drive, YouTube…)</Label>
              <Input id="aprovacao-link" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://…" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="aprovacao-arquivo">Ou um arquivo do acervo</Label>
              <select id="aprovacao-arquivo" value={form.arquivoId} onChange={(e) => setForm({ ...form, arquivoId: e.target.value })} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                <option value="">Nenhum</option>
                {p.arquivos.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nome}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="aprovacao-tarefa">Tarefa ligada (aprovado conclui a tarefa; ajustes a devolve)</Label>
              <select id="aprovacao-tarefa" value={form.tarefaId} onChange={(e) => setForm({ ...form, tarefaId: e.target.value })} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                <option value="">Nenhuma</option>
                {p.tarefas.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.titulo}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="aprovacao-descricao">Recado para o cliente</Label>
              <textarea id="aprovacao-descricao" rows={3} value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} className="w-full rounded-md border bg-background p-2 text-sm" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" disabled={pendente} onClick={pedir}>
              Enviar para aprovação
            </Button>
            {form.origemId && (
              <Button type="button" variant="ghost" onClick={() => setForm({ ...form, origemId: "" })}>
                Não é nova versão
              </Button>
            )}
          </div>
        </div>
      )}

      {msg && (
        <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"} data-testid="mensagem-da-aprovacao">
          {msg.texto}
        </p>
      )}

      {p.aprovacoes.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nada enviado para aprovação ainda.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {p.aprovacoes.map((a) => (
            <li key={a.id} className={cn("space-y-1 p-3 text-sm", a.situacao === "cancelado" && "opacity-60")} data-testid="aprovacao-da-ficha">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {a.titulo}
                  {a.versao > 1 && <span className="text-muted-foreground"> · v{a.versao}</span>}
                </span>
                <span className={cn("text-xs", a.situacao === "ajustes" ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                  {ROTULO_DA_SITUACAO_DA_APROVACAO[a.situacao]}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {ROTULO_DO_TIPO_DE_APROVACAO[a.tipo]} · enviado {formatarDataHora(a.pedidoEm)}
                {a.respondidoEm && ` · respondido ${formatarDataHora(a.respondidoEm)}`}
              </p>
              {a.comentario && <p className="rounded-md bg-muted/40 p-2">“{a.comentario}”</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                {a.link && (
                  <a href={a.link} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-4">
                    Abrir o material
                  </a>
                )}
                {p.podePedir && a.situacao === "ajustes" && (
                  <Button type="button" size="sm" variant="outline" onClick={() => novaVersao(a)}>
                    Enviar nova versão
                  </Button>
                )}
                {p.podePedir && a.situacao === "pendente" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pendente}
                    onClick={() =>
                      startTransition(async () => {
                        await cancelarAprovacao(a.id);
                        router.refresh();
                      })
                    }
                  >
                    Cancelar
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
