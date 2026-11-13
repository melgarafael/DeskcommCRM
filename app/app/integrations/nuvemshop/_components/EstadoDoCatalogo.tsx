"use client";

/**
 * O ESTADO DO CATÁLOGO DA NUVEMSHOP NA TELA DA INTEGRAÇÃO (#4357).
 *
 * Conectar a loja não cria produto nenhum em CRM › Produtos: a carga inicial e
 * o webhook de produto indexam a fonte "Catálogo de produtos" da base de
 * conhecimento do agente (`workers/rag-indexer.ts:672`). A tela da integração
 * prometia CRM › Produtos e a pessoa procurava onde o texto mandava — não
 * achava nada e concluía que a sincronização não funcionava.
 *
 * Aqui o estado REAL dessa fonte aparece no lugar onde ela conectou a loja:
 * trechos, último preparo e o erro, se houve, com o atalho "Preparar de novo".
 * Nada de rota nova: lê pela listagem que já existe
 * (`GET /api/v1/ai/knowledge/sources`) e reprepara pela rota de reindex
 * (`POST /api/v1/ai/knowledge/sources/:id/reindex`), pelas mesmas mutações do
 * acervo (`hooks/ai/useKnowledgeSources`).
 *
 * O caso vazio é o mais importante: loja conectada que ainda não sincronizou
 * produto não pode ler "a integração está quebrada". Ela só ainda não tem
 * catálogo.
 */

import Link from "next/link";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SourceStatusBadge } from "@/components/ai/SourceStatusBadge";
import { useKnowledgeSources, useReindexSource } from "@/hooks/ai/useKnowledgeSources";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  /** Repreparar exige `manager` na API; abaixo disso o botão não é oferecido. */
  podePreparar: boolean;
}

export function EstadoDoCatalogo({ podePreparar }: Props) {
  const t = useT();
  const tag = useTagDeIdioma();
  const fontes = useKnowledgeSources();
  const reindex = useReindexSource();

  // A fonte é criada sozinha na primeira sincronização de produto; `is_active`
  // falso significa que ela foi arquivada, e aí não há estado para mostrar.
  const fonte = (fontes.data ?? []).find(
    (s) => s.source_type === "catalogo" && s.is_active && s.status !== "archived",
  );

  return (
    <Card data-testid="catalogo-nuvemshop">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t("Catálogo de produtos")}
            {fonte ? <SourceStatusBadge source={fonte} /> : null}
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "É para cá que os produtos da loja vão: o agente consulta esta fonte quando responde.",
            )}
          </p>
        </div>
        {fonte && podePreparar ? (
          <Button
            variant="outline"
            data-testid="catalogo-preparar-de-novo"
            disabled={reindex.isPending}
            onClick={() => reindex.mutate(fonte.id)}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${reindex.isPending ? "animate-spin" : ""}`}
              aria-hidden
            />
            {reindex.isPending ? t("Preparando…") : t("Preparar de novo")}
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-3 text-sm">
        {fontes.isLoading ? (
          <p className="text-muted-foreground">{t("Lendo o estado do catálogo…")}</p>
        ) : fontes.isError ? (
          // Falha de LEITURA não é falha da integração. A loja continua
          // conectada; o que não deu para ler foi o estado do acervo agora.
          <p className="text-muted-foreground" data-testid="catalogo-erro-leitura">
            {t("Não consegui ler o estado do catálogo agora. A integração continua conectada.")}
          </p>
        ) : !fonte ? (
          <div className="space-y-2" data-testid="catalogo-vazio">
            <p className="text-muted-foreground">
              {t(
                "O catálogo ainda não foi preparado. Assim que a loja enviar produtos, ele aparece aqui.",
              )}
            </p>
            <Link className="text-sm underline" href="/app/ai/knowledge/sources">
              {t("Ver o acervo do agente")}
            </Link>
          </div>
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <dt className="font-medium">{t("Trechos preparados")}</dt>
                <dd className="text-muted-foreground">{fonte.chunks_count}</dd>
              </div>
              <div>
                <dt className="font-medium">{t("Preparado em")}</dt>
                <dd className="text-muted-foreground">
                  {fonte.last_indexed_at
                    ? new Date(fonte.last_indexed_at).toLocaleString(tag)
                    : "—"}
                </dd>
              </div>
            </dl>

            {fonte.last_index_error ? (
              <div>
                <p className="font-medium">{t("Erro no último preparo")}</p>
                <p className="text-muted-foreground" data-testid="catalogo-erro">
                  {fonte.last_index_error}
                </p>
              </div>
            ) : null}

            <Link className="underline" href={`/app/ai/knowledge/sources/${fonte.id}`}>
              {t("Abrir no Conhecimento")}
            </Link>
            {!podePreparar ? (
              <p className="text-xs text-muted-foreground">
                {t("Só administradores podem preparar o catálogo de novo.")}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
