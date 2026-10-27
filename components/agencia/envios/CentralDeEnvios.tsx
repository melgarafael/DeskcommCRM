"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cancelarAprovacao } from "@/app/actions/agencia/aprovacoes";
import { Button } from "@/components/ui/button";
import { ROTULO_DA_SITUACAO_DA_APROVACAO, ROTULO_DO_TIPO_DE_APROVACAO, type SituacaoDaAprovacao, type TipoDeAprovacao } from "@/lib/agencia/aprovacoes/vocabulario";
import { formatarTamanho } from "@/lib/agencia/envios/regras";
import { formatarDataHora } from "@/lib/agencia/tarefas/regras";
import { cn } from "@/lib/utils";

import { Material, type MaterialDoEnvio } from "./Material";
import { NovoEnvio, type Prefixo } from "./NovoEnvio";

/** Envios (docs/agencia/SPEC-envios.md): tudo o que foi para o cliente, num lugar só. */
export interface EnvioDaTela {
  id: string;
  clienteId: string;
  clienteNome: string;
  tipo: TipoDeAprovacao;
  titulo: string;
  descricao: string | null;
  versao: number;
  situacao: SituacaoDaAprovacao;
  comentario: string | null;
  pedidoEm: string;
  respondidoEm: string | null;
  tarefaId: string | null;
  bytes: number | null;
  material: MaterialDoEnvio;
  /** A cópia para o Drive depois da aprovação (E6–E7). */
  copia: { situacao: "aguardando" | "copiando" | "copiado" | "falhou"; erro: string | null; driveLink: string | null; porcento: number } | null;
}

const COR: Record<SituacaoDaAprovacao, string> = {
  pendente: "border-amber-500/50",
  aprovado: "border-emerald-500/50",
  ciente: "border-emerald-500/50",
  ajustes: "border-orange-500/60",
  cancelado: "opacity-60",
};

export function CentralDeEnvios(p: {
  envios: EnvioDaTela[];
  clientes: Array<{ id: string; nome: string }>;
  clienteFiltro: string;
  abrir: string | null;
  novo: Prefixo | null;
  podeEnviar: boolean;
}) {
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [form, setForm] = useState<Prefixo | null>(p.novo);
  const [aberto, setAberto] = useState<string | null>(p.abrir);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);

  const esperando = p.envios.filter((e) => e.situacao === "pendente");
  const respondidos = p.envios.filter((e) => e.situacao !== "pendente");

  const cartao = (e: EnvioDaTela) => (
    <li key={e.id} className={cn("rounded-md border p-3", COR[e.situacao])} data-testid="envio" data-situacao={e.situacao} data-envio={e.id}>
      <button type="button" className="flex w-full flex-wrap items-baseline justify-between gap-2 text-left" onClick={() => setAberto(aberto === e.id ? null : e.id)}>
        <span className="min-w-0">
          <span className="block font-medium">
            {e.titulo}
            {e.versao > 1 && <span className="ml-1 text-xs text-muted-foreground">v{e.versao}</span>}
          </span>
          <span className="text-xs text-muted-foreground">
            {e.clienteNome} · {ROTULO_DO_TIPO_DE_APROVACAO[e.tipo]}
            {e.bytes ? ` · ${formatarTamanho(e.bytes)}` : ""} · {formatarDataHora(e.pedidoEm)}
          </span>
        </span>
        <span className="text-xs font-medium" data-testid="situacao-do-envio">
          {ROTULO_DA_SITUACAO_DA_APROVACAO[e.situacao]}
          {e.respondidoEm && e.situacao !== "cancelado" ? ` · ${formatarDataHora(e.respondidoEm)}` : ""}
        </span>
      </button>

      {e.comentario && (
        <p className="mt-2 rounded-md bg-orange-50 p-2 text-sm text-orange-900 dark:bg-orange-950 dark:text-orange-200" data-testid="comentario-do-cliente">
          O cliente pediu: {e.comentario}
        </p>
      )}
      {e.copia && (
        <p className={cn("mt-2 text-xs", e.copia.situacao === "copiado" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")} data-testid="copia-do-envio" data-copia={e.copia.situacao}>
          {e.copia.situacao === "copiado"
            ? "Guardado no Google Drive e apagado da VPS."
            : e.copia.situacao === "copiando"
              ? `Copiando para o Google Drive… ${e.copia.porcento}%`
              : `Esperando o Google Drive${e.copia.erro ? `: ${e.copia.erro}` : "."} O arquivo continua na VPS.`}
          {e.copia.driveLink && (
            <a href={e.copia.driveLink} target="_blank" rel="noreferrer" className="ml-1 underline">
              Abrir no Drive
            </a>
          )}
        </p>
      )}

      {aberto === e.id && (
        <div className="mt-3 space-y-3">
          {e.descricao && <p className="whitespace-pre-line text-sm text-muted-foreground">{e.descricao}</p>}
          <Material m={e.material} titulo={e.titulo} />
          <div className="flex flex-wrap gap-2">
            {p.podeEnviar && e.situacao === "ajustes" && (
              <Button type="button" size="sm" onClick={() => setForm({ clienteId: e.clienteId, tipo: e.tipo, titulo: e.titulo, origemId: e.id, versao: e.versao, tarefaId: e.tarefaId })}>
                Enviar nova versão
              </Button>
            )}
            {e.tarefaId && (
              <Link href={`/agencia/tarefas?abrir=${e.tarefaId}`} className="rounded-md border px-2 py-1 text-xs">
                Abrir tarefa
              </Link>
            )}
            {p.podeEnviar && e.situacao === "pendente" && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={pendente}
                onClick={() => {
                  if (!window.confirm("Cancelar este envio? O arquivo sai da VPS e o cliente deixa de ver.")) return;
                  startTransition(async () => {
                    const r = await cancelarAprovacao(e.id);
                    setMsg(r.ok ? { ok: true, texto: "Envio cancelado." } : { ok: false, texto: r.erro });
                    router.refresh();
                  });
                }}
              >
                Cancelar envio
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Envios</h1>
          <p className="text-sm text-muted-foreground">Vídeos, artes, roteiros e avisos para o cliente ver dentro do sistema, aprovar ou dar ciência.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filtrar por cliente"
            value={p.clienteFiltro}
            onChange={(ev) => router.push(ev.target.value ? `/agencia/envios?cliente=${ev.target.value}` : "/agencia/envios")}
            className="h-9 max-w-[14rem] rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Todos os clientes</option>
            {p.clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </select>
          {p.podeEnviar && p.clientes.length > 0 && !form && (
            <Button type="button" onClick={() => setForm({ clienteId: p.clienteFiltro || undefined })}>
              Novo envio
            </Button>
          )}
        </div>
      </div>

      {form && (
        <NovoEnvio
          key={form.origemId ?? "novo"}
          clientes={p.clientes}
          prefixo={form}
          aoFechar={() => setForm(null)}
          aoTerminar={(texto) => {
            setForm(null);
            setMsg({ ok: true, texto });
            router.refresh();
          }}
        />
      )}
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={cn("text-sm", msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")} data-testid="mensagem-dos-envios">
          {msg.texto}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">Esperando o cliente ({esperando.length})</h2>
        {esperando.length === 0 ? <p className="text-sm text-muted-foreground">Nada esperando resposta.</p> : <ul className="space-y-2">{esperando.map(cartao)}</ul>}
      </section>
      {respondidos.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Respondidos</h2>
          <ul className="space-y-2">{respondidos.map(cartao)}</ul>
        </section>
      )}
    </div>
  );
}
