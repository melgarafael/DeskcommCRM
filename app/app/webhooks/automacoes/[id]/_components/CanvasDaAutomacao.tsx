"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Background,
  ConnectionLineType,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
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
import { CaretLeft, Plus, Trash, TreeStructure, X } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import {
  useCreateAutomationRule,
  useUpdateAutomationRule,
  type AutomationRuleRow,
} from "@/hooks/webhooks/useAutomationRules";
import { acoesQueFechamLaco, MENSAGEM_DO_LACO_DE_LEAD } from "@/lib/schemas/webhooks";
import {
  ID_DAS_CONDICOES,
  MAXIMO_DE_ACOES,
  PROBLEMAS,
  desenhoDaRegra,
  desenhoDaTela,
  excluirCaixa,
  excluirLigacao,
  inserirDepois,
  ligar,
  organizar,
  percorrer,
  proximoId,
  validarDesenho,
  type AcaoDaRegra,
  type CaixaDoDesenho,
  type DadosDaCaixa,
  type Desenho,
  type ProblemaDoDesenho,
  type RegraGravada,
} from "@/lib/automation/desenho-da-regra";
import { defaultActionConfig } from "@/app/app/webhooks/_components/ActionConfigForm";
import { ACTION_LABELS, type ActionType } from "@/app/app/webhooks/_components/labels";

import { CaixaDaAutomacao, type NoDaAutomacao } from "./CaixaDaAutomacao";
import { DND_DA_AUTOMACAO, PaletaDaAutomacao, type ItemDaPaleta } from "./PaletaDaAutomacao";
import {
  PainelDaAcao,
  PainelDaLigacao,
  PainelDasCondicoes,
  PainelDoGatilho,
  ResumoDaAutomacao,
} from "./PainelDaCaixa";

// Fora do componente: o React Flow remonta os nós se `nodeTypes` muda a cada render.
const nodeTypes: NodeTypes = { gatilho: CaixaDaAutomacao, condicoes: CaixaDaAutomacao, acao: CaixaDaAutomacao };

const VOLTAR = "/app/webhooks?aba=automacoes";

function paraNos(desenho: Desenho): NoDaAutomacao[] {
  return desenho.caixas.map((c) => ({ id: c.id, type: c.type, position: c.position, data: c.data }));
}
function paraLigacoes(desenho: Desenho): Edge[] {
  return desenho.ligacoes.map((l) => ({ id: l.id, source: l.source, target: l.target }));
}
/** A "versão salva" para o aviso de alterações: nome, dados e ligações — nunca posição. */
function retrato(nome: string, desenho: Desenho): string {
  return JSON.stringify({
    nome,
    caixas: desenho.caixas.map((c) => [c.id, c.data]),
    ligacoes: desenho.ligacoes.map((l) => [l.source, l.target]).sort(),
  });
}

function regraGravadaDe(regra: AutomationRuleRow | null): RegraGravada | null {
  if (!regra) return null;
  return {
    trigger_event: regra.trigger_event,
    trigger_config: regra.trigger_config,
    conditions: regra.conditions,
    actions: regra.actions,
  };
}

interface Props {
  regra: AutomationRuleRow | null;
}

