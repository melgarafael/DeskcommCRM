"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type MouseEvent } from "react";

import type { ApoioDaAgenda } from "@/lib/agencia/calendario/apoio";
import type { ReuniaoDaAgenda } from "@/lib/agencia/calendario/consultas";
import {
  diaDe,
  FAIXA_FIM_H,
  FAIXA_INICIO_H,
  gradeDoMes,
  horaLocal,
  inicioDaSemana,
  posicaoNaFaixa,
  rotuloCurtoDoDia,
  rotuloLongoDoDia,
  somarDias,
} from "@/lib/agencia/calendario/regras";
import { COR_DO_TIPO, ROTULO_DA_SITUACAO } from "@/lib/agencia/calendario/vocabulario";
import { cn } from "@/lib/utils";

import { ModalDaReuniao, type NovaReuniao } from "./ModalDaReuniao";

/**
 * O calendário da agência (docs/agencia/SPEC-calendario.md › Telas): Semana,
 * Mês e Próximos. O que mostrar (período, filtros) mora na URL e o servidor lê;
 * este componente só desenha e abre o modal.
 *
 * Sem `vista` na URL, o computador abre na Semana e o celular em Próximos — as
 * duas vêm montadas e o CSS escolhe, para não haver troca visível na carga.
 */
export type Vista = "semana" | "mes" | "proximos";

export interface PrazoNaAgenda {
  id: string;
  titulo: string;
  prazo: string;
  clienteNome: string | null;
}

interface Props {
  vista: Vista | null;
  dia: string;
  hoje: string;
  reunioes: ReuniaoDaAgenda[];
  prazos: PrazoNaAgenda[];
  apoio: ApoioDaAgenda;
  filtros: { cliente: string; pessoa: string };
  meuMembroId: string | null;
  podeGerenciar: boolean;
  agendaLiberada: boolean;
  abrirId: string | null;
}

const HORAS = Array.from({ length: FAIXA_FIM_H - FAIXA_INICIO_H }, (_, i) => FAIXA_INICIO_H + i);
const ALTURA_DA_HORA = 48;

/** Reuniões que se sobrepõem no dia dividem a largura: cada uma ganha uma raia. */
function raias(lista: ReuniaoDaAgenda[]): Map<string, { raia: number; total: number }> {
  const ordem = [...lista].sort((a, b) => a.inicio.localeCompare(b.inicio));
  const fins: number[] = [];
  const raiaDe = new Map<string, number>();
  for (const r of ordem) {
    const inicio = new Date(r.inicio).getTime();
    let i = fins.findIndex((f) => f <= inicio);
    if (i === -1) i = fins.length;
    fins[i] = new Date(r.fim).getTime();
    raiaDe.set(r.id, i);
  }
  const total = Math.max(fins.length, 1);
  return new Map([...raiaDe].map(([id, raia]) => [id, { raia, total }]));
}

