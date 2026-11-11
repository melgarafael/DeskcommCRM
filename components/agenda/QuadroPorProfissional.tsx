"use client";

import { format } from "date-fns";
import * as React from "react";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import type { FechamentoDaGrade } from "@/lib/agenda/fechamentos-na-grade";
import { dataDeParede } from "@/lib/agenda/fuso";
import {
  colunasDoQuadro,
  livresPorColuna,
  posicionarNaLinha,
  type HorarioLivreDoQuadro,
  type PassoDoQuadro,
} from "@/lib/agenda/quadro-por-profissional";
import { cn } from "@/lib/utils";

import { AvatarDaPessoa } from "./AvatarDaPessoa";
import { corDaTrilha, fundoDaTrilha } from "./paleta";
import type { Agendamento, Pessoa } from "./tipos";

/** Largura da coluna de nomes e altura de uma faixa — mesmas réguas em todo o quadro. */
const LARGURA_DOS_NOMES = "11rem";
const LARGURA_MINIMA_DA_COLUNA = "3.25rem";
const ALTURA_DA_FAIXA = "3.25rem";

/**
 * Mesma hachura neutra dos fechamentos na grade de Dia/Semana: "aqui não tem
 * atendimento", sem parecer compromisso nem ocupação do Google.
 */
const HACHURA_DO_FECHAMENTO =
  "repeating-linear-gradient(135deg, var(--color-border) 0 1px, transparent 1px 7px), var(--color-surface-elevated)";

type ItemDaLinha =
  | { tipo: "agendamento"; agendamento: Agendamento }
  | { tipo: "fechamento"; fechamento: FechamentoDaGrade };

/**
 * O QUADRO POR PROFISSIONAL (#4186): uma linha por pessoa, o dia na horizontal.
 *
 * É uma VISÃO da mesma agenda — mesmos compromissos, mesmos fechamentos, mesma
 * régua de horário livre (o motor). Quem escolhe "Quadro" no alternador vê o
 * que a grade de Dia já mostrava, reorganizado para quem distribui atendimento
 * entre vários profissionais.
 *
 * Esta fatia é LEITURA E MARCAÇÃO: clicar num bloco livre de uma linha abre o
 * painel já com aquela pessoa e aquele horário; tocar num compromisso abre o
 * detalhe. Arrastar para remarcar e criar bloqueio pelo quadro ficam para a
 * próxima fatia (combinado na issue).
 */
export function QuadroPorProfissional({
  dia,
  fuso,
  pessoas,
  agendamentos,
  fechamentos = [],
  livres,
  primeiraHora,
  ultimaHora,
  passoMin = 30,
  onMarcarEm,
  onAbrirAgendamento,
  className,
}: {
  /** O dia mostrado (data local, como a âncora da grade). */
  dia: Date;
  fuso: string;
  /** As linhas, já filtradas por quem chama (o filtro de pessoas manda aqui também). */
  pessoas: Pessoa[];
  agendamentos: Agendamento[];
  fechamentos?: FechamentoDaGrade[];
  /**
   * Os horários livres de cada pessoa, como o motor devolveu. `undefined` para
   * uma pessoa = ainda não chegou ou não há serviço escolhido: a linha fica sem
   * bloco clicável, nunca com um palpite.
   */
  livres: Record<string, HorarioLivreDoQuadro[] | undefined>;
  primeiraHora: number;
  ultimaHora: number;
  passoMin?: PassoDoQuadro;
  /** Sem isto o quadro é só leitura (quem não pode marcar). */
  onMarcarEm?: (instante: string, pessoaId: string) => void;
  onAbrirAgendamento?: (id: string) => void;
  className?: string;
}) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const diaISO = format(dia, "yyyy-MM-dd");
  const colunas = React.useMemo(
    () => colunasDoQuadro(primeiraHora, ultimaHora, passoMin),
    [primeiraHora, ultimaHora, passoMin],
  );
  const molde = `${LARGURA_DOS_NOMES} repeat(${colunas.length}, minmax(${LARGURA_MINIMA_DA_COLUNA}, 1fr))`;
  const dataEscrita = format(dia, t("d 'de' MMMM"), { locale: localeDaData });

  return (
    <div
      data-testid="quadro-por-profissional"
      data-dia={diaISO}
      className={cn(
        "min-h-0 flex-1 overflow-auto rounded-md border border-border bg-surface",
        className,
      )}
    >
      <section
        aria-label={t("Quadro por profissional de {data}").replace("{data}", dataEscrita)}
        className="min-w-max"
      >
        <div
          className="sticky top-0 z-20 grid border-b border-border bg-surface"
          style={{ gridTemplateColumns: molde }}
        >
          <div className="sticky left-0 z-10 flex items-center border-r border-border bg-surface px-3 py-2 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
            {t("Profissional")}
          </div>
          {colunas.map((c) => (
            <div
              key={c.minuto}

              className={cn(
                "border-l border-border/50 px-1 py-2 text-center text-[10px] tabular-nums",
                c.cheia ? "font-semibold text-text" : "text-text-subtle",
              )}
            >
              {c.rotulo}
            </div>
          ))}
        </div>

        {pessoas.length === 0 ? (
          <p role="status" className="px-3 py-6 text-sm text-text-muted">
            {t(
              "Nenhum profissional na agenda ainda. Quem atende é definido em Configurações › Agendamentos.",
            )}
          </p>
        ) : (
          pessoas.map((pessoa) => (
            <LinhaDoProfissional
              key={pessoa.id}
              pessoa={pessoa}
              diaISO={diaISO}
              fuso={fuso}
              molde={molde}
              colunas={colunas}
              passoMin={passoMin}
              agendamentos={agendamentos}
              fechamentos={fechamentos}
              livres={livres[pessoa.id]}
              dataEscrita={dataEscrita}
              onMarcarEm={onMarcarEm}
              onAbrirAgendamento={onAbrirAgendamento}
            />
          ))
        )}
      </section>
    </div>
  );
}

