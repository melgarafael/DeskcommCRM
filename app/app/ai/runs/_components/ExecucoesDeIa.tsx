"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

/**
 * A tela de execuções de IA.
 *
 * Abre pelo RESUMO, não pela lista. A pergunta que traz alguém aqui é "está
 * tudo bem?", e obrigar a ler cem linhas para descobrir isso é como um painel
 * de log para de ser aberto. A lista completa fica logo abaixo, para quem já
 * sabe o que procura.
 *
 * Cada falha mostra três coisas, nesta ordem: o que o CLIENTE viu acontecer, o
 * que fazer a respeito, e só então a mensagem crua do provedor. A ordem é a
 * decisão de desenho mais importante aqui — invertê-la faz a tela abrir com
 * jargão e devolve ao operador o trabalho de adivinhação que ela veio acabar.
 */
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";

/**
 * O MESMO formato da tela de Uso — as duas leem `llm_calls.cost_cents`, que é
 * centavo de DÓLAR (`pricing.ts` cota o provedor em USD).
 */
const usd = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "USD",
  // 4 casas porque uma execução isolada custa fração de centavo, e arredondar
  // para 2 mostraria "R$ 0,00" para todas elas — o zero que não é zero.
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

interface Execucao {
  id: string;
  purpose: string;
  pontoRotulo: string;
  provider: string;
  model: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  http_status: number | null;
  consequencia: string | null;
  oQueFazer: string | null;
  porQueEsteModelo: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number | null;
  latency_ms: number | null;
  created_at: string;
}

interface Resumo {
  total: number;
  erros: number;
  porCodigo: Array<{ codigo: string; quantas: number; oQueFazer: string | null }>;
}

export function ExecucoesDeIa() {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const [execucoes, setExecucoes] = useState<Execucao[] | null>(null);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [soErros, setSoErros] = useState(false);

  const carregar = useCallback(async () => {
    // Mesmo tratamento do painel de provedores, e pela mesma razão medida lá:
    // sem ele, uma resposta não-JSON prende a tela em "Carregando…" sem nada
    // explicando — a falha muda que estas telas existem para acabar.
    try {
      const res = await fetch(`/api/v1/ai/runs${soErros ? "?status=erro" : ""}`);
      const texto = await res.text();
      let json: { data?: { execucoes: Execucao[]; resumo: Resumo }; error?: { message?: string } };
      try {
        json = JSON.parse(texto);
      } catch {
        setErro(`${t("resposta inesperada do servidor")} (${res.status}): ${texto.slice(0, 200)}`);
        return;
      }
      if (!res.ok) {
        setErro(
          json?.error?.message ? t(json.error.message) : `${t("não consegui carregar")} (${res.status})`,
        );
        return;
      }
      setErro(null);
      setExecucoes(json.data!.execucoes);
      setResumo(json.data!.resumo);
    } catch (e) {
      setErro(e instanceof Error ? e.message : t("não consegui falar com o servidor"));
    }
  }, [soErros, t]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (erro) {
    return (
      <div className="p-6">
        <Card className="border-destructive/40 p-6">
          <h2 className="font-medium">{t("Não consegui carregar as execuções")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{erro}</p>
          <Button className="mt-4" variant="outline" onClick={() => void carregar()}>
            {t("Tentar de novo")}
          </Button>
        </Card>
      </div>
    );
  }

  if (!execucoes || !resumo) {
    return <div className="p-6 text-sm text-muted-foreground">{t("Carregando…")}</div>;
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="execucoes-de-ia">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Execuções de IA")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {t(
            "Tudo que a inteligência artificial fez por aqui — e, quando algo falhou, o que aconteceu e o que fazer.",
          )}
        </p>
      </header>

      {/* O resumo responde "está tudo bem?" antes da lista. */}
      <Card className="mb-6 p-4" data-testid="resumo">
        {resumo.erros === 0 ? (
          <p className="text-sm">
            <span className="font-medium text-emerald-600 dark:text-emerald-500">
              {t("Nenhuma falha")}
            </span>{" "}
            {t("nas últimas")} {resumo.total} {t("execuções.")}
          </p>
        ) : (
          <div>
            <p className="text-sm font-medium text-destructive" data-testid="tem-falhas">
              {resumo.erros} {t("de")} {resumo.total} {t("execuções falharam.")}
            </p>
            <ul className="mt-3 space-y-2">
              {resumo.porCodigo.map((c) => (
                <li key={c.codigo} className="text-sm">
                  <Badge variant="outline" className="mr-2 font-mono text-xs">
                    {c.quantas}×
                  </Badge>
                  {c.oQueFazer ? t(c.oQueFazer) : c.codigo}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <div className="mb-3">
        <Button
          size="sm"
          variant={soErros ? "default" : "outline"}
          onClick={() => setSoErros((v) => !v)}
          data-testid="filtro-erros"
        >
          {soErros ? t("Mostrando só as falhas") : t("Ver só as falhas")}
        </Button>
      </div>

      {execucoes.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground" data-testid="lista-vazia">
          {soErros
            ? t("Nenhuma falha registrada.")
            : t("Nenhuma execução ainda. Assim que o agente atender alguém, aparece aqui.")}
        </Card>
      ) : (
        <div className="space-y-2">
          {execucoes.map((e) => (
            <Card
              key={e.id}
              className={e.status === "erro" ? "border-destructive/40 p-4" : "p-4"}
              data-testid={`execucao-${e.id}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{t(e.pontoRotulo)}</span>
                  {e.status === "erro" && (
                    <Badge variant="destructive" className="text-xs">
                      {t("falhou")}
                    </Badge>
                  )}
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  {e.provider} · {e.model}
                </span>
              </div>

              {e.status === "erro" ? (
                <div className="mt-2 space-y-2 text-sm">
                  {/* 1º: o que o CLIENTE viu. */}
                  {e.consequencia && (
                    <p data-testid="consequencia">
                      <span className="font-medium">{t("O que aconteceu:")}</span> {t(e.consequencia)}
                    </p>
                  )}
                  {/* 2º: o que fazer. */}
                  {e.oQueFazer && (
                    <p className="text-muted-foreground" data-testid="o-que-fazer">
                      <span className="font-medium">{t("O que fazer:")}</span> {t(e.oQueFazer)}
                    </p>
                  )}
                  {/* 3º: só então, o texto cru — para quem for investigar. */}
                  {e.error_message && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">{t("Mensagem técnica do provedor")}</summary>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2">
                        {e.error_message}
                        {e.http_status ? `\n(${t("código")} ${e.http_status})` : ""}
                      </pre>
                    </details>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  {e.input_tokens + e.output_tokens} tokens
                  {e.latency_ms !== null ? ` · ${e.latency_ms} ms` : ""}
                  {/* `cost_cents` está em CENTAVOS: dividir por 100 dá REAIS, e o
                      rótulo dizia "centavos" — uma execução de 25 centavos
                      aparecia como "0.2500 centavos", 100× menor que o mesmo
                      evento na tela de Uso, sem nenhuma das duas dizer qual
                      estava certa. Aqui vale o mesmo formato de lá: reais. */}
                  {e.cost_cents !== null ? ` · ${usd.format(e.cost_cents / 100)}` : ""}
                </p>
              )}

              <p className="mt-2 text-xs text-muted-foreground">
                {new Date(e.created_at).toLocaleString(tagDoIdioma)}
                {e.porQueEsteModelo ? ` · ${t(e.porQueEsteModelo)}` : ""}
              </p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
