"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/hooks/i18n/useT";
import type { IdDaLista, PontoDeInsercao } from "@/lib/cadencias/arvore";
import type { ConfiguracaoDaCadencia, Passo, TipoDePasso } from "@/lib/cadencias/tipos";
import {
  ArrowsOutSimple,
  CaretDown,
  Copy,
  Flag,
  Lightning,
  Minus,
  PencilSimple,
  Plus,
  StopCircle,
  Trash,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { ORDEM_DOS_TIPOS, VISUAL_DO_PASSO, resumirPasso } from "../../_components/visuais";

interface Props {
  configuracao: ConfiguracaoDaCadencia;
  numeros: Map<string, number>;
  erros: Map<string, string[]>;
  selecionado: string | null;
  somenteLeitura: boolean;
  onSelecionar: (id: string) => void;
  onInserir: (ponto: PontoDeInsercao, tipo: TipoDePasso) => void;
  onDuplicar: (id: string) => void;
  onExcluir: (id: string) => void;
  onAbrirConfiguracoes: () => void;
}

const ZOOMS = [0.5, 0.75, 0.9, 1, 1.1, 1.25];

/**
 * O fluxo da cadência de cima para baixo, no formato do construtor da HubSpot:
 * gatilho no topo, um card por passo, um "+" entre cada par, e o ramo abrindo
 * duas colunas. É HTML e CSS puros — não precisa de canvas livre com setas,
 * porque numa árvore a posição de cada card já é decidida pela ordem.
 */
export function CanvasDoFluxo({ passos, ...props }: Props & { passos: Passo[] }) {
  const t = useT();
  const [zoomIdx, setZoomIdx] = useState(3);
  const zoom = ZOOMS[zoomIdx] ?? 1;

  return (
    <div className="relative flex-1 overflow-hidden">
      <div className="absolute left-4 top-4 z-10 flex flex-col items-center gap-1">
        <Button
          size="icon"
          variant="secondary"
          aria-label={t("Aproximar")}
          onClick={() => setZoomIdx((i) => Math.min(i + 1, ZOOMS.length - 1))}
          disabled={zoomIdx === ZOOMS.length - 1}
        >
          <Plus size={16} aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          aria-label={t("Afastar")}
          onClick={() => setZoomIdx((i) => Math.max(i - 1, 0))}
          disabled={zoomIdx === 0}
        >
          <Minus size={16} aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("Tamanho original")}
          onClick={() => setZoomIdx(3)}
        >
          <ArrowsOutSimple size={16} aria-hidden />
        </Button>
        <span className="text-xs tabular-nums text-text-muted" data-testid="zoom-cadencia">
          {Math.round(zoom * 100)}%
        </span>
      </div>

      <div
        className="h-full overflow-auto bg-bg bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] bg-[length:20px_20px]"
        data-testid="canvas-cadencia"
      >
        <div
          className="mx-auto flex w-max min-w-full flex-col items-center px-16 pb-24 pt-8"
          style={{ zoom }}
        >
          <CartaoDoGatilho
            configuracao={props.configuracao}
            onClick={props.onAbrirConfiguracoes}
          />
          <ListaDePassos lista="raiz" passos={passos} {...props} />
          {/* Terminando num ramo, cada lado já mostra o próprio fim: um terceiro
              "fim" solto embaixo das duas colunas não pertenceria a caminho nenhum. */}
          {passos.at(-1)?.tipo !== "ramo" && (
            <CartaoDoFim configuracao={props.configuracao} onClick={props.onAbrirConfiguracoes} />
          )}
        </div>
      </div>
    </div>
  );
}

function ListaDePassos({
  lista,
  passos,
  ...props
}: Props & { lista: IdDaLista; passos: Passo[] }) {
  return (
    <>
      <Conector ponto={{ lista, indice: 0 }} {...props} />
      {passos.map((passo, i) => (
        <div key={passo.id} className="flex flex-col items-center">
          <CartaoDoPasso passo={passo} {...props} />
          {passo.tipo === "ramo" ? (
            <RamoAberto ramo={passo} {...props} />
          ) : (
            <Conector ponto={{ lista, indice: i + 1 }} {...props} />
          )}
        </div>
      ))}
    </>
  );
}

