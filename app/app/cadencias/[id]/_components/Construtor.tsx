"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCadencia } from "@/hooks/cadencias/useCadencias";
import { useT } from "@/hooks/i18n/useT";
import {
  atualizarPasso,
  duplicarPasso,
  encontrarPasso,
  haEmailAntes,
  inserirPasso,
  numerarPassos,
  passoVazio,
  removerPasso,
  todosOsPassos,
  validarPassos,
} from "@/lib/cadencias/arvore";
import type { Cadencia } from "@/lib/cadencias/tipos";
import { ArrowLeft, ChartBar, ClockCounterClockwise, Pause, Play } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { AbaConfiguracoes } from "./AbaConfiguracoes";
import { CanvasDoFluxo } from "./CanvasDoFluxo";
import { PainelDoPasso } from "./PainelDoPasso";

type Aba = "fluxo" | "configuracoes" | "desempenho" | "historico";

/** O que impede ativar e não pertence a um passo só. */
function problemasGerais(c: Cadencia): string[] {
  const out: string[] = [];
  if (!c.configuracao.tagDoSegmento.trim()) out.push("Escolha a tag do segmento em Configurações.");
  if (!todosOsPassos(c.passos).some((p) => p.tipo === "email")) out.push("A cadência precisa de pelo menos um e-mail.");
  if (!c.configuracao.caixaPadraoId) out.push("Escolha a caixa padrão em Configurações.");
  if (c.configuracao.janela.dias.length === 0) out.push("Escolha pelo menos um dia da semana para enviar.");
  return out;
}