function LinhaDoProfissional({
  pessoa,
  diaISO,
  fuso,
  molde,
  colunas,
  passoMin,
  agendamentos,
  fechamentos,
  livres,
  dataEscrita,
  onMarcarEm,
  onAbrirAgendamento,
}: {
  pessoa: Pessoa;
  diaISO: string;
  fuso: string;
  molde: string;
  colunas: ReturnType<typeof colunasDoQuadro>;
  passoMin: PassoDoQuadro;
  agendamentos: Agendamento[];
  fechamentos: FechamentoDaGrade[];
  livres: HorarioLivreDoQuadro[] | undefined;
  dataEscrita: string;
  onMarcarEm?: (instante: string, pessoaId: string) => void;
  onAbrirAgendamento?: (id: string) => void;
}) {
  const t = useT();

  const { posicoes, faixas } = React.useMemo(() => {
    const pedacos = [
      ...agendamentos
        .filter((a) => a.responsavelId === pessoa.id && a.situacao !== "cancelled")
        .map((a) => ({
          item: { tipo: "agendamento", agendamento: a } as ItemDaLinha,
          comeca: a.comeca,
          termina: a.termina,
        })),
      ...fechamentos
        .filter((f) => f.responsavelId === pessoa.id)
        .map((f) => ({
          item: { tipo: "fechamento", fechamento: f } as ItemDaLinha,
          comeca: f.comeca,
          termina: f.termina,
        })),
    ];
    return posicionarNaLinha(pedacos, colunas, passoMin, diaISO, fuso);
  }, [agendamentos, fechamentos, pessoa.id, colunas, passoMin, diaISO, fuso]);

  const ofertas = React.useMemo(
    () => livresPorColuna(livres ?? [], colunas, passoMin, diaISO, fuso),
    [livres, colunas, passoMin, diaISO, fuso],
  );

  const quantos = posicoes.filter((p) => p.item.tipo === "agendamento").length;

  return (
    <div
      data-testid={`linha-profissional-${pessoa.id}`}
      className="grid border-b border-border"
      style={{
        gridTemplateColumns: molde,
        gridTemplateRows: `repeat(${faixas}, ${ALTURA_DA_FAIXA})`,
      }}
    >
      <div
        className="sticky left-0 z-10 flex items-center gap-2 border-r border-border bg-surface px-3"
        style={{ gridColumn: 1, gridRow: `1 / span ${faixas}` }}
      >
        <AvatarDaPessoa pessoa={pessoa} tamanho="sm" />
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold text-text">{pessoa.nome}</span>
          <span className="block text-[10px] text-text-muted">
            {quantos === 1
              ? t("1 agendamento")
              : t("{n} agendamentos").replace("{n}", String(quantos))}
          </span>
        </span>
      </div>

      {colunas.map((c, i) => {
        const oferta = ofertas[i] ?? null;
        const clicavel = oferta !== null && onMarcarEm !== undefined;
        return (
          <button
            key={c.minuto}
            type="button"

            data-testid={`celula-${pessoa.id}-${c.rotulo}`}
            data-livre={oferta !== null}
            disabled={!clicavel}
            aria-label={
              clicavel
                ? t("Marcar com {pessoa} às {hora} de {data}")
                    .replace("{pessoa}", pessoa.nome)
                    .replace("{hora}", oferta.rotulo)
                    .replace("{data}", dataEscrita)
                : t("{pessoa} às {hora} — sem horário livre")
                    .replace("{pessoa}", pessoa.nome)
                    .replace("{hora}", c.rotulo)
            }
            title={clicavel ? oferta.rotulo : undefined}
            onClick={clicavel ? () => onMarcarEm(oferta.instante, pessoa.id) : undefined}
            className={cn(
              "border-l border-border/50 transition-colors duration-fast ease-out",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500",
              clicavel ? "cursor-pointer hover:bg-accent-soft" : "cursor-default",
            )}
            style={{ gridColumn: i + 2, gridRow: `1 / span ${faixas}` }}
          />
        );
      })}

      {posicoes.map((p) => {
        const estilo: React.CSSProperties = {
          gridColumn: `${p.coluna + 2} / span ${p.colunas}`,
          gridRow: p.faixa + 1,
        };
        if (p.item.tipo === "fechamento") {
          const f = p.item.fechamento;
          return (
            <div
              key={`f-${f.id}`}
              data-testid={`quadro-fechamento-${f.id}`}
              className="pointer-events-none z-[1] m-0.5 overflow-hidden rounded-sm border border-border px-1.5 py-0.5"
              style={{ ...estilo, background: HACHURA_DO_FECHAMENTO }}
            >
              <span className="block truncate text-[10px] leading-4 font-semibold text-text-muted">
                {f.motivo || t("Fechado")}
              </span>
            </div>
          );
        }
        const a = p.item.agendamento;
        const doGoogle = a.origem === "google_sync";
        const inicio = format(dataDeParede(new Date(a.comeca), fuso), "HH:mm");
        const fim = format(dataDeParede(new Date(a.termina), fuso), "HH:mm");
        const titulo = doGoogle ? t("Ocupado") : a.titulo;
        return (
          <button
            key={`a-${a.id}`}
            type="button"
            data-testid={`quadro-agendamento-${a.id}`}
            data-situacao={a.situacao}
            disabled={doGoogle || !onAbrirAgendamento}
            onClick={!doGoogle && onAbrirAgendamento ? () => onAbrirAgendamento(a.id) : undefined}
            aria-label={`${titulo}${a.quemSeraAtendido ? ` · ${a.quemSeraAtendido}` : ""} · ${inicio}–${fim}`}
            className={cn(
              "relative z-[2] m-0.5 flex min-w-0 flex-col overflow-hidden rounded-sm px-1.5 py-0.5 text-left",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500",
              doGoogle ? "cursor-default" : "cursor-pointer hover:brightness-95",
            )}
            style={{
              ...estilo,
              background: doGoogle
                ? "repeating-linear-gradient(135deg, var(--color-border) 0 4px, transparent 4px 10px), var(--color-surface-elevated)"
                : fundoDaTrilha(pessoa.trilha),
            }}
          >
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 w-[3px]"
              style={{
                backgroundColor: doGoogle
                  ? "var(--color-border-strong)"
                  : corDaTrilha(pessoa.trilha),
              }}
            />
            <span className="ml-1 truncate text-[11px] leading-4 font-semibold text-text">
              {titulo}
            </span>
            {a.quemSeraAtendido && !doGoogle ? (
              <span className="ml-1 truncate text-[10px] leading-3 text-text-muted">
                {a.quemSeraAtendido}
              </span>
            ) : null}
            <span className="ml-1 truncate text-[10px] leading-3 text-text-muted tabular-nums">
              {inicio}–{fim}
            </span>
          </button>
        );
      })}
    </div>
  );
}
