"use client";
import { useState } from "react";
import Link from "next/link";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";

import { ImportarLeads } from "./_components/ImportarLeads";
import { EmptyPipeline } from "@/components/empty";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/types";
import {
  Archive,
  ArrowBendUpLeft,
  CaretDown,
  CaretUp,
  Check,
  PencilSimple,
  Plus,
  Trash,
} from "@/lib/ui/icons";
import { useArquivarFunil, useCriarFunil, useEditarFunil } from "@/hooks/pipelines/usePipelines";

export interface FunilDaLista {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  position: number;
  is_default: boolean;
  is_client_pipeline?: boolean;
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
 * O `id` do `<ul>` da gaveta de arquivados — o que o botão da gaveta controla.
 *
 * O `aria-expanded` já dizia QUE a gaveta abre; não dizia QUAL lista abriu. Com
 * `aria-controls`, quem usa leitor de tela vai direto para a lista em vez de
 * procurá-la depois do clique. O atributo aponta para um id, então o id precisa
 * existir no `<ul>` — é este par que o teste de tela cobra.
 */
const ID_DA_LISTA_DE_ARQUIVADOS = "funis-arquivados";

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
  if (e instanceof ApiError) return t(e.message);
  if (e instanceof Error && e.message) return e.message;
  return t("Não consegui completar essa ação. Tente de novo.");
}

