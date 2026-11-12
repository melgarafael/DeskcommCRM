"use client";

import Link from "next/link";
import { useState } from "react";

import { rotuloCurtoDoDia, rotuloLongoDoDia } from "@/lib/agencia/calendario/regras";
import {
  ROTULO_DA_REDE,
  ROTULO_DA_SITUACAO_DA_PUBLICACAO,
  ROTULO_DO_FORMATO,
  somarMeses,
  type Formato,
  type Rede,
  type SituacaoDaPublicacao,
} from "@/lib/agencia/publicacoes/regras";
import { cn } from "@/lib/utils";

export interface PublicacaoNaTela {
  id: string;
  clienteId: string;
  clienteNome: string;
  titulo: string;
  rede: Rede;
  formato: Formato;
  dia: string;
  hora: string;
  legenda: string;
  midiaUrl: string;
  responsavelId: string | null;
  situacao: SituacaoDaPublicacao;
  autoPublicar: boolean;
  comentario: string | null;
  postUrl: string | null;
  erro: string | null;
}

interface Props {
  mes: string;
  hoje: string;
  grade: string[][];
  clienteFiltro: string;
  abrir: string | null;
  clientes: Array<{ id: string; nome: string }>;
  publicacoes: PublicacaoNaTela[];
}

const COR_DA_SITUACAO: Record<SituacaoDaPublicacao, string> = {
  rascunho: "border-dashed bg-background text-muted-foreground",
  em_aprovacao: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  aprovada: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  agendada: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  publicando: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  publicada: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  falhou: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  cancelada: "bg-muted text-muted-foreground line-through",
};

const DIAS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

function nomeDoMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number) as [number, number];
  const nome = new Date(Date.UTC(a, m - 1, 15)).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
  // Só a primeira letra: "Novembro de 2026", nunca "Novembro De 2026".
  return nome.charAt(0).toUpperCase() + nome.slice(1);
}