export function CalendarioCliente(p: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const busca = useSearchParams();
  const [abertaId, setAbertaId] = useState<string | null>(p.abrirId);
  const [nova, setNova] = useState<NovaReuniao | null>(null);

  const aberta = abertaId ? (p.reunioes.find((r) => r.id === abertaId) ?? null) : null;

  function url(muda: Record<string, string | null>): string {
    const q = new URLSearchParams(busca.toString());
    q.delete("abrir");
    for (const [k, v] of Object.entries(muda)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    const s = q.toString();
    return s ? `${pathname}?${s}` : pathname;
  }

  function fechar(mudou: boolean) {
    setAbertaId(null);
    setNova(null);
    if (mudou) router.refresh();
  }

  function novaEm(dia: string, hora = "10:00") {
    if (!p.podeGerenciar) return;
    setAbertaId(null);
    setNova({ dia, hora, clienteId: p.filtros.cliente || null });
  }

  function cliqueNaFaixa(e: MouseEvent<HTMLDivElement>, dia: string) {
    if (e.target !== e.currentTarget) return;
    const y = e.nativeEvent.offsetY;
    const meiasHoras = Math.floor(y / (ALTURA_DA_HORA / 2));
    const minutos = FAIXA_INICIO_H * 60 + meiasHoras * 30;
    novaEm(dia, `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`);
  }

  const vista = p.vista;
  const porDia = new Map<string, ReuniaoDaAgenda[]>();
  for (const r of p.reunioes) {
    const d = diaDe(r.inicio);
    porDia.set(d, [...(porDia.get(d) ?? []), r]);
  }
  const prazosPorDia = new Map<string, PrazoNaAgenda[]>();
  for (const t of p.prazos) {
    const d = diaDe(t.prazo);
    prazosPorDia.set(d, [...(prazosPorDia.get(d) ?? []), t]);
  }

  const passo = vista === "mes" ? "mes" : "semana";
  const anterior =
    passo === "mes" ? `${somarDias(`${p.dia.slice(0, 7)}-01`, -1).slice(0, 7)}-01` : somarDias(inicioDaSemana(p.dia), -7);
  const proximo = passo === "mes" ? `${somarDias(`${p.dia.slice(0, 7)}-28`, 7).slice(0, 7)}-01` : somarDias(inicioDaSemana(p.dia), 7);

  const chip = (r: ReuniaoDaAgenda, compacto = false) => (
    <button
      key={r.id}
      type="button"
      onClick={() => setAbertaId(r.id)}
      data-testid="reuniao-no-calendario"
      className={cn(
        "flex w-full min-w-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-left text-xs text-white",
        r.situacao === "cancelada" && "line-through opacity-50",
      )}
      style={{ backgroundColor: COR_DO_TIPO[r.tipo] }}
      title={`${horaLocal(r.inicio)} ${r.titulo}`}
    >
      <span className="shrink-0 font-semibold">{horaLocal(r.inicio)}</span>
      {!compacto && <span className="truncate">{r.titulo}</span>}
    </button>
  );

  const marcadorDePrazo = (t: PrazoNaAgenda) => (
    <Link
      key={t.id}
      href={`/agencia/tarefas?abrir=${t.id}`}
      className="block truncate rounded-sm border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/40"
      title={`Prazo ${horaLocal(t.prazo)}: ${t.titulo}`}
    >
      ⏰ {horaLocal(t.prazo)} {t.titulo}
    </Link>
  );

  const semana = (
    <div className="overflow-x-auto rounded-md border" data-testid="vista-semana">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[48px_repeat(7,minmax(0,1fr))] border-b bg-card">
          <div />
          {Array.from({ length: 7 }, (_, i) => somarDias(inicioDaSemana(p.dia), i)).map((d) => (
            <div key={d} className={cn("space-y-1 border-l p-1.5 text-xs", d === p.hoje && "bg-muted")}>
              <div className={cn("font-medium", d === p.hoje && "text-foreground")}>{rotuloCurtoDoDia(d)}</div>
              {(prazosPorDia.get(d) ?? []).slice(0, 3).map(marcadorDePrazo)}
              {(prazosPorDia.get(d) ?? []).length > 3 && (
                <div className="text-[11px] text-muted-foreground">+{(prazosPorDia.get(d) ?? []).length - 3} prazos</div>
              )}
              {(porDia.get(d) ?? [])
                .filter((r) => !posicaoNaFaixa(r.inicio, r.fim, d))
                .map((r) => chip(r))}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-[48px_repeat(7,minmax(0,1fr))]">
          <div>
            {HORAS.map((h) => (
              <div key={h} className="pr-1 text-right text-[11px] text-muted-foreground" style={{ height: ALTURA_DA_HORA }}>
                {String(h).padStart(2, "0")}h
              </div>
            ))}
          </div>
          {Array.from({ length: 7 }, (_, i) => somarDias(inicioDaSemana(p.dia), i)).map((d) => {
            const doDia = (porDia.get(d) ?? []).filter((r) => posicaoNaFaixa(r.inicio, r.fim, d));
            const lanes = raias(doDia);
            return (
              <div
                key={d}
                onClick={(e) => cliqueNaFaixa(e, d)}
                className={cn("relative border-l", p.podeGerenciar && "cursor-pointer")}
                style={{
                  height: HORAS.length * ALTURA_DA_HORA,
                  backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${ALTURA_DA_HORA - 1}px, var(--border) ${ALTURA_DA_HORA - 1}px, var(--border) ${ALTURA_DA_HORA}px)`,
                }}
                data-dia={d}
              >
                {doDia.map((r) => {
                  const pos = posicaoNaFaixa(r.inicio, r.fim, d)!;
                  const l = lanes.get(r.id) ?? { raia: 0, total: 1 };
                  return (
                    <button
                      key={r.id}
                      type="button"
                      data-testid="reuniao-no-calendario"
                      onClick={() => setAbertaId(r.id)}
                      className={cn(
                        "absolute overflow-hidden rounded-sm px-1.5 py-0.5 text-left text-[11px] leading-tight text-white shadow-sm",
                        r.situacao === "cancelada" && "line-through opacity-50",
                      )}
                      style={{
                        top: `${pos.topo * 100}%`,
                        height: `${pos.altura * 100}%`,
                        left: `calc(${(l.raia / l.total) * 100}% + 2px)`,
                        width: `calc(${100 / l.total}% - 4px)`,
                        backgroundColor: COR_DO_TIPO[r.tipo],
                      }}
                    >
                      <span className="block font-semibold">{horaLocal(r.inicio)}</span>
                      <span className="block truncate">{r.titulo}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  const mes = (
    <div className="overflow-x-auto rounded-md border" data-testid="vista-mes">
      <div className="grid min-w-[640px] grid-cols-7">
        {["seg", "ter", "qua", "qui", "sex", "sáb", "dom"].map((n) => (
          <div key={n} className="border-b bg-card p-1.5 text-center text-xs font-medium text-muted-foreground">
            {n}
          </div>
        ))}
        {gradeDoMes(p.dia)
          .flat()
          .map((d) => {
            const itens = porDia.get(d) ?? [];
            const fora = d.slice(0, 7) !== p.dia.slice(0, 7);
            return (
              <div
                key={d}
                onClick={(e) => e.target === e.currentTarget && novaEm(d)}
                className={cn(
                  "min-h-24 space-y-1 border-b border-l p-1",
                  fora && "bg-muted/30 text-muted-foreground",
                  d === p.hoje && "bg-muted",
                  p.podeGerenciar && "cursor-pointer",
                )}
              >
                <Link href={url({ vista: "semana", dia: d })} className="text-xs font-medium hover:underline">
                  {Number(d.slice(8))}
                </Link>
                {itens.slice(0, 3).map((r) => chip(r))}
                {itens.length > 3 && <div className="text-[11px] text-muted-foreground">+{itens.length - 3}</div>}
                {(prazosPorDia.get(d) ?? []).length > 0 && (
                  <div className="text-[11px] text-muted-foreground">⏰ {(prazosPorDia.get(d) ?? []).length} prazo(s)</div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );

  const diasProximos = [...new Set([...porDia.keys(), ...prazosPorDia.keys()])].filter((d) => d >= p.hoje).sort();
  const proximos = (
    <div className="space-y-4" data-testid="vista-proximos">
      {diasProximos.length === 0 && <p className="rounded-md border p-4 text-sm text-muted-foreground">Nada marcado nos próximos dias.</p>}
      {diasProximos.map((d) => (
        <section key={d} className="space-y-2">
          <h2 className="text-sm font-semibold first-letter:uppercase">{d === p.hoje ? `Hoje · ${rotuloLongoDoDia(d)}` : rotuloLongoDoDia(d)}</h2>
          <ul className="divide-y rounded-md border">
            {(porDia.get(d) ?? []).map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setAbertaId(r.id)}
                  data-testid="reuniao-na-lista"
                  className={cn("flex w-full items-start gap-3 p-3 text-left text-sm hover:bg-accent/40", r.situacao === "cancelada" && "opacity-60")}
                >
                  <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: COR_DO_TIPO[r.tipo] }} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate font-medium", r.situacao === "cancelada" && "line-through")}>{r.titulo}</span>
                    <span className="block text-xs text-muted-foreground">
                      {horaLocal(r.inicio)}–{horaLocal(r.fim)}
                      {r.situacao !== "marcada" ? ` · ${ROTULO_DA_SITUACAO[r.situacao]}` : ""}
                      {r.meetUrl ? " · Meet" : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {(prazosPorDia.get(d) ?? []).map((t) => (
              <li key={t.id}>
                <Link href={`/agencia/tarefas?abrir=${t.id}`} className="flex items-start gap-3 p-3 text-sm hover:bg-accent/40">
                  <span className="mt-0.5 shrink-0" aria-hidden>
                    ⏰
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{t.titulo}</span>
                    <span className="block text-xs text-muted-foreground">
                      Prazo {horaLocal(t.prazo)}
                      {t.clienteNome ? ` · ${t.clienteNome}` : ""}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );

  const abas: Array<[Vista, string]> = [
    ["semana", "Semana"],
    ["mes", "Mês"],
    ["proximos", "Próximos"],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Como ver" className="flex rounded-md border p-0.5">
          {abas.map(([v, rotulo]) => {
            const atual = vista === v || (vista === null && v === "semana");
            return (
              <Link
                key={v}
                role="tab"
                aria-selected={vista === v}
                href={url({ vista: v })}
                className={cn(
                  "rounded-sm px-3 py-1 text-sm",
                  vista === v && "bg-accent font-medium text-accent-foreground",
                  // Sem vista na URL: no computador a Semana parece escolhida, no celular os Próximos.
                  vista === null && atual && "md:bg-accent md:font-medium md:text-accent-foreground",
                  vista === null && v === "proximos" && "max-md:bg-accent max-md:font-medium max-md:text-accent-foreground",
                )}
              >
                {rotulo}
              </Link>
            );
          })}
        </div>
        {vista !== "proximos" && (
          <div className={cn("flex items-center gap-1", vista === null && "max-md:hidden")}>
            <Link href={url({ dia: anterior })} className="rounded-md border px-2 py-1 text-sm" aria-label="Anterior">
              ‹
            </Link>
            <Link href={url({ dia: null })} className="rounded-md border px-2 py-1 text-sm">
              Hoje
            </Link>
            <Link href={url({ dia: proximo })} className="rounded-md border px-2 py-1 text-sm" aria-label="Próximo">
              ›
            </Link>
            <span className="px-2 text-sm font-medium first-letter:uppercase">
              {vista === "mes"
                ? new Date(`${p.dia.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" })
                : `${rotuloCurtoDoDia(inicioDaSemana(p.dia))} – ${rotuloCurtoDoDia(somarDias(inicioDaSemana(p.dia), 6))}`}
            </span>
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            aria-label="Filtrar por cliente"
            value={p.filtros.cliente}
            onChange={(e) => router.push(url({ cliente: e.target.value || null }))}
            className="h-9 max-w-[11rem] rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Todos os clientes</option>
            {p.apoio.clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </select>
          <select
            aria-label="Filtrar por pessoa"
            value={p.filtros.pessoa}
            onChange={(e) => router.push(url({ pessoa: e.target.value || null }))}
            className="h-9 max-w-[11rem] rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Toda a equipe</option>
            {p.meuMembroId && <option value={p.meuMembroId}>Só as minhas</option>}
            {p.apoio.membros
              .filter((m) => m.id !== p.meuMembroId)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nome}
                </option>
              ))}
          </select>
          {p.podeGerenciar && (
            <button
              type="button"
              onClick={() => novaEm(p.hoje)}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
            >
              Nova reunião
            </button>
          )}
        </div>
      </div>

      {vista === "semana" && semana}
      {vista === "mes" && mes}
      {vista === "proximos" && proximos}
      {vista === null && (
        <>
          <div className="max-md:hidden">{semana}</div>
          <div className="md:hidden">{proximos}</div>
        </>
      )}

      {(aberta || nova) && (
        <ModalDaReuniao
          key={aberta?.id ?? "nova"}
          aberto
          reuniao={aberta}
          nova={nova ?? { dia: p.hoje, hora: "10:00", clienteId: null }}
          apoio={p.apoio}
          meuMembroId={p.meuMembroId}
          podeGerenciar={p.podeGerenciar}
          agendaLiberada={p.agendaLiberada}
          aoFechar={fechar}
        />
      )}
    </div>
  );
}