function RamoAberto({ ramo, ...props }: Props & { ramo: Extract<Passo, { tipo: "ramo" }> }) {
  const t = useT();
  const lados = [
    { lado: "sim" as const, rotulo: t("Sim"), passos: ramo.sim, cor: "bg-success text-white" },
    { lado: "nao" as const, rotulo: t("Não"), passos: ramo.nao, cor: "bg-error text-white" },
  ];
  return (
    <div className="flex flex-col items-center">
      <div className="h-5 w-px bg-border-strong" aria-hidden />
      <div className="grid w-max grid-cols-2 gap-8" data-testid={`ramo-${ramo.id}`}>
        {lados.map(({ lado, rotulo, passos, cor }, i) => (
          <div key={lado} className="relative flex flex-col items-center">
            {/* Meia linha horizontal: as duas metades se encontram no meio do vão
                entre as colunas, então o traço fica certo com colunas de largura
                diferente (um lado com outro ramo dentro é mais largo). */}
            <div
              aria-hidden
              className={cn(
                "absolute top-0 h-px bg-border-strong",
                i === 0 ? "left-1/2 -right-4" : "-left-4 right-1/2",
              )}
            />
            <div className="h-4 w-px bg-border-strong" aria-hidden />
            <span
              className={cn("rounded-sm px-2 py-0.5 text-xs font-semibold shadow-xs", cor)}
              data-testid={`ramo-${ramo.id}-${lado}`}
            >
              {rotulo}
            </span>
            <ListaDePassos lista={`${ramo.id}:${lado}`} passos={passos} {...props} />
            <span className="flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-text-muted">
              <Flag size={12} aria-hidden /> {t("Fim deste caminho")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Conector({
  ponto,
  somenteLeitura,
  onInserir,
}: Pick<Props, "somenteLeitura" | "onInserir"> & { ponto: PontoDeInsercao }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  return (
    <div className="flex flex-col items-center">
      <div className="h-4 w-px bg-border-strong" aria-hidden />
      {somenteLeitura ? (
        <div className="h-2 w-2 rounded-full bg-border-strong" aria-hidden />
      ) : (
        <Popover open={aberto} onOpenChange={setAberto}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("Adicionar passo aqui")}
              data-testid={`inserir-${ponto.lista}-${ponto.indice}`}
              className="flex h-6 w-6 items-center justify-center rounded-full border border-border-strong bg-surface text-text-muted shadow-xs transition hover:scale-110 hover:border-accent hover:text-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              <Plus size={12} weight="bold" aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-1" align="center">
            <p className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-text-muted">
              {t("Adicionar passo")}
            </p>
            {ORDEM_DOS_TIPOS.map((tipo) => {
              const v = VISUAL_DO_PASSO[tipo];
              const Icon = v.icon;
              return (
                <button
                  key={tipo}
                  type="button"
                  data-testid={`opcao-${tipo}`}
                  className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-accent-soft"
                  onClick={() => {
                    onInserir(ponto, tipo);
                    setAberto(false);
                  }}
                >
                  <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md", v.chip)}>
                    <Icon size={16} aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text">{t(v.rotulo)}</span>
                    <span className="block text-xs text-text-muted">{t(v.descricao)}</span>
                  </span>
                </button>
              );
            })}
          </PopoverContent>
        </Popover>
      )}
      <div className="h-4 w-px bg-border-strong" aria-hidden />
    </div>
  );
}

function CartaoDoPasso({
  passo,
  numeros,
  erros,
  selecionado,
  somenteLeitura,
  onSelecionar,
  onDuplicar,
  onExcluir,
}: Props & { passo: Passo }) {
  const t = useT();
  const v = VISUAL_DO_PASSO[passo.tipo];
  const Icon = v.icon;
  const problemas = erros.get(passo.id) ?? [];
  const n = numeros.get(passo.id) ?? 0;

  return (
    <div
      className={cn(
        "w-72 overflow-hidden rounded-md border border-border bg-surface shadow-sm transition-shadow hover:shadow-md",
        selecionado === passo.id && "ring-2 ring-accent-500 ring-offset-2 ring-offset-bg",
        problemas.length > 0 && "border-error",
      )}
      data-testid={`passo-${passo.id}`}
    >
      <div className={cn("flex items-center gap-2 border-b px-3 py-1.5 text-xs font-semibold", v.cabecalho)}>
        <Icon size={14} aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {n}. {t(v.rotulo)}
        </span>
        {!somenteLeitura && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-0.5 rounded-sm px-1 underline-offset-2 hover:underline"
                data-testid={`acoes-${passo.id}`}
              >
                {t("Ações")} <CaretDown size={10} aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onSelecionar(passo.id)}>
                <PencilSimple size={14} aria-hidden className="mr-2" /> {t("Editar")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onDuplicar(passo.id)}>
                <Copy size={14} aria-hidden className="mr-2" /> {t("Duplicar")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-error-fg focus:text-error-fg"
                onSelect={() => onExcluir(passo.id)}
              >
                <Trash size={14} aria-hidden className="mr-2" /> {t("Excluir")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <button
        type="button"
        onClick={() => onSelecionar(passo.id)}
        className="block w-full px-3 py-3 text-center text-sm text-text hover:bg-surface-elevated focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
      >
        <span className="line-clamp-3 break-words">{comVariaveis(resumirPasso(passo, t))}</span>
        {passo.tipo === "email" && passo.corpo.trim() && (
          <span className="mt-1 line-clamp-2 block text-xs text-text-muted">
            {comVariaveis(passo.corpo.replace(/\s+/g, " ").trim())}
          </span>
        )}
      </button>
      {problemas.length > 0 && (
        <p className="border-t border-error/30 bg-error-bg px-3 py-1.5 text-xs text-error-fg">
          {t(problemas[0] ?? "")}
        </p>
      )}
    </div>
  );
}

/** `{{primeiro_nome}}` vira uma etiqueta — no card, o que é variável salta aos olhos. */
function comVariaveis(texto: string) {
  return texto.split(/(\{\{\s*[a-z_]+\s*\}\})/g).map((parte, i) =>
    /^\{\{/.test(parte) ? (
      <span key={i} className="rounded-sm bg-accent-soft px-1 font-mono text-[0.85em] text-accent">
        {parte.replace(/[{}\s]/g, "")}
      </span>
    ) : (
      parte
    ),
  );
}

function CartaoDoGatilho({
  configuracao,
  onClick,
}: {
  configuracao: ConfiguracaoDaCadencia;
  onClick: () => void;
}) {
  const t = useT();
  const tag = configuracao.tagDoSegmento.trim();
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-80 overflow-hidden rounded-md border border-border bg-surface text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500"
      data-testid="gatilho-cadencia"
    >
      <div className="flex items-center gap-2 border-b border-border bg-surface-elevated px-3 py-1.5 text-xs font-semibold text-text">
        <Lightning size={14} weight="fill" aria-hidden className="text-accent" />
        {t("Gatilho de inscrição")}
      </div>
      <div className="p-3">
        <div className="rounded-sm border border-dashed border-border px-3 py-2 text-center text-sm">
          {tag ? (
            <>
              <span className="text-text-muted">{t("Lead recebe a tag")} </span>
              <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-xs font-semibold text-accent">
                {tag}
              </span>
              {configuracao.somenteEmailValidado && (
                <span className="mt-1 block text-xs text-text-muted">
                  {t("e tem e-mail validado")}
                </span>
              )}
            </>
          ) : (
            <span className="text-warning-fg">{t("Escolha a tag do segmento em Configurações")}</span>
          )}
        </div>
        <p className="mt-2 text-center text-xs text-text-muted">
          {t("Também dá para inscrever leads manualmente ou em lote.")}
        </p>
      </div>
    </button>
  );
}

function CartaoDoFim({
  configuracao,
  onClick,
}: {
  configuracao: ConfiguracaoDaCadencia;
  onClick: () => void;
}) {
  const t = useT();
  const p = configuracao.paradas;
  const motivos = [
    p.respondeu && t("responder"),
    p.bounce && t("o e-mail voltar"),
    p.descadastro && t("se descadastrar"),
    p.ganhoOuPerdido && t("o card for para ganho ou perdido"),
  ].filter(Boolean) as string[];
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-80 items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-xs text-text-muted shadow-xs hover:shadow-sm"
      data-testid="fim-cadencia"
    >
      <StopCircle size={16} aria-hidden className="mt-0.5 shrink-0 text-text-subtle" />
      <span>
        <span className="block font-semibold text-text">{t("Fim da cadência")}</span>
        {motivos.length > 0 && (
          <>
            {t("Para antes se o lead")} {motivos.join(", ")}.
          </>
        )}
      </span>
    </button>
  );
}