export function FunisClient({
  funis: funisDoServidor,
  arquivados: arquivadosDoServidor,
  podeGerenciar,
  podeImportar,
}: {
  funis: FunilDaLista[];
  /**
   * O que foi arquivado (#979) — SEPARADO dos vivos, nunca concatenado. É
   * `funis` que alimenta a lista de trabalho e o seletor de destino da
   * importação; funil arquivado ali seria destino que não existe mais.
   */
  arquivados: FunilDaLista[];
  /** Espelha o `requireRole("manager")` das rotas — ver o comentário da page. */
  podeGerenciar: boolean;
  /** Espelha o `requireRole("agent")` de `POST /api/v1/leads/import`. */
  podeImportar: boolean;
}) {
  const t = useT();
  /**
   * O funil de clientes só tem efeito com a regra "Clientes pela agenda" ligada
   * (migration 0262): desligada, o roteamento ignora a marca. Botão e selo
   * somem, e a marca gravada fica — volta a valer quando alguém religar.
   * Mostrar o controle com a regra desligada seria oferecer o que o motor
   * ignora.
   */
  const clientesLigado = useActiveOrg()?.cliente_pela_agenda === true;
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
  const [arquivados, setArquivados] = useState<FunilDaLista[]>(arquivadosDoServidor);
  const [ultimoDoServidor, setUltimoDoServidor] = useState<FunilDaLista[]>(funisDoServidor);
  // Ajuste DURANTE o render, não em efeito: é o padrão do React para "a prop
  // mudou, reponha o estado" e não dispara render em cascata (o efeito
  // equivalente dispara — o compilador avisa, e com razão).
  //
  // Uma comparação só para as DUAS listas: elas saem da mesma consulta do
  // servidor, então mudam juntas. Guardar um "último" para cada uma daria duas
  // fontes de verdade sobre o mesmo render.
  if (funisDoServidor !== ultimoDoServidor) {
    setUltimoDoServidor(funisDoServidor);
    setFunis(funisDoServidor);
    setArquivados(arquivadosDoServidor);
  }

  const criar = useCriarFunil();
  const editar = useEditarFunil();
  const arquivar = useArquivarFunil();

  const [novo, setNovo] = useState<string | null>(null);
  const [renomeando, setRenomeando] = useState<{ id: string; nome: string } | null>(null);
  const [arquivando, setArquivando] = useState<{ id: string; erro: string | null } | null>(null);
  const [excluindo, setExcluindo] = useState<{ id: string; erro: string | null } | null>(null);
  const [arquivoAberto, setArquivoAberto] = useState(false);
  const [erro, setErro] = useState<{ id: string | null; texto: string } | null>(null);

  const ocupado = criar.isPending || editar.isPending || arquivar.isPending;

  /**
   * As DUAS listas vêm de toda resposta, e as duas se aplicam juntas.
   *
   * Aplicar só `pipelines` deixaria a gaveta do arquivo mostrando o estado
   * anterior — o funil que acabou de sair do arquivo continuaria lá, e clicar de
   * novo levaria um 404. É o mesmo motivo de a tela aplicar o corpo em vez de
   * esperar o `router.refresh()`: o corpo JÁ é o que o banco tem.
   */
  function aplicarResposta(r: { data: { pipelines: FunilDaLista[]; arquivados: FunilDaLista[] } }) {
    setFunis(r.data.pipelines);
    setArquivados(r.data.arquivados);
  }

  function criarFunil() {
    const nome = (novo ?? "").trim();
    if (!nome) return;
    setErro(null);
    criar.mutate(nome, {
      onSuccess: (r) => {
        aplicarResposta(r);
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
          aplicarResposta(r);
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
          aplicarResposta(r);
          setArquivando(null);
        },
        // A recusa fica NO PAINEL, não numa faixa longe do botão: ela é a
        // resposta à pergunta que o usuário acabou de fazer.
        onError: (e) => setArquivando({ id, erro: textoDoErro(e, t) }),
      },
    );
  }

  /**
   * Excluir de vez a partir da GAVETA do arquivo.
   *
   * Mesma rota do "Excluir de vez" da lista viva (`DELETE ?definitivo=1`), com
   * um painel de confirmação próprio: a recusa precisa aparecer ao lado do botão
   * que a provocou, e o painel da lista viva vive dentro de outro `<li>`.
   */
  function excluirDoArquivo(id: string) {
    setErro(null);
    arquivar.mutate(
      { id, definitivo: true },
      {
        onSuccess: (r) => {
          aplicarResposta(r);
          setExcluindo(null);
        },
        onError: (e) => setExcluindo({ id, erro: textoDoErro(e, t) }),
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

  /**
   * A GAVETA DO ARQUIVO (#979) — a porta de volta que não existia.
   *
   * Até aqui, arquivar era via de mão única pela tela: o funil sumia da lista e
   * não havia onde vê-lo, trazê-lo de volta ou excluí-lo — "tenho funis
   * arquivados que não consigo deletar", nas palavras de quem abriu a issue.
   *
   * ⚠️ FECHADA POR PADRÃO, E FORA DA LISTA PRINCIPAL. O arquivo é o passado da
   * operação: quem abre esta tela quer os funis que estão em uso, e uma lista
   * misturada faria o operador escolher por engano um funil que não recebe mais
   * negócio. Some inteira quando não há nada arquivado — gaveta vazia é ruído
   * permanente por um gesto que se faz uma vez por ano.
   */
  const gavetaDeArquivados = podeGerenciar && arquivados.length > 0 && (
    <div className="flex flex-col gap-2" data-testid="arquivados">
      <Button
        variant="ghost"
        size="sm"
        className="self-start text-muted-foreground"
        onClick={() => setArquivoAberto((aberto) => !aberto)}
        aria-expanded={arquivoAberto}
        aria-controls={ID_DA_LISTA_DE_ARQUIVADOS}
        data-testid="arquivados-abrir"
      >
        <Archive size={16} className="mr-2" aria-hidden />
        {t("Funis arquivados")} ({arquivados.length})
        {arquivoAberto ? (
          <CaretUp size={16} className="ml-2" aria-hidden />
        ) : (
          <CaretDown size={16} className="ml-2" aria-hidden />
        )}
      </Button>

      {arquivoAberto && (
        <>
          <p className="text-xs text-muted-foreground" data-testid="arquivados-explicacao">
            {t(
              "Funil arquivado não aparece na lista nem recebe negócio novo. Traga de volta para usar outra vez, ou exclua de vez para liberar o nome.",
            )}
          </p>
          <ul
            id={ID_DA_LISTA_DE_ARQUIVADOS}
            className="flex flex-col divide-y divide-border rounded-md border border-border"
          >
            {arquivados.map((funil) => {
              const excluindoAqui = excluindo?.id === funil.id ? excluindo : null;

              return (
                <li
                  key={funil.id}
                  className="flex flex-col gap-3 p-4"
                  data-testid={`arquivado-${funil.id}`}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                      {funil.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">/{funil.slug}</span>
                    <div className="flex shrink-0 flex-wrap gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => aplicar(funil.id, { is_archived: false })}
                        disabled={ocupado}
                        data-testid={`desarquivar-${funil.id}`}
                      >
                        <ArrowBendUpLeft size={16} className="mr-1" aria-hidden />{" "}
                        {t("Tirar do arquivo")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setErro(null);
                          setExcluindo({ id: funil.id, erro: null });
                        }}
                        disabled={ocupado}
                        data-testid={`excluir-arquivado-${funil.id}`}
                      >
                        <Trash size={16} className="mr-1" aria-hidden /> {t("Excluir de vez")}
                      </Button>
                    </div>
                  </div>

                  {erro?.id === funil.id && (
                    <p
                      className="text-sm leading-relaxed text-destructive"
                      data-testid={`erro-arquivado-${funil.id}`}
                    >
                      {erro.texto}
                    </p>
                  )}

                  {/*
                    `AlertDialog`, e não `Card`: é o padrão que
                    `docs/doctrine/destrutivo-pede-confirmacao.md` (§Como aplicar)
                    fixa para o clique que apaga, o mesmo do quadro
                    (`KanbanCardActions`). O `Card` avisava, mas o foco ficava
                    solto na página e o leitor de tela continuava lendo a lista
                    atrás da pergunta — quem navega por teclado podia confirmar
                    sem nunca ter passado pela pergunta.
                  */}
                  <AlertDialog
                    open={excluindoAqui !== null}
                    onOpenChange={(aberto) => {
                      if (!aberto) setExcluindo(null);
                    }}
                  >
                    <AlertDialogContent
                      className="sm:max-w-md"
                      data-testid={`excluir-painel-${funil.id}`}
                    >
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("Excluir de vez")} «{funil.name}»?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t(
                            "Isso não tem volta: o funil e as etapas dele somem. Se ele já recebeu negócio, a exclusão é recusada e ele continua arquivado.",
                          )}
                        </AlertDialogDescription>
                      </AlertDialogHeader>

                      {excluindoAqui?.erro && (
                        // A recusa da rota, INTEIRA: é ela que diz quantos
                        // negócios o funil tem, ou qual formulário aponta para
                        // ele. Trocá-la por "erro ao excluir" seria um beco.
                        <p
                          className="text-sm leading-relaxed"
                          data-testid={`excluir-erro-${funil.id}`}
                        >
                          {excluindoAqui?.erro}
                        </p>
                      )}

                      <AlertDialogFooter>
                        <AlertDialogCancel
                          disabled={ocupado}
                          data-testid={`excluir-cancelar-${funil.id}`}
                        >
                          {t("Cancelar")}
                        </AlertDialogCancel>
                        {/*
                          `preventDefault` porque o `AlertDialogAction` fecha o
                          diálogo no próprio clique: sem ele a pergunta sumiria
                          ANTES de o servidor responder, e uma recusa chegaria
                          sobre uma tela que já disse "pronto". Quem fecha é o
                          `onSuccess`; o `disabled` evita o envio em dobro.
                        */}
                        <AlertDialogAction
                          className={buttonVariants({ variant: "destructive" })}
                          disabled={ocupado}
                          data-testid={`excluir-confirmar-${funil.id}`}
                          onClick={(e) => {
                            e.preventDefault();
                            excluirDoArquivo(funil.id);
                          }}
                        >
                          {t("Excluir de vez")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
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
        {/* Sem nenhum funil vivo, a gaveta é a ÚNICA saída de quem tem tudo
            arquivado — e sem ela a tela mandaria criar um funil novo por cima
            de um arquivo que o usuário não consegue ver. */}
        {gavetaDeArquivados}
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
                        {clientesLigado && funil.is_client_pipeline && (
                          <Badge variant="secondary" className="text-[10px]">
                            {t("Clientes")}
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
                    {/*
                      Ligar e desligar no MESMO lugar, ao contrário de "Tornar
                      padrão", que só liga: toda organização precisa de um funil
                      padrão, nenhuma precisa de um funil de clientes. Quem
                      experimentou tem de conseguir desfazer sem pedir ajuda.
                    */}
                    {clientesLigado && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          aplicar(funil.id, { is_client_pipeline: !funil.is_client_pipeline })
                        }
                        disabled={ocupado}
                        data-testid={`clientes-${funil.id}`}
                      >
                        <Check size={16} className="mr-1" aria-hidden />{" "}
                        {funil.is_client_pipeline
                          ? t("Deixar de ser funil de clientes")
                          : t("Funil de clientes")}
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

      {gavetaDeArquivados}

      {/*
        SEMPRE visível, e não só quando não há funil de clientes marcado: a regra
        de roteamento é invisível por natureza — ninguém descobre, olhando o
        quadro, por que um card nasceu num funil e não no outro. Dizer o que
        acontece nos DOIS estados é o caminho visível de falha do invariante 6,
        e custa uma linha de texto em vez de uma consulta.

        Com a regra desligada, o rodapé é a PORTA para ela: diz onde se liga.
      */}
      {clientesLigado ? (
        <p className="mt-4 text-xs text-muted-foreground" data-testid="funis-rodape-clientes">
          {t(
            "Quem já tem atendimento marcado entra pelo funil de clientes. Sem um funil marcado, entra pelo padrão.",
          )}
        </p>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground" data-testid="funis-rodape-clientes">
          {t(
            "Para separar quem já é cliente, ligue “Clientes pela agenda” em Configurações › Tipos de agendamento. Enquanto estiver desligado, todo contato novo entra pelo funil padrão.",
          )}{" "}
          <Link href="/app/settings/tenant/agenda" className="underline" data-testid="funis-rodape-ligar">
            {t("Abrir Tipos de agendamento")}
          </Link>
        </p>
      )}
    </div>
  );
}