export function Construtor({ id }: { id: string }) {
  const t = useT();
  const { cadencia, salvar, carregando } = useCadencia(id);
  const [aba, setAba] = useState<Aba>("fluxo");
  const [selecionado, setSelecionado] = useState<string | null>(null);

  const numeros = useMemo(() => numerarPassos(cadencia?.passos ?? []), [cadencia?.passos]);
  const erros = useMemo(
    () => validarPassos(cadencia?.passos ?? []) as Map<string, string[]>,
    [cadencia?.passos],
  );

  if (carregando) {
    return <Skeleton className="m-6 h-[600px]" />;
  }
  if (!cadencia) {
    return (
      <Card className="m-6 p-8 text-center">
        <p className="text-sm text-text-muted">{t("Cadência não encontrada.")}</p>
        <Button asChild variant="outline" className="mt-3">
          <Link href="/app/cadencias">{t("Voltar às cadências")}</Link>
        </Button>
      </Card>
    );
  }

  const ativa = cadencia.status === "ativa";
  // Cadência no ar não se edita pelo canvas: mudar um passo com lead no meio
  // do caminho é decisão que o backend vai tratar (versão nova). Pausa primeiro.
  const somenteLeitura = ativa;
  const passoAberto = selecionado ? encontrarPasso(cadencia.passos, selecionado) : null;
  const mudar = (patch: Partial<Cadencia>) => salvar({ ...cadencia, ...patch });

  const ativar = () => {
    const gerais = problemasGerais(cadencia);
    if (gerais.length > 0 || erros.size > 0) {
      const primeiro = gerais[0] ?? t("Há passos com problema — eles estão marcados em vermelho.");
      toast.error(t(primeiro));
      if (gerais.length === 0) setAba("fluxo");
      return;
    }
    mudar({ status: "ativa" });
    setSelecionado(null);
    toast.success(t("Cadência ativada."));
  };

  const abas: { id: Aba; rotulo: string }[] = [
    { id: "fluxo", rotulo: t("Fluxo") },
    { id: "configuracoes", rotulo: t("Configurações") },
    { id: "desempenho", rotulo: t("Desempenho") },
    { id: "historico", rotulo: t("Histórico") },
  ];

  return (
    // Altura presa à janela (menos a barra do app): só o canvas rola, e o zoom e
    // as abas ficam sempre à vista, como no construtor da HubSpot.
    <div
      className="flex h-[calc(100dvh-8rem)] min-h-[560px] flex-col overflow-hidden rounded-md border border-border"
      data-testid="construtor-cadencia"
    >
      <header className="flex flex-wrap items-center gap-3 bg-neutral-900 px-4 py-2.5 text-white">
        <Link
          href="/app/cadencias"
          className="flex items-center gap-1.5 text-sm font-medium text-white/90 hover:text-white"
        >
          <ArrowLeft size={16} aria-hidden /> {t("Cadências")}
        </Link>
        <span className="text-white/30" aria-hidden>
          /
        </span>
        <input
          aria-label={t("Nome da cadência")}
          value={cadencia.nome}
          onChange={(e) => mudar({ nome: e.target.value })}
          className="min-w-0 flex-1 rounded-sm bg-transparent px-1.5 py-1 text-sm font-semibold outline-hidden hover:bg-white/10 focus:bg-white/10"
          data-testid="nome-cadencia"
        />
        <span className="text-xs text-white/70">
          {t("A cadência está")}{" "}
          <strong className={cn(ativa ? "text-success" : "text-white")}>
            {ativa ? t("ATIVA") : cadencia.status === "pausada" ? t("PAUSADA") : t("DESATIVADA")}
          </strong>
        </span>
        {ativa ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              mudar({ status: "pausada" });
              toast(t("Cadência pausada. Nenhum e-mail novo sai até você ativar de novo."));
            }}
          >
            <Pause size={14} aria-hidden className="mr-1.5" /> {t("Pausar")}
          </Button>
        ) : (
          <Button size="sm" onClick={ativar} data-testid="ativar-cadencia">
            <Play size={14} aria-hidden className="mr-1.5" /> {t("Revisar e ativar")}
          </Button>
        )}
      </header>

      <nav className="flex items-center justify-center gap-1 border-b border-border bg-surface" role="tablist">
        {abas.map((a) => (
          <button
            key={a.id}
            type="button"
            role="tab"
            aria-selected={aba === a.id}
            onClick={() => setAba(a.id)}
            className={cn(
              "border-b-2 px-5 py-3 text-sm font-medium transition-colors",
              aba === a.id
                ? "border-accent text-text"
                : "border-transparent text-text-muted hover:text-text",
            )}
          >
            {a.rotulo}
          </button>
        ))}
      </nav>

      {ativa && aba !== "desempenho" && aba !== "historico" && (
        <div className="border-b border-warning/30 bg-warning-bg px-4 py-2 text-center text-xs text-warning-fg">
          {t("A cadência está no ar. Para editar os passos ou as configurações, pause primeiro.")}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {aba === "fluxo" && (
          <>
            <CanvasDoFluxo
              passos={cadencia.passos}
              configuracao={cadencia.configuracao}
              numeros={numeros}
              erros={erros}
              selecionado={selecionado}
              somenteLeitura={somenteLeitura}
              onSelecionar={setSelecionado}
              onAbrirConfiguracoes={() => setAba("configuracoes")}
              onInserir={(ponto, tipo) => {
                const novo = passoVazio(tipo);
                mudar({ passos: inserirPasso(cadencia.passos, ponto, novo) });
                setSelecionado(novo.id);
              }}
              onDuplicar={(pid) => mudar({ passos: duplicarPasso(cadencia.passos, pid) })}
              onExcluir={(pid) => {
                mudar({ passos: removerPasso(cadencia.passos, pid) });
                if (selecionado === pid) setSelecionado(null);
              }}
            />
            {passoAberto && (
              <PainelDoPasso
                key={passoAberto.id}
                passo={passoAberto}
                numero={numeros.get(passoAberto.id) ?? 0}
                erros={erros.get(passoAberto.id) ?? []}
                podeResponderNaMesmaConversa={haEmailAntes(cadencia.passos, passoAberto.id)}
                somenteLeitura={somenteLeitura}
                onMudar={(p) => mudar({ passos: atualizarPasso(cadencia.passos, p.id, p) })}
                onExcluir={() => {
                  mudar({ passos: removerPasso(cadencia.passos, passoAberto.id) });
                  setSelecionado(null);
                }}
                onFechar={() => setSelecionado(null)}
              />
            )}
          </>
        )}
        {aba === "configuracoes" && (
          <div className="flex-1">
            <AbaConfiguracoes
              configuracao={cadencia.configuracao}
              somenteLeitura={somenteLeitura}
              onMudar={(configuracao) => mudar({ configuracao })}
            />
          </div>
        )}
        {aba === "desempenho" && (
          <AbaAindaSemDados
            icone={<ChartBar size={28} aria-hidden />}
            titulo={t("O desempenho aparece quando os envios começarem")}
            texto={t("Por cadência e por etapa: enviados, abertos únicos, total de aberturas, média por lead, cliques, respostas, bounces e descadastros.")}
            colunas={[t("Enviados"), t("Abertos únicos"), t("Aberturas"), t("Cliques"), t("Respostas"), t("Bounces")]}
          />
        )}
        {aba === "historico" && (
          <AbaAindaSemDados
            icone={<ClockCounterClockwise size={28} aria-hidden />}
            titulo={t("Nenhum lead passou por esta cadência ainda")}
            texto={t("Cada inscrição, e-mail enviado, abertura, resposta e parada vai aparecer aqui, com data e hora.")}
          />
        )}
      </div>
    </div>
  );
}

function AbaAindaSemDados({
  icone,
  titulo,
  texto,
  colunas,
}: {
  icone: React.ReactNode;
  titulo: string;
  texto: string;
  colunas?: string[];
}) {
  const t = useT();
  const emBreve = t("Em breve");
  return (
    <div className="flex-1 overflow-y-auto bg-bg p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        {colunas && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {colunas.map((c) => (
              <Card key={c} className="p-4">
                <p className="text-xs text-text-muted">{c}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-text-subtle">—</p>
              </Card>
            ))}
          </div>
        )}
        <Card className="flex flex-col items-center gap-2 p-10 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
            {icone}
          </span>
          <p className="font-medium text-text">{titulo}</p>
          <p className="max-w-md text-sm text-text-muted">{texto}</p>
          <Badge variant="neutral" className="mt-2">
            {emBreve}
          </Badge>
        </Card>
      </div>
    </div>
  );
}