export function CanvasDaAutomacao({ regra }: Props) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const { fitView, screenToFlowPosition } = useReactFlow();
  const regraGravada = useMemo(() => regraGravadaDe(regra), [regra]);
  // O desenho inicial nasce UMA vez: refetch da lista não pode atropelar edição.
  const inicial = useMemo(
    () => organizar(desenhoDaRegra(regraGravada)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [nos, setNos, onNodesChange] = useNodesState<NoDaAutomacao>(paraNos(inicial));
  const [ligacoes, setLigacoes, onEdgesChange] = useEdgesState<Edge>(paraLigacoes(inicial));
  const [nome, setNome] = useState(regra?.name ?? "");
  const [salvo, setSalvo] = useState(() => retrato(regra?.name ?? "", inicial));
  const [ativo, setAtivo] = useState(regra?.is_active ?? false);
  const [noSelecionado, setNoSelecionado] = useState<string | null>(null);
  const [ligacaoSelecionada, setLigacaoSelecionada] = useState<string | null>(null);
  const [problemasGerais, setProblemasGerais] = useState<ProblemaDoDesenho[]>([]);
  const [confirmarExclusao, setConfirmarExclusao] = useState(false);
  const [paletaAberta, setPaletaAberta] = useState(false);
  const criar = useCreateAutomationRule();
  const atualizar = useUpdateAutomationRule();
  const salvando = criar.isPending || atualizar.isPending;

  const desenho = useMemo(() => desenhoDaTela(nos, ligacoes), [nos, ligacoes]);
  const percurso = useMemo(() => percorrer(desenho), [desenho]);
  const evento = percurso.gatilho?.data.kind === "gatilho" ? percurso.gatilho.data.evento : "";
  const sujo = retrato(nome, desenho) !== salvo;

  const tituloDaAcao = useCallback(
    (acao: AcaoDaRegra) =>
      acao.type === "ai_decide" ? t("A IA decide") : t(ACTION_LABELS[acao.type as ActionType] ?? acao.type),
    [t],
  );
  const tituloDaCaixa = useCallback(
    (c: { data: DadosDaCaixa }) =>
      c.data.kind === "gatilho" ? t("Gatilho") : c.data.kind === "condicoes" ? t("Condições") : tituloDaAcao(c.data.acao),
    [t, tituloDaAcao],
  );

  // A posição de cada caixa na fila, escrita em cima do título.
  const etapas = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of percurso.fila) {
      if (c.data.kind === "gatilho") m.set(c.id, t("Quando"));
      else if (c.data.kind === "condicoes") m.set(c.id, c === percurso.condicoes ? t("Se") : t("Fora do lugar"));
    }
    percurso.acoes.forEach((c, i) => m.set(c.id, `${t("Então")} · ${t("Ação")} ${i + 1}`));
    for (const c of desenho.caixas) if (!m.has(c.id)) m.set(c.id, t("Fora da automação"));
    return m;
  }, [percurso, desenho, t]);

  const nosNaTela = useMemo(
    () => nos.map((n) => ({ ...n, data: { ...n.data, etapa: etapas.get(n.id), eventoDaRegra: evento } })),
    [nos, etapas, evento],
  );
  const ligacoesNaTela = useMemo(
    () =>
      ligacoes.map((l) => {
        const origem = nos.find((n) => n.id === l.source);
        return {
          ...l,
          type: "smoothstep" as const,
          label: origem?.data.kind === "condicoes" ? t("se atender") : undefined,
          selected: l.id === ligacaoSelecionada,
        };
      }),
    [ligacoes, nos, ligacaoSelecionada, t],
  );

  /** Troca o desenho inteiro, mantendo o que o React Flow já mediu de cada caixa. */
  const aplicar = useCallback(
    (novo: Desenho) => {
      setNos((atuais) =>
        novo.caixas.map((c) => {
          const antigo = atuais.find((n) => n.id === c.id);
          return antigo ? { ...antigo, position: c.position, data: c.data } : { id: c.id, type: c.type, position: c.position, data: c.data };
        }),
      );
      setLigacoes(paraLigacoes(novo));
    },
    [setNos, setLigacoes],
  );

  const reorganizar = useCallback(
    (base: Desenho) => {
      const alturas = new Map(nos.map((n) => [n.id, n.measured?.height ?? 0] as const).filter(([, h]) => h > 0));
      aplicar(organizar(base, alturas));
      window.setTimeout(() => void fitView({ padding: 0.2, duration: 200 }), 0);
    },
    [nos, aplicar, fitView],
  );

  const mudarDados = useCallback(
    (id: string, dados: DadosDaCaixa) => {
      // Editar uma caixa tira dela o aviso antigo: o próximo salvar confere de novo.
      setNos((atuais) => atuais.map((n) => (n.id === id ? { ...n, data: dados } : n)));
    },
    [setNos],
  );

  const adicionar = useCallback(
    (tipo: ItemDaPaleta, posicao?: { x: number; y: number }) => {
      if (tipo === "condicoes" && desenho.caixas.some((c) => c.data.kind === "condicoes")) {
        setNoSelecionado(ID_DAS_CONDICOES);
        setLigacaoSelecionada(null);
        toast.info(t("As condições ficam numa caixa só. Acrescente a nova condição nela."));
        return;
      }
      if (tipo !== "condicoes" && acoesQueFechamLaco(evento, [{ type: tipo }]).length > 0) {
        toast.error(t(MENSAGEM_DO_LACO_DE_LEAD));
        return;
      }
      if (tipo !== "condicoes" && !posicao && percurso.acoes.length >= MAXIMO_DE_ACOES) {
        toast.error(t(PROBLEMAS.acoesDemais));
        return;
      }
      const id = tipo === "condicoes" ? ID_DAS_CONDICOES : proximoId(desenho.caixas.map((c) => c.id), "acao");
      const nova: CaixaDoDesenho =
        tipo === "condicoes"
          ? { id, type: "condicoes", position: posicao ?? { x: 0, y: 0 }, data: { kind: "condicoes", linhas: [{ field: "", op: "eq", value: "" }] } }
          : {
              id,
              type: "acao",
              position: posicao ?? { x: 0, y: 0 },
              data: { kind: "acao", acao: defaultActionConfig(tipo) as unknown as AcaoDaRegra },
            };
      setNoSelecionado(id);
      setLigacaoSelecionada(null);
      if (posicao) {
        // Soltar no canvas: a caixa fica onde caiu, e a ligação é feita à mão.
        aplicar({ caixas: [...desenho.caixas, nova], ligacoes: desenho.ligacoes });
        return;
      }
      reorganizar(inserirDepois(desenho, noSelecionado, nova));
    },
    [desenho, evento, percurso.acoes.length, noSelecionado, aplicar, reorganizar, t],
  );

  const onConnect = useCallback(
    (conexao: Connection) => {
      const r = ligar(desenho, conexao.source, conexao.target);
      if (!r.ok) {
        if (r.recusa) toast.error(t(r.recusa));
        return;
      }
      aplicar(r.desenho);
      if (r.aviso) toast.info(t(r.aviso));
    },
    [desenho, aplicar, t],
  );

  const excluirSelecao = useCallback(() => {
    if (noSelecionado) {
      reorganizar(excluirCaixa(desenho, noSelecionado));
      setNoSelecionado(null);
    } else if (ligacaoSelecionada) {
      aplicar(excluirLigacao(desenho, ligacaoSelecionada));
      setLigacaoSelecionada(null);
    }
  }, [noSelecionado, ligacaoSelecionada, desenho, reorganizar, aplicar]);

  const salvar = useCallback(async () => {
    const resultado = validarDesenho({ nome, desenho, regraGravada });
    const porCaixa = new Map<string, ProblemaDoDesenho[]>();
    for (const p of resultado.problemas) {
      if (p.caixa) porCaixa.set(p.caixa, [...(porCaixa.get(p.caixa) ?? []), p]);
    }
    setNos((atuais) => atuais.map((n) => ({ ...n, data: { ...n.data, problemas: porCaixa.get(n.id) } })));
    setProblemasGerais(resultado.problemas.filter((p) => p.caixa === null));
    if (!resultado.ok) {
      setNoSelecionado(null);
      setLigacaoSelecionada(null);
      toast.error(t("A automação não foi salva. Corrija os pontos marcados nas caixas."));
      return;
    }
    try {
      if (regra) {
        await atualizar.mutateAsync({ id: regra.id, ...resultado.corpo });
        setSalvo(retrato(nome, desenho));
        toast.success(t("Automação atualizada."));
      } else {
        const criada = await criar.mutateAsync(resultado.corpo);
        toast.success(t("Automação criada — ligue quando estiver pronta."));
        setSalvo(retrato(nome, desenho));
        // A regra nova entra na lista antes de trocar de endereço: a tela da
        // automação gravada abre direto, sem esperar a lista recarregar.
        qc.setQueryData<{ data: AutomationRuleRow[] }>(["automation-rules"], (velho) =>
          velho ? { data: [...velho.data.filter((r) => r.id !== criada.data.id), criada.data] } : { data: [criada.data] },
        );
        router.replace(`/app/webhooks/automacoes/${criada.data.id}`);
      }
    } catch {
      /* showApiError já mostrou o toast */
    }
  }, [nome, desenho, regraGravada, regra, atualizar, criar, router, qc, setNos, t]);

  const alternarAtivo = useCallback(
    (ligar: boolean) => {
      if (!regra) return;
      setAtivo(ligar);
      atualizar.mutate(
        { id: regra.id, is_active: ligar },
        {
          onSuccess: () => toast.success(ligar ? t("Automação ligada.") : t("Automação pausada.")),
          onError: () => setAtivo(!ligar),
        },
      );
    },
    [regra, atualizar, t],
  );

  const onNodeClick = useCallback<NodeMouseHandler<NoDaAutomacao>>((_, no) => {
    setNoSelecionado(no.id);
    setLigacaoSelecionada(null);
  }, []);
  const onEdgeClick = useCallback<EdgeMouseHandler>((_, l) => {
    setLigacaoSelecionada(l.id);
    setNoSelecionado(null);
  }, []);
  const onPaneClick = useCallback(() => {
    setNoSelecionado(null);
    setLigacaoSelecionada(null);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const tipo = e.dataTransfer.getData(DND_DA_AUTOMACAO) as ItemDaPaleta | "";
      if (!tipo) return;
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      adicionar(tipo, { x: Math.round(p.x - 112), y: Math.round(p.y - 24) });
    },
    [screenToFlowPosition, adicionar],
  );

  const selecionado = nos.find((n) => n.id === noSelecionado) ?? null;
  const ligacao = ligacoes.find((l) => l.id === ligacaoSelecionada) ?? null;
  const podeExcluir = (selecionado && selecionado.data.kind !== "gatilho") || ligacao;

  const painel = selecionado ? (
    selecionado.data.kind === "gatilho" ? (
      <PainelDoGatilho
        dados={selecionado.data}
        etapa={etapas.get(selecionado.id)}
        onEvento={(novo) => {
          const dados = selecionado.data;
          if (dados.kind !== "gatilho" || novo === dados.evento) return;
          // Trocar o gatilho limpa as condições e a fonte — o mesmo do editor em lista.
          setNos((atuais) =>
            atuais.map((n) => {
              if (n.id === selecionado.id && n.data.kind === "gatilho") {
                return { ...n, data: { ...n.data, evento: novo, tela: { ...n.data.tela, fonte: novo === "lead.created" ? n.data.tela.fonte : null } } };
              }
              if (n.data.kind === "condicoes") return { ...n, data: { ...n.data, linhas: [] } };
              return n;
            }),
          );
        }}
        onTela={(tela) => selecionado.data.kind === "gatilho" && mudarDados(selecionado.id, { kind: "gatilho", evento: selecionado.data.evento, tela })}
      />
    ) : selecionado.data.kind === "condicoes" ? (
      <PainelDasCondicoes
        dados={selecionado.data}
        evento={evento}
        etapa={etapas.get(selecionado.id)}
        onLinhas={(linhas) => mudarDados(selecionado.id, { kind: "condicoes", linhas })}
      />
    ) : (
      <PainelDaAcao
        acao={selecionado.data.acao}
        problemas={selecionado.data.problemas}
        etapa={etapas.get(selecionado.id)}
        evento={evento}
        onAcao={(acao) => mudarDados(selecionado.id, { kind: "acao", acao })}
      />
    )
  ) : ligacao ? (
    <PainelDaLigacao
      origem={tituloDaCaixa(nos.find((n) => n.id === ligacao.source) ?? { data: { kind: "condicoes", linhas: [] } })}
      destino={tituloDaCaixa(nos.find((n) => n.id === ligacao.target) ?? { data: { kind: "condicoes", linhas: [] } })}
      onExcluir={() => setConfirmarExclusao(true)}
    />
  ) : null;

  return (
    <div
      className="flex h-full min-h-[600px] w-full flex-col"
      onKeyDown={(e) => {
        const alvo = e.target as HTMLElement;
        const digitando = /INPUT|TEXTAREA|SELECT/.test(alvo.tagName) || alvo.isContentEditable;
        if ((e.key === "Delete" || e.key === "Backspace") && !digitando && podeExcluir) {
          e.preventDefault();
          setConfirmarExclusao(true);
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="icon" asChild>
            <Link href={VOLTAR} aria-label={t("Voltar para as automações")}>
              <CaretLeft size={16} aria-hidden />
            </Link>
          </Button>
          <Input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder={t("Boas-vindas a contato novo")}
            maxLength={120}
            aria-label={t("Nome da automação")}
            className="h-8 w-64 max-w-full"
          />
          <Badge variant={regra && ativo ? "success" : "neutral"}>
            {!regra ? t("Ainda não criada") : ativo ? t("Ativa") : t("Pausada")}
          </Badge>
          {sujo ? (
            <Badge variant="warning" data-testid="designer-alteracoes">
              {t("Alterações não salvas")}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => reorganizar(desenho)}>
            <TreeStructure size={14} aria-hidden className="mr-1" />
            {t("Organizar")}
          </Button>
          {podeExcluir ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => setConfirmarExclusao(true)}
              data-testid="designer-excluir"
            >
              <Trash size={14} aria-hidden className="mr-1" />
              {selecionado ? t("Excluir caixa") : t("Excluir ligação")}
            </Button>
          ) : null}
          <Button type="button" size="sm" onClick={() => void salvar()} disabled={salvando} data-testid="designer-salvar">
            {salvando ? t("Salvando…") : regra ? t("Salvar alterações") : t("Criar automação")}
          </Button>
          {regra ? (
            <label className="flex items-center gap-2 text-sm text-text">
              <Switch
                checked={ativo}
                disabled={atualizar.isPending}
                onCheckedChange={alternarAtivo}
                aria-label={ativo ? t("Pausar automação") : t("Ligar automação")}
              />
              {ativo ? t("Ligada") : t("Pausada")}
            </label>
          ) : null}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <PaletaDaAutomacao
          evento={evento}
          temCondicoes={desenho.caixas.some((c) => c.data.kind === "condicoes")}
          onAdd={(tipo) => adicionar(tipo)}
        />
        <Sheet open={paletaAberta} onOpenChange={setPaletaAberta}>
          <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 p-0 lg:hidden">
            <SheetTitle className="sr-only">{t("Adicionar caixa")}</SheetTitle>
            <PaletaDaAutomacao
              variant="mobile"
              evento={evento}
              temCondicoes={desenho.caixas.some((c) => c.data.kind === "condicoes")}
              onAdd={(tipo) => {
                adicionar(tipo);
                setPaletaAberta(false);
              }}
            />
          </SheetContent>
        </Sheet>

        <div
          className="relative h-full flex-1"
          data-testid="designer-canvas"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nosNaTela}
            edges={ligacoesNaTela}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            // Excluir passa pelo nosso caminho, que fecha a fila e nunca tira o gatilho.
            deleteKeyCode={null}
            defaultEdgeOptions={{ type: "smoothstep" }}
            connectionLineType={ConnectionLineType.SmoothStep}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          >
            <Background />
            <Controls />
          </ReactFlow>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="absolute bottom-4 left-4 z-10 shadow-md lg:hidden"
            onClick={() => setPaletaAberta(true)}
          >
            <Plus size={14} aria-hidden /> {t("Adicionar caixa")}
          </Button>
        </div>

        {/* No desktop o painel fica sempre aberto (com o resumo quando nada está
            selecionado); abaixo de `lg` ele vira folha de baixo e só aparece com seleção,
            o mesmo arranjo do construtor de follow-up. */}
        <aside
          className={
            painel
              ? "fixed inset-x-0 bottom-0 z-40 flex max-h-[75vh] flex-col overflow-hidden rounded-t-lg border-t border-border bg-surface shadow-lg lg:static lg:z-auto lg:h-full lg:w-96 lg:max-h-none lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-none"
              : "hidden lg:flex lg:h-full lg:w-96 lg:shrink-0 lg:flex-col lg:border-l lg:border-border lg:bg-surface"
          }
          data-testid="designer-painel"
        >
          {painel ? (
            <div className="flex shrink-0 justify-end p-2 lg:hidden">
              <Button type="button" variant="ghost" size="icon" onClick={onPaneClick} aria-label={t("Fechar")}>
                <X size={16} aria-hidden />
              </Button>
            </div>
          ) : null}
          <div className="flex-1 overflow-y-auto p-4 pt-0 lg:pt-4">
            {painel ?? (
              <ResumoDaAutomacao
                percurso={percurso}
                evento={evento}
                problemasGerais={problemasGerais}
                nova={!regra}
                tituloDaAcao={tituloDaAcao}
              />
            )}
          </div>
        </aside>
      </div>

      <AlertDialog open={confirmarExclusao} onOpenChange={setConfirmarExclusao}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{selecionado ? t("Excluir esta caixa?") : t("Excluir esta ligação?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {selecionado
                ? t("A caixa sai do desenho e a fila se fecha: o que vinha antes passa a ligar no que vinha depois. Nada muda na automação até você salvar.")
                : t("A ligação sai do desenho. Nada muda na automação até você salvar.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setConfirmarExclusao(false);
                excluirSelecao();
              }}
            >
              {t("Excluir")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
