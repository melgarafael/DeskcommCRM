"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { aplicarQuadro, pularQuadro, type QuadroAtual } from "@/app/actions/onboarding/montarQuadro";
import { explicacaoDoPasso } from "@/lib/leads/agent-mapping";
import { MAX_ETAPAS, MIN_ETAPAS, type PropostaDeFunil } from "@/lib/onboarding/proposta-de-funil";
import { PACOTES } from "@/lib/onboarding/pacotes-de-funil";
import type { Sugestao } from "@/lib/onboarding/sugerir-funil";

/**
 * O quadro proposto, editável antes de existir.
 *
 * ⚠️ O QUE SE GRAVA É O QUE ESTÁ NA TELA. A proposta viaja de volta no envio, em
 * vez de ser regerada no servidor: um modelo com temperatura devolve um quadro
 * diferente a cada chamada, e a pessoa aprovaria um texto e receberia outro.
 */
export function QuadroClient({
  atual,
  sugestao,
}: {
  atual: QuadroAtual | null;
  sugestao: Sugestao;
}) {
  const t = useT();
  const inicial: PropostaDeFunil =
    sugestao.origem === "ia" ? sugestao.proposta : sugestao.pacote.proposta;

  const [quadro, setQuadro] = useState<PropostaDeFunil>(inicial);
  const [origem, setOrigem] = useState<"ia" | "pacote">(sugestao.origem);
  const [trocando, setTrocando] = useState(false);
  const [pending, startTransition] = useTransition();

  // Coluna sem nome é DESCARTADA por `normalizarProposta` — e descartar em
  // silêncio o que a pessoa acabou de acrescentar seria a falha calada clássica:
  // ela clica em salvar, avança, e a coluna simplesmente não existe. Barrar aqui
  // é o preço de ter o botão "Adicionar coluna".
  const semNome = quadro.etapas.some((e) => !e.nome.trim());

  function renomear(i: number, nome: string) {
    setQuadro((q) => ({ ...q, etapas: q.etapas.map((e, j) => (j === i ? { ...e, nome } : e)) }));
  }

  function remover(i: number) {
    setQuadro((q) => ({ ...q, etapas: q.etapas.filter((_, j) => j !== i) }));
  }

  /**
   * A coluna nova entra ANTES da primeira coluna de desfecho, não no fim.
   *
   * Percorrendo o wizard como dono: a IA propôs sete colunas para uma clínica e
   * esqueceu "Confirmação da véspera" — que é etapa de trabalho, e no fim da
   * lista ficaria depois de "Marcou consulta" e "Sumiu ou desistiu". Um quadro
   * cuja última coluna vem depois do fechamento não é lido como funil.
   */
  function adicionar() {
    setQuadro((q) => {
      const corte = q.etapas.findIndex((e) => e.passo === "won" || e.passo === "lost");
      const onde = corte === -1 ? q.etapas.length : corte;
      const etapas = [...q.etapas];
      etapas.splice(onde, 0, { nome: "", passo: null });
      return { ...q, etapas };
    });
  }

  function usarPacote(id: string) {
    const p = PACOTES.find((x) => x.id === id);
    if (!p) return;
    setQuadro(p.proposta);
    // A origem acompanha: o resumo do onboarding registra de onde o quadro veio,
    // e manter "ia" depois de a pessoa escolher outro seria registrar mentira.
    setOrigem("pacote");
    setTrocando(false);
  }

  return (
    <div className="space-y-6">
      {/*
        De onde veio o quadro. Quando a IA não respondeu, a pessoa PRECISA saber:
        ela acabou de configurar uma chave, e o silêncio aqui é a primeira pista
        de que ela não está funcionando — descoberta que, calada, só chegaria com
        o primeiro cliente real.
      */}
      {sugestao.origem === "ia" ? (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
          {t(
            "Seu funcionário montou este quadro olhando o que você me contou sobre o negócio. Ajuste o que quiser.",
          )}
        </p>
      ) : (
        <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <p>
            {t("Não consegui pedir uma sugestão para o seu funcionário agora")}
            {sugestao.porque ? <> — {t(sugestao.porque)}</> : null}. {t("Comecei por um quadro pronto de")}{" "}
            <strong>{t(sugestao.pacote.comoSeApresenta)}</strong>.
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              "Isso não trava nada: escolha outro modelo abaixo ou ajuste as colunas na mão. Dá para mudar tudo depois, quando quiser.",
            )}
          </p>
        </div>
      )}

      <div className="space-y-3 rounded-lg border bg-background p-6">
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="nome_do_quadro">
            {t("Nome do quadro")}
          </label>
          <Input
            id="nome_do_quadro"
            value={quadro.nome}
            onChange={(e) => setQuadro((q) => ({ ...q, nome: e.target.value }))}
            maxLength={80}
          />
        </div>

        <ol className="space-y-2">
          {quadro.etapas.map((etapa, i) => {
            const explicacao = etapa.passo ? explicacaoDoPasso(etapa.passo) : null;
            return (
              <li key={i} className="flex items-start gap-2 rounded-md border p-3">
                <span
                  aria-hidden
                  className="mt-2 w-5 shrink-0 text-center text-xs text-muted-foreground"
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <Input
                    aria-label={`${t("Nome da coluna")} ${i + 1}`}
                    value={etapa.nome}
                    onChange={(e) => renomear(i, e.target.value)}
                    maxLength={60}
                  />
                  <p className="text-xs text-muted-foreground">
                    {explicacao
                      ? `${t("Ele move o cliente para cá quando")} ${t(explicacao)}.`
                      : t("Coluna que só vocês movem — ele não mexe nesta.")}
                  </p>
                </div>
                {/*
                  As colunas de fechou/não fechou não são removíveis: sem elas o
                  banco recusa o quadro inteiro, e descobrir isso no clique de
                  salvar seria pior do que não oferecer o botão.
                */}
                {etapa.passo === "won" || etapa.passo === "lost" ? (
                  <span className="mt-2 shrink-0 text-xs text-muted-foreground">{t("obrigatória")}</span>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-1 shrink-0"
                    onClick={() => remover(i)}
                    disabled={quadro.etapas.length <= MIN_ETAPAS}
                  >
                    {t("Remover")}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>

        <div className="flex items-center justify-between pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={adicionar}
            disabled={quadro.etapas.length >= MAX_ETAPAS}
          >
            {t("Adicionar coluna")}
          </Button>
          {quadro.etapas.length >= MAX_ETAPAS ? (
            <span className="text-xs text-muted-foreground">
              {MAX_ETAPAS} {t("colunas é o máximo — mais que isso não cabe na tela do celular.")}
            </span>
          ) : null}
        </div>
      </div>

      {/* O que a instalação trouxe, para a troca não parecer mágica. */}
      {atual && atual.colunas.length > 0 ? (
        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {t("O que veio na instalação")} ({atual.nome})
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            {atual.colunas.join(" → ")}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("Este é o quadro padrão, feito para loja online. Ao continuar, ele é substituído pelo de cima.")}
          </p>
        </details>
      ) : null}

      <div className="space-y-3">
        {trocando ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {PACOTES.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => usarPacote(p.id)}
                className="rounded-md border p-3 text-left text-sm hover:bg-muted"
              >
                <span className="font-medium">{t(p.comoSeApresenta)}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {p.proposta.etapas.map((e) => e.nome).join(" → ")}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setTrocando(true)}
            className="text-sm text-muted-foreground underline underline-offset-2"
          >
            {t("Prefiro começar de um modelo pronto")}
          </button>
        )}
      </div>

      {/* `flex-wrap`: com o aviso "Dê um nome..." mais os dois botões, a linha
          passava de 320-375px sem margem nenhuma — este é o rodapé de
          navegação do wizard, o botão que a pessoa mais precisa achar. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => startTransition(async () => void (await pularQuadro()))}
        >
          {t("Pular por enquanto")}
        </Button>

        <div className="flex flex-wrap items-center gap-3">
          {semNome ? (
            <span className="text-xs text-amber-700 dark:text-amber-500">
              {t("Dê um nome à coluna em branco.")}
            </span>
          ) : null}
        <Button
          type="button"
          disabled={pending || semNome}
          onClick={() =>
            startTransition(async () => {
              const fd = new FormData();
              fd.set("quadro", JSON.stringify(quadro));
              fd.set("origem", origem);
              const res = await aplicarQuadro(fd);
              // Sucesso redireciona no servidor; só o desfecho ruim volta.
              if (res && !res.ok) toast.error(res.erro);
            })
          }
        >
          {pending ? t("Salvando...") : t("Usar este quadro")}
        </Button>
        </div>
      </div>
    </div>
  );
}
