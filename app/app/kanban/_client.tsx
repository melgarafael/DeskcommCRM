"use client";
import { useState } from "react";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";

import { ImportarLeads } from "./_components/ImportarLeads";
import { EmptyPipeline } from "@/components/empty";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/types";
import { Archive, CaretDown, CaretUp, Check, PencilSimple, Plus } from "@/lib/ui/icons";
import { useArquivarFunil, useCriarFunil, useEditarFunil } from "@/hooks/pipelines/usePipelines";

export interface FunilDaLista {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  position: number;
  is_default: boolean;
}

/**
 * O vizinho DE CIMA depois de mover o funil uma casa (`null` = primeiro da lista).
 *
 * É o que o PATCH espera: quem clica na seta sabe onde o funil vai parar, não
 * qual fração de `position` isso vira. Subir uma casa é "passar a ficar depois de
 * quem estava DUAS casas acima" — daí o `i - 2`.
 */
export function vizinhoAoMover(
  funis: FunilDaLista[],
  i: number,
  direcao: "subir" | "descer",
): string | null {
  if (direcao === "subir") return funis[i - 2]?.id ?? null;
  return funis[i + 1]?.id ?? null;
}

/**
 * A mensagem que a rota escreveu, ou uma frase honesta quando não há nenhuma.
 *
 * ⚠️ NUNCA INVENTAR TEXTO NO LUGAR DA RECUSA. As mensagens de
 * `lib/pipelines/pipeline-editing.ts` são a única coisa que explica ao dono da
 * operação POR QUE o funil não pode ser arquivado (formulário apontando para ele,
 * automação ativa, funil padrão). Trocá-las por "erro ao arquivar" transformaria
 * uma instrução acionável em um beco sem saída.
 */
function textoDoErro(e: unknown, t: (texto: string) => string): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return t("Não consegui completar essa ação. Tente de novo.");
}