/** Calendário de publicações — somente visualização: navegar meses, filtrar por cliente e ver detalhes. */
export function CalendarioDePublicacoes(p: Props) {
  const [aberta, setAberta] = useState<string | null>(p.abrir && p.publicacoes.some((x) => x.id === p.abrir) ? p.abrir : null);

  const atual = aberta ? p.publicacoes.find((x) => x.id === aberta) ?? null : null;

  function url(mudar: { mes?: string; cliente?: string | null; abrir?: string | null }) {
    const q = new URLSearchParams();
    q.set("mes", mudar.mes ?? p.mes);
    const c = mudar.cliente === undefined ? p.clienteFiltro : mudar.cliente;
    if (c) q.set("cliente", c);
    const a = mudar.abrir === undefined ? p.abrir : mudar.abrir;
    if (a) q.set("abrir", a);
    return `/agencia/publicacoes?${q.toString()}`;
  }

  const doDia = (dia: string) => p.publicacoes.filter((x) => x.dia === dia);
  const doMes = p.publicacoes.filter((x) => x.dia.startsWith(p.mes));

  return (
    <div className="space-y-4" data-testid="calendario-de-publicacoes">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight">Publicações</h1>
        <select
          aria-label="Filtrar por cliente"
          value={p.clienteFiltro}
          onChange={(e) => window.location.href = url({ cliente: e.target.value || null, abrir: null })}
          className="h-9 max-w-[12rem] rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Todos os clientes</option>
          {p.clientes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nome}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <Link href={url({ mes: somarMeses(p.mes, -1), abrir: null })} className="rounded-md border px-2 py-1 hover:bg-accent" aria-label="Mês anterior">
          ←
        </Link>
        <span className="min-w-[10rem] text-center font-medium" data-testid="mes-aberto">
          {nomeDoMes(p.mes)}
        </span>
        <Link href={url({ mes: somarMeses(p.mes, 1), abrir: null })} className="rounded-md border px-2 py-1 hover:bg-accent" aria-label="Próximo mês">
          →
        </Link>
        <span className="ml-auto text-xs text-muted-foreground">
          {doMes.filter((x) => x.situacao === "publicada").length} de {doMes.filter((x) => x.situacao !== "cancelada").length} no ar
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        {/* Computador: grade do mês. */}
        <div className="overflow-hidden rounded-md border max-md:hidden" data-testid="grade-do-mes">
          <div className="grid grid-cols-7 border-b bg-muted/40 text-xs text-muted-foreground">
            {DIAS.map((d) => (
              <div key={d} className="px-2 py-1">
                {d}
              </div>
            ))}
          </div>
          {p.grade.map((semana) => (
            <div key={semana[0]} className="grid grid-cols-7 border-b last:border-b-0">
              {semana.map((dia) => (
                <div key={dia} data-dia={dia} className={cn("min-h-24 border-r p-1 last:border-r-0", !dia.startsWith(p.mes) && "bg-muted/30 text-muted-foreground")}>
                  <div className="flex items-center justify-between">
                    <span className={cn("text-xs", dia === p.hoje && "rounded-sm bg-primary px-1 text-primary-foreground")}>{Number(dia.slice(8))}</span>
                  </div>
                  <div className="mt-1 space-y-1">
                    {doDia(dia).map((x) => (
                      <button
                        key={x.id}
                        type="button"
                        onClick={() => window.location.href = url({ abrir: x.id })}
                        data-testid="publicacao-na-grade"
                        data-situacao={x.situacao}
                        data-publicacao={x.id}
                        className={cn("block w-full truncate rounded-sm border px-1 py-0.5 text-left text-[11px]", COR_DA_SITUACAO[x.situacao], aberta === x.id && "ring-2 ring-primary")}
                        title={`${x.hora} ${x.titulo} — ${x.clienteNome}`}
                      >
                        {x.hora} {x.titulo}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Celular: lista por dia. */}
        <ul className="space-y-2 md:hidden" data-testid="lista-de-publicacoes">
          {doMes.length === 0 && <li className="rounded-md border p-3 text-sm text-muted-foreground">Nada neste mês.</li>}
          {doMes.map((x) => (
            <li key={x.id}>
              <button type="button" onClick={() => window.location.href = url({ abrir: x.id })} className={cn("w-full rounded-md border p-3 text-left text-sm", COR_DA_SITUACAO[x.situacao])}>
                <span className="block font-medium">{x.titulo}</span>
                <span className="text-xs">
                  {rotuloCurtoDoDia(x.dia)} {x.hora} · {ROTULO_DA_REDE[x.rede]} · {x.clienteNome} · {ROTULO_DA_SITUACAO_DA_PUBLICACAO[x.situacao]}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <aside className="space-y-3 rounded-md border p-4 text-sm" data-testid="painel-da-publicacao">
          {!atual ? (
            <p className="text-muted-foreground">Clique numa publicação para ver os detalhes.</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold">{atual.titulo}</h2>
                <span className={cn("rounded border px-2 py-0.5 text-xs", COR_DA_SITUACAO[atual.situacao])} data-testid="situacao-da-publicacao">
                  {ROTULO_DA_SITUACAO_DA_PUBLICACAO[atual.situacao]}
                  {atual.situacao === "agendada" && (atual.autoPublicar ? " · publica sozinha" : " · postar à mão")}
                </span>
              </div>
              {atual.comentario && (
                <p className="rounded-md bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200" data-testid="comentario-do-cliente">
                  Ajuste pedido pelo cliente: {atual.comentario}
                </p>
              )}
              {atual.erro && (
                <p className="rounded-md bg-red-50 p-2 text-red-900 dark:bg-red-950 dark:text-red-200" data-testid="erro-da-publicacao">
                  {atual.erro}
                </p>
              )}
              {atual.postUrl && (
                <a href={atual.postUrl} target="_blank" rel="noreferrer" className="block truncate text-primary underline">
                  Ver o post
                </a>
              )}

              <dl className="space-y-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Cliente</dt>
                  <dd>{atual.clienteNome}</dd>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">Rede</dt>
                    <dd>{ROTULO_DA_REDE[atual.rede]}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Formato</dt>
                    <dd>{ROTULO_DO_FORMATO[atual.formato]}</dd>
                  </div>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Quando</dt>
                  <dd>
                    {rotuloLongoDoDia(atual.dia)}, {atual.hora}
                  </dd>
                </div>
                {atual.legenda && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Legenda</dt>
                    <dd className="whitespace-pre-wrap">{atual.legenda}</dd>
                  </div>
                )}
                {atual.midiaUrl && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Mídia</dt>
                    <dd className="truncate">
                      <a href={atual.midiaUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                        {atual.midiaUrl}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}