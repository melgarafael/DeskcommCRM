"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

/**
 * "Perguntar ao acervo" — o operador faz na tela a MESMA pergunta que a IA faria.
 *
 * Não há busca própria aqui: o componente só pergunta e mostra. Quem decide limiar,
 * top-K e o que contar quando não acha é a rota, que chama `buscarConhecimento` —
 * a operação única que a IA também usa. Duas buscas aqui passariam a responder
 * diferente sobre o mesmo acervo, que é o defeito que a casa já corrigiu uma vez.
 *
 * O `motivo` é obrigatório na tela. Quando não há trecho, o operador precisa
 * distinguir três coisas que, sem o número, chegam iguais:
 *   - acervo vazio (está errado ou recém-criado → não é "a base não sabe");
 *   - algo parecido abaixo do limiar (reformule a pergunta);
 *   - a base realmente não tem (peça para humano).
 * Mostrar "nenhum resultado" para as três seria prometer e desmentir depois.
 *
 * ─── A origem de cada trecho ────────────────────────────────────────────────
 *
 * O trecho sai com `knowledge_source_id` desde a F1 (#1869): sem ele o operador
 * lê "Política de troca" e não tem por onde abrir o material. O link só existe
 * para quem consegue abrir: a CONSULTA é `agent`+ (a rota de busca), a
 * BIBLIOTECA é `manager`+ (`app/app/ai/knowledge/sources/page.tsx` manda o resto
 * para /403 e o GET do conteúdo cobra `requireRole("manager")`). Quem pergunta
 * sem poder abrir continua vendo o NOME — o que não pode é clicar num link que
 * termina em 403, que é a mesma promessa-e-desmentido que esta tela evita.
 */

type Trecho = {
  chunk_id: string;
  /** Nulo quando a fonte foi apagada depois da indexação (FK `set null`). */
  knowledge_source_id?: string | null;
  source_name?: string | null;
  content: string;
  similarity: number;
};

type Resultado = {
  trechos: Trecho[];
  melhorSimilaridade: number | null;
  motivo: string | null;
  acervo: { fontes: number; limiar: number };
};

/** Similaridade de cosseno em [0,1] → percentual legível de verdade. */
function percentual(n: number): string {
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

export function AcervoSearch({ podeAbrirFonte = false }: { podeAbrirFonte?: boolean }) {
  const t = useT();
  const [pergunta, setPergunta] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  const pronta = pergunta.trim().length >= 2;

  async function perguntar() {
    if (!pronta || carregando) return;
    setCarregando(true);
    setErro(null);
    try {
      const res = await apiClient.post<{ data: Resultado }>("/api/v1/ai/knowledge/busca", {
        pergunta: pergunta.trim(),
      });
      setResultado(res.data);
    } catch (e) {
      // A rota JÁ traduz o estado em frase para o operador: 409 (sem chave de
      // embedding), 429 (limite por minuto), 403 (papel), 500 (leitura do
      // acervo). Antes só 409 e 429 chegavam à tela; o resto caía no genérico, e
      // o operador lia "não consegui consultar" sem o motivo que a rota tinha
      // dado. `ApiError` só carrega mensagem de envelope da casa — nunca stack —
      // e, quando o envelope não traz frase, `message` é o CÓDIGO (`rate_limited`),
      // que não se mostra: aí sim o genérico. Resposta SEM envelope (proxy, HTML
      // de erro) traz o corpo cru ou `HTTP 502` em `message`: também genérico.
      setErro(
        e instanceof ApiError && !e.semEnvelope && e.message && e.message !== e.code
          ? e.message
          : t("Não consegui consultar o acervo."),
      );
      setResultado(null);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="inbox-acervo">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void perguntar();
        }}
      >
        <Input
          value={pergunta}
          onChange={(e) => setPergunta(e.target.value)}
          placeholder={t("Pergunte ao acervo…")}
          aria-label={t("Perguntar ao acervo")}
          data-testid="acervo-pergunta"
          className="h-8 text-xs"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={!pronta || carregando}
          data-testid="acervo-buscar"
        >
          {carregando ? t("Buscando…") : t("Buscar")}
        </Button>
      </form>

      {erro && (
        <p className="text-xs text-destructive" data-testid="acervo-erro">
          {erro}
        </p>
      )}

      {carregando && (
        <div className="space-y-2" data-testid="acervo-carregando">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-4/5" />
        </div>
      )}

      {!carregando && resultado && (
        <div className="space-y-3">
          {resultado.trechos.length > 0 ? (
            <ul className="space-y-2" data-testid="acervo-trechos">
              {resultado.trechos.map((tr) => (
                <li
                  key={tr.chunk_id}
                  className="rounded-md border border-border bg-surface p-2 text-xs"
                  data-testid="acervo-trecho"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    {/* A origem: link para o material quando o leitor pode abrir a
                        biblioteca (`manager`+); o NOME para os demais. Ver o
                        docblock do topo — link que dá 403 é promessa-e-desmentido. */}
                    {tr.source_name &&
                      (podeAbrirFonte && tr.knowledge_source_id ? (
                        <Link
                          href={`/app/ai/knowledge/sources/${tr.knowledge_source_id}`}
                          className="truncate text-[10px] underline underline-offset-2 hover:text-accent"
                          aria-label={`${t("Abrir o material de origem")}: ${tr.source_name}`}
                          data-testid="acervo-fonte-link"
                        >
                          {tr.source_name}
                        </Link>
                      ) : (
                        <Badge
                          variant="outline"
                          className="truncate text-[10px]"
                          data-testid="acervo-fonte"
                        >
                          {tr.source_name}
                        </Badge>
                      ))}
                    <span
                      className="shrink-0 text-muted-foreground"
                      title={t("Semelhança com a pergunta")}
                    >
                      {percentual(tr.similarity)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-foreground">{tr.content}</p>
                </li>
              ))}
            </ul>
          ) : (
            // O motivo é obrigatório: ver o item do docblock no topo.
            <p className="text-xs text-muted-foreground" data-testid="acervo-motivo">
              {resultado.motivo ?? t("A base não tem essa informação.")}
            </p>
          )}

          <p className="text-[10px] text-muted-foreground" data-testid="acervo-resumo">
            {t("Materiais consultados")}: {resultado.acervo.fontes} ·{" "}
            {t("limiar")}: {percentual(resultado.acervo.limiar)}
          </p>
        </div>
      )}

      {!carregando && !resultado && !erro && (
        <p className="text-xs text-muted-foreground" data-testid="acervo-dica">
          {t("A mesma busca que a IA faz — com a mesma origem de cada trecho.")}
        </p>
      )}
    </div>
  );
}
