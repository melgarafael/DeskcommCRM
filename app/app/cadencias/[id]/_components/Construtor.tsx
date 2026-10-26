"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

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
  validarPassos,
} from "@/lib/cadencias/arvore";
import { problemasParaAtivar } from "@/lib/cadencias/ativacao";
import { Atividade } from "./Atividade";
import type { Cadencia } from "@/lib/cadencias/tipos";
import { ArrowLeft, Pause, Play } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { AbaConfiguracoes } from "./AbaConfiguracoes";
import { CanvasDoFluxo } from "./CanvasDoFluxo";
import { PainelDoPasso } from "./PainelDoPasso";

type Aba = "fluxo" | "configuracoes" | "atividade";

export function Construtor({ id }: { id: string }) {
  const t = useT();
  const { cadencia, salvar, carregando, mudandoStatus } = useCadencia(id);
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
  const somenteLeitura = ativa || mudandoStatus;
  const passoAberto = selecionado ? encontrarPasso(cadencia.passos, selecionado) : null;
  const mudar = (patch: Partial<Cadencia>) => salvar({ ...cadencia, ...patch });

  const ativar = async () => {
    const gerais = problemasParaAtivar(cadencia, t);
    if (gerais.length > 0 || erros.size > 0) {
      const primeiro = gerais[0] ?? t("Há passos com problema — eles estão marcados em vermelho.");
      toast.error(primeiro);
      if (gerais.length === 0) setAba("fluxo");
      return;
    }
    const salvo = await mudar({ status: "ativa" });
    if (!salvo) return;
    setSelecionado(null);
    toast.success(t("Cadência ativada."));
  };

  const abas: { id: Aba; rotulo: string }[] = [
    { id: "fluxo", rotulo: t("Fluxo") },
    { id: "configuracoes", rotulo: t("Configurações") },
    { id: "atividade", rotulo: t("Inscrições e atividade") },
  ];

  return (
    // Altura presa à janela (menos a barra do app): só o canvas rola, e o zoom e
    // as abas ficam sempre à vista, como no construtor da HubSpot.
    <div
      className="flex h-[calc(100dvh-8rem)] min-h-[560px] flex-col overflow-hidden rounded-md border border-border"
      data-testid="construtor-cadencia"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2.5 text-text">
        <Link
          href="/app/cadencias"
          className="flex items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
        >
          <ArrowLeft size={16} aria-hidden /> {t("Cadências")}
        </Link>
        <span className="text-border" aria-hidden>
          /
        </span>
        <input
          aria-label={t("Nome da cadência")}
          value={cadencia.nome}
          disabled={somenteLeitura}
          onChange={(e) => mudar({ nome: e.target.value })}
          className="min-w-0 flex-1 rounded-sm bg-transparent px-1.5 py-1 text-sm font-semibold outline-hidden hover:bg-surface-elevated focus:bg-surface-elevated"
          data-testid="nome-cadencia"
        />
        <span className="text-xs text-text-muted">
          {t("A cadência está")}{" "}
          <strong className={cn(ativa ? "text-success" : "text-text")}>
            {ativa ? t("ATIVA") : cadencia.status === "pausada" ? t("PAUSADA") : t("DESATIVADA")}
          </strong>
        </span>
        {ativa ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={mudandoStatus}
            onClick={async () => {
              if (!(await mudar({ status: "pausada" }))) return;
              toast(t("Cadência pausada. Nenhum e-mail novo sai até você ativar de novo."));
            }}
          >
            <Pause size={14} aria-hidden className="mr-1.5" /> {t("Pausar")}
          </Button>
        ) : (
          <Button size="sm" disabled={mudandoStatus} onClick={ativar} data-testid="ativar-cadencia">
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

      {ativa && aba !== "atividade" && (
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
        {aba === "atividade" && <Atividade id={id} ativa={ativa} />}
      </div>
    </div>
  );
}