export function FunisClient({
  funis: funisDoServidor,
  podeGerenciar,
  podeImportar,
}: {
  funis: FunilDaLista[];
  /** Espelha o `requireRole("manager")` das rotas — ver o comentário da page. */
  podeGerenciar: boolean;
  /** Espelha o `requireRole("agent")` de `POST /api/v1/leads/import`. */
  podeImportar: boolean;
}) {
  const t = useT();
  /**
   * ⚠️ A LISTA VEM DO SERVIDOR E É ATUALIZADA PELO CORPO DA RESPOSTA.
   *
   * As rotas releem os funis do banco antes de responder, então aplicar o corpo
   * é mostrar o que o banco tem — sem depender de o `router.refresh()` vencer a
   * corrida contra os prefetches RSC da barra lateral (medido: numa rodada o
   * rename apareceu em 0,6s, noutra não apareceu em 7s, mesmo build). O ajuste
   * abaixo mantém as props no comando quando é o SERVIDOR que traz novidade —
   * navegação, refresh, outra aba.
   */
  const [funis, setFunis] = useState<FunilDaLista[]>(funisDoServidor);
  const [ultimoDoServidor, setUltimoDoServidor] = useState<FunilDaLista[]>(funisDoServidor);
  // Ajuste DURANTE o render, não em efeito: é o padrão do React para "a prop
  // mudou, reponha o estado" e não dispara render em cascata (o efeito
  // equivalente dispara — o compilador avisa, e com razão).
  if (funisDoServidor !== ultimoDoServidor) {
    setUltimoDoServidor(funisDoServidor);
    setFunis(funisDoServidor);
  }

  const criar = useCriarFunil();
  const editar = useEditarFunil();
  const arquivar = useArquivarFunil();

  const [novo, setNovo] = useState<string | null>(null);
  const [renomeando, setRenomeando] = useState<{ id: string; nome: string } | null>(null);
  const [arquivando, setArquivando] = useState<{ id: string; erro: string | null } | null>(null);
  const [erro, setErro] = useState<{ id: string | null; texto: string } | null>(null);

  const ocupado = criar.isPending || editar.isPending || arquivar.isPending;

  function criarFunil() {
    const nome = (novo ?? "").trim();
    if (!nome) return;
    setErro(null);
    criar.mutate(nome, {
      onSuccess: (r) => {
        setFunis(r.data.pipelines);
        setNovo(null);
      },
      onError: (e) => setErro({ id: null, texto: textoDoErro(e, t) }),
    });
  }

  function aplicar(id: string, patch: Parameters<typeof editar.mutate>[0]["patch"]) {
    setErro(null);
    editar.mutate(
      { id, patch },
      {
        onSuccess: (r) => {
          setFunis(r.data.pipelines);
          setRenomeando(null);
        },
        onError: (e) => setErro({ id, texto: textoDoErro(e, t) }),
      },
    );
  }

  function pedirArquivamento(id: string, definitivo: boolean) {
    setErro(null);
    arquivar.mutate(
      { id, definitivo },
      {
        onSuccess: (r) => {
          setFunis(r.data.pipelines);
          setArquivando(null);
        },
        // A recusa fica NO PAINEL, não numa faixa longe do botão: ela é a
        // resposta à pergunta que o usuário acabou de fazer.
        onError: (e) => setArquivando({ id, erro: textoDoErro(e, t) }),
      },
    );
  }

  const formularioDeCriacao = novo !== null && (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center" data-testid="form-novo-funil">
      <Input
        autoFocus
        value={novo}
        onChange={(e) => setNovo(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") criarFunil();
          if (e.key === "Escape") setNovo(null);
        }}
        placeholder={t("Nome do funil — ex.: Consultas, Obras, Matrículas")}
        aria-label={t("Nome do novo funil")}
        data-testid="nome-do-novo-funil"
        disabled={ocupado}
      />
      <div className="flex gap-2">
        <Button onClick={criarFunil} disabled={ocupado || !novo.trim()} data-testid="confirmar-novo-funil">
          {t("Criar funil")}
        </Button>
        <Button variant="ghost" onClick={() => setNovo(null)} disabled={ocupado}>
          {t("Cancelar")}
        </Button>
      </div>
    </Card>
  );

  if (funis.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        {formularioDeCriacao}
        {novo === null && (
          // ⚠️ O BOTÃO CRIA AQUI MESMO. O texto anterior mandava "Ir para
          // Configurações", e lá a tela de funis mandava de volta para o quadro:
          // pingue-pongue fechado, com o usuário procurando um botão que não
          // existia em lugar nenhum. Este é o estado de toda instalação em que o
          // gatilho de seed não rodou.
          <EmptyPipeline
            primary={
              podeGerenciar
                ? { label: t("Criar meu primeiro funil"), onClick: () => setNovo("") }
                : undefined
            }
          />
        )}
        {erro && (
          <p className="text-sm text-destructive" data-testid="erro-geral">
            {erro.texto}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {(podeGerenciar || podeImportar) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          {/* A porta da importação fica AQUI, e não numa tela própria: é desta
              lista que se escolhe o funil, e a planilha precisa de um destino.
              Uma rota nova exigiria um item de menu para uma coisa que se faz
              uma vez por mês — ruído permanente para um gesto ocasional. */}
          {podeImportar ? <ImportarLeads funis={funis} /> : null}
          {podeGerenciar && novo === null ? (
            <Button onClick={() => setNovo("")} disabled={ocupado} data-testid="novo-funil" className="w-full sm:w-auto">
              <Plus size={16} className="mr-2" aria-hidden /> {t("Novo funil")}
            </Button>
          ) : null}
        </div>
      )}

      {formularioDeCriacao}

      {erro?.id === null && (
        <p className="text-sm text-destructive" data-testid="erro-geral">
          {erro.texto}
        </p>
      )}

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {funis.map((funil, i) => {
          const renomeandoAqui = renomeando?.id === funil.id ? renomeando : null;
          const arquivandoAqui = arquivando?.id === funil.id ? arquivando : null;
          const erroDaLinha = erro?.id === funil.id ? erro.texto : null;

          return (
            <li key={funil.id} className="flex flex-col gap-3 p-4" data-testid={`funil-${funil.id}`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {podeGerenciar && (
                  <div className="flex shrink-0 flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("Subir")} «${funil.name}» ${t("na lista")}`}
                      data-testid={`subir-${funil.id}`}
                      disabled={ocupado || i === 0}
                      onClick={() => aplicar(funil.id, { depois_de: vizinhoAoMover(funis, i, "subir") })}
                    >
                      <CaretUp size={16} aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("Descer")} «${funil.name}» ${t("na lista")}`}
                      data-testid={`descer-${funil.id}`}
                      disabled={ocupado || i === funis.length - 1}
                      onClick={() => aplicar(funil.id, { depois_de: vizinhoAoMover(funis, i, "descer") })}
                    >
                      <CaretDown size={16} aria-hidden />
                    </Button>
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  {renomeandoAqui ? (
                    <div className="flex gap-2">
                      <Input
                        autoFocus
                        value={renomeandoAqui.nome}
                        onChange={(e) => setRenomeando({ id: funil.id, nome: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") aplicar(funil.id, { name: renomeandoAqui.nome });
                          if (e.key === "Escape") setRenomeando(null);
                        }}
                        aria-label={`${t("Novo nome de")} «${funil.name}»`}
                        data-testid={`nome-${funil.id}`}
                        disabled={ocupado}
                      />
                      <Button
                        size="sm"
                        onClick={() => aplicar(funil.id, { name: renomeandoAqui.nome })}
                        disabled={ocupado || !renomeandoAqui.nome.trim()}
                        data-testid={`salvar-nome-${funil.id}`}
                      >
                        {t("Salvar")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRenomeando(null)} disabled={ocupado}>
                        {t("Cancelar")}
                      </Button>
                    </div>
                  ) : (
                    <Link
                      href={`/app/pipelines/${funil.id}`}
                      className="group flex flex-col"
                      data-testid={`abrir-${funil.id}`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-sm font-medium group-hover:underline">{funil.name}</span>
                        {funil.is_default && (
                          <Badge variant="secondary" className="text-[10px]">
                            {t("Padrão")}
                          </Badge>
                        )}
                      </span>
                      {funil.description && (
                        <span className="text-xs text-muted-foreground">{funil.description}</span>
                      )}
                    </Link>
                  )}
                </div>

                <span className="shrink-0 text-xs text-muted-foreground">/{funil.slug}</span>

                {podeGerenciar && !renomeandoAqui && (
                  <div className="flex shrink-0 flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRenomeando({ id: funil.id, nome: funil.name })}
                      disabled={ocupado}
                      data-testid={`renomear-${funil.id}`}
                    >
                      <PencilSimple size={16} className="mr-1" aria-hidden /> {t("Renomear")}
                    </Button>
                    {!funil.is_default && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => aplicar(funil.id, { is_default: true })}
                        disabled={ocupado}
                        data-testid={`padrao-${funil.id}`}
                      >
                        <Check size={16} className="mr-1" aria-hidden /> {t("Tornar padrão")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setErro(null);
                        setArquivando({ id: funil.id, erro: null });
                      }}
                      disabled={ocupado}
                      data-testid={`arquivar-${funil.id}`}
                    >
                      <Archive size={16} className="mr-1" aria-hidden /> {t("Arquivar")}
                    </Button>
                  </div>
                )}
              </div>

              {erroDaLinha && (
                <p className="text-sm leading-relaxed text-destructive" data-testid={`erro-${funil.id}`}>
                  {erroDaLinha}
                </p>
              )}

              {arquivandoAqui && (
                <Card className="space-y-3 p-4" data-testid={`arquivar-painel-${funil.id}`}>
                  {arquivandoAqui.erro ? (
                    // A recusa da rota, INTEIRA: é ela que diz qual formulário ou
                    // automação está no caminho, e o que fazer antes de tentar de novo.
                    <p className="text-sm leading-relaxed" data-testid={`arquivar-erro-${funil.id}`}>
                      {arquivandoAqui.erro}
                    </p>
                  ) : (
                    <p className="text-sm leading-relaxed">
                      {t("Arquivar")} «{funil.name}»?{" "}
                      {t(
                        "Ele sai desta lista e para de receber negócio novo. O histórico continua guardado, e nada é apagado.",
                      )}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => pedirArquivamento(funil.id, false)}
                      disabled={ocupado}
                      data-testid={`arquivar-confirmar-${funil.id}`}
                    >
                      {t("Arquivar")}
                    </Button>
                    {/* Excluir de vez só passa no funil que NUNCA recebeu negócio.
                        A tela não sabe disso antes de perguntar — e não precisa
                        saber: a rota recusa explicando, e a explicação aparece
                        aqui mesmo. Fazer a tela adivinhar exigiria uma segunda
                        contagem, que discordaria da do servidor. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => pedirArquivamento(funil.id, true)}
                      disabled={ocupado}
                      data-testid={`excluir-${funil.id}`}
                    >
                      {t("Excluir de vez")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setArquivando(null)} disabled={ocupado}>
                      {t("Cancelar")}
                    </Button>
                  </div>
                </Card>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
