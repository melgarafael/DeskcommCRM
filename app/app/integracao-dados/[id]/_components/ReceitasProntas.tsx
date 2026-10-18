"use client";

import { useId, useMemo, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";

import {
  previewReceita,
  salvarReceitas,
  sugerirCamposACF,
  sugerirCamposJetEngine,
  sugerirCamposTabelaDireta,
  useReceitasDaConexao,
} from "@/hooks/external-db/useReceitasDaConexao";
import { useEtapasParaDestino, useFunisParaDestino } from "@/hooks/external-db/useDestinoDeReceita";
import { randomId } from "@/lib/random-id";
import { useT } from "@/hooks/i18n/useT";
import { RECEITAS, receitaDe } from "@/lib/external-db/receitas/registro";
import type { DestinoDaInstancia, InstanciaDeReceita } from "@/lib/external-db/receitas/tipos";
import type { DefinicaoDeReceita } from "@/lib/external-db/receitas/tipos";

interface Props {
  connectionId: string;
  /** Só mostra para conexão mysql. */
  motor: "mysql" | "postgres";
  /** Só o administrador edita; os demais só leem. */
  canWrite: boolean;
}

const PREFIXO_PADRAO = "wp_";
const PREFIXO_REGEX = /^[A-Za-z0-9_]{1,20}$/;
const POST_TYPE_PADRAO = "imovel";
const POST_TYPE_REGEX = /^[a-z0-9_\-]{1,20}$/;
const BUSCA_PADRAO = { limite: 5 };

const CAMPOS_ACF: { chave: string; rotulo: string }[] = [
  { chave: "preco", rotulo: "Preço" },
  { chave: "quartos", rotulo: "Quartos" },
  { chave: "bairro", rotulo: "Bairro" },
  { chave: "cidade", rotulo: "Cidade" },
  { chave: "area", rotulo: "Área" },
];

const CAMPOS_TABELA_DIRETA: { chave: string; rotulo: string }[] = [
  { chave: "id", rotulo: "Coluna ID" },
  { chave: "titulo", rotulo: "Coluna Título" },
  { chave: "preco", rotulo: "Coluna Preço" },
  { chave: "filtro_numero", rotulo: "Coluna Filtro Numérico" },
];

const CAMPOS_JETENGINE: { chave: string; rotulo: string }[] = [
  { chave: "titulo", rotulo: "Título" },
  { chave: "preco", rotulo: "Preço" },
  { chave: "quartos", rotulo: "Quartos" },
  { chave: "bairro", rotulo: "Bairro" },
  { chave: "cidade", rotulo: "Cidade" },
  { chave: "area", rotulo: "Área" },
];

function fixosPadraoAcf(): InstanciaDeReceita["fixos"] {
  return {
    prefixo: PREFIXO_PADRAO,
    post_type: POST_TYPE_PADRAO,
    campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
  };
}

function fixosPadraoTabelaDireta(): InstanciaDeReceita["fixos"] {
  return {
    tabela: "carros",
    colunas: {
      id: "id",
      titulo: "modelo",
      preco: "preco",
      filtros_texto: ["cor"],
      filtro_numero: "ano",
      exibir: ["cor"],
      status: { coluna: "ativo", valor: "1" },
    },
  };
}

function fixosPadraoJetEngine(): InstanciaDeReceita["fixos"] {
  return {
    prefixo: PREFIXO_PADRAO,
    slug: "imoveis",
    campos: {
      preco: "preco",
      quartos: "quartos",
      bairro: "bairro",
      titulo: "titulo",
      cidade: "cidade",
      area: "area",
    },
  };
}

function receitasDisponiveis(motor: "mysql" | "postgres"): DefinicaoDeReceita[] {
  return [...RECEITAS.values()].filter((r) => r.motores.includes(motor));
}

export default function ReceitasProntas({ connectionId, motor, canWrite }: Props) {
  const t = useT();
  const query = useReceitasDaConexao(connectionId);
  const idInputRotulo = useId();
  const idInputDescricao = useId();
  const idInputPrefixo = useId();
  const idInputPostType = useId();
  const idInputSugerir = useId();
  const idInputAcf = useId();
  const idInputTd = useId();
  const idInputJe = useId();
  const idInputTdId = useId();
  const idInputTdTitulo = useId();
  const idInputTdPreco = useId();
  const idInputTdFiltroNum = useId();
  const idInputJePrefixo = useId();
  const idInputJeSlug = useId();
  const idInputJeTitulo = useId();
  const idInputJePreco = useId();
  const idInputJeQuartos = useId();
  const idInputJeBairro = useId();
  const idInputJeCidade = useId();
  const idInputJeArea = useId();

  // IDs de label para os campos ACF de mapeamento, derivados de um useId base.
  const idsCamposAcf: Record<string, string> = {};
  for (const c of CAMPOS_ACF) {
    idsCamposAcf[c.chave] = `${idInputAcf}-${c.chave}`;
  }

  // Uma linha em edição (rascunho local, ainda não salvo). A lista completa
  // sempre deriva do servidor (query.data) + o rascunho em edição, então
  // acompanha o servidor após cada refetch sem setState síncrono em efeito.
  const [rascunho, setRascunho] = useState<InstanciaDeReceita | null>(null);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    instancia: { id: string; receita: string; rotulo: string };
    colunas: string[];
    linhas: Record<string, unknown>[];
    linhas_devolvidas: number;
    truncado?: boolean;
  } | null>(null);
  const [previewando, setPreviewando] = useState(false);
  const [sugerindo, setSugerindo] = useState(false);
  const [sugerindoTabelaDireta, setSugerindoTabelaDireta] = useState(false);
  const [sugerindoJetEngine, setSugerindoJetEngine] = useState(false);

  const lista = useMemo(() => {
    const base = [...(query.data?.receitas ?? [])];
    if (rascunho) {
      const idx = base.findIndex((i) => i.id === rascunho.id);
      if (idx >= 0) base[idx] = rascunho;
      else base.push(rascunho);
    }
    return base;
  }, [query.data, rascunho]);

  const receitas = lista;
  const jaCadastradas = new Set(receitas.map((r) => r.receita));
  const opcoes = receitasDisponiveis(motor).filter((r) => !jaCadastradas.has(r.id));

  const salvar = async () => {
    if (!canWrite) return;
    try {
      await salvarReceitas(connectionId, lista);
      toast.success(t("Salvo."));
      setRascunho(null);
      await query.refetch();
    } catch (err) {
      showApiError(err);
    }
  };

  const adicionar = () => {
    if (!canWrite) return;
    const primeira = opcoes[0];
    if (!primeira) return;
    const receita = receitaDe(primeira.id);
    const nova: InstanciaDeReceita = {
      id: randomId(),
      receita: primeira.id,
      rotulo: receita?.rotulo ?? primeira.id,
      descricao: receita?.descricao ?? "",
      fixos:
        primeira.id === "acf-imoveis"
          ? fixosPadraoAcf()
          : primeira.id === "tabela-direta"
          ? fixosPadraoTabelaDireta()
          : primeira.id === "jetengine-imoveis"
          ? fixosPadraoJetEngine()
          : { prefixo: PREFIXO_PADRAO },
      ativa: true,
    };
    setRascunho(nova);
  };

  const editar = (inst: InstanciaDeReceita) => {
    if (!canWrite) return;
    setRascunho(inst);
  };

  const remover = async (id: string) => {
    if (!canWrite) return;
    setConfirmandoRemocao(id);
  };

  const confirmarRemocao = async () => {
    if (!confirmandoRemocao) return;
    const prox = lista.filter((i) => i.id !== confirmandoRemocao);
    setConfirmandoRemocao(null);
    try {
      await salvarReceitas(connectionId, prox);
      await query.refetch();
    } catch (err) {
      showApiError(err);
    }
  };

  const cancelarRemocao = () => {
    setConfirmandoRemocao(null);
  };

  const executarPreview = async (inst: InstanciaDeReceita) => {
    if (!canWrite) return;
    setPreviewando(true);
    try {
      const resultado = await previewReceita(connectionId, inst.id, BUSCA_PADRAO);
      setPreview(resultado);
    } catch (err) {
      showApiError(err);
      setPreview(null);
    } finally {
      setPreviewando(false);
    }
  };

  /** Chama a rota de sugestão e preenche os campos vazios, sem sobrescrever o já digitado. */
  const sugerirCampos = async () => {
    if (!canWrite || !rascunho) return;
    const fixos = rascunho.fixos as {
      prefixo?: string;
      post_type?: string;
      campos?: Record<string, string>;
    };
    if (!fixos.prefixo || !fixos.post_type) {
      toast.error(t("Preencha o prefixo e o tipo de post antes de sugerir."));
      return;
    }
    setSugerindo(true);
    try {
      const sugerido = await sugerirCamposACF(connectionId, fixos.prefixo, fixos.post_type);
      const mapeamento = sugerido.mapeamento_sugerido as Record<string, string | null>;
      const camposAtuais = { ...(fixos.campos ?? {}) };
      for (const [campo, metaKey] of Object.entries(mapeamento)) {
        // Não sobrescreve o que o admin já digitou.
        if (metaKey && !camposAtuais[campo]) {
          camposAtuais[campo] = metaKey;
        }
      }
      const prox: InstanciaDeReceita = {
        ...rascunho,
        fixos: { ...fixos, campos: camposAtuais },
      };
      setRascunho(prox);
      if (sugerido.aviso) {
        toast.warning(sugerido.aviso);
      } else {
        toast.success(t("Campos sugeridos preenchidos."));
      }
    } catch (err) {
      showApiError(err);
    } finally {
      setSugerindo(false);
    }
  };

  /** Sugere colunas para a tabela-direta, sem sobrescrever o já digitado. */
  const sugerirCamposTabelaDiretaHandler = async () => {
    if (!canWrite || !rascunho) return;
    const fixos = rascunho.fixos as { tabela?: string };
    if (!fixos.tabela) {
      toast.error(t("Preencha a tabela antes de sugerir."));
      return;
    }
    setSugerindoTabelaDireta(true);
    try {
      const sugerido = await sugerirCamposTabelaDireta(connectionId, fixos.tabela);
      const mapeamento = sugerido.mapeamento_sugerido as Record<string, string | null>;
      const colunasAtuais = { ...(rascunho.fixos as { colunas?: Record<string, string> }).colunas ?? {} };
      for (const [campo, valor] of Object.entries(mapeamento)) {
        if (valor && !colunasAtuais[campo]) {
          colunasAtuais[campo] = valor;
        }
      }
      const prox: InstanciaDeReceita = {
        ...rascunho,
        fixos: { ...(rascunho.fixos as Record<string, unknown>), colunas: colunasAtuais },
      };
      setRascunho(prox);
      if (sugerido.aviso) {
        toast.warning(sugerido.aviso);
      } else {
        toast.success(t("Campos sugeridos preenchidos."));
      }
    } catch (err) {
      showApiError(err);
    } finally {
      setSugerindoTabelaDireta(false);
    }
  };

  /** Sugere CCTs do JetEngine, sem sobrescrever o já digitado. */
  const sugerirCamposJetEngineHandler = async () => {
    if (!canWrite || !rascunho) return;
    const fixos = rascunho.fixos as { prefixo?: string };
    if (!fixos.prefixo) {
      toast.error(t("Preencha o prefixo antes de sugerir."));
      return;
    }
    setSugerindoJetEngine(true);
    try {
      const sugerido = await sugerirCamposJetEngine(connectionId, fixos.prefixo);
      const slugAtual = (rascunho.fixos as { slug?: string }).slug;
      const cct =
        sugerido.ccts.find((c) => c.tabela === `${fixos.prefixo}jet_cct_${slugAtual}`) ??
        sugerido.ccts[0];
      if (cct) {
        const mapeamento = cct.mapeamento as Record<string, string | null>;
        // A receita guarda o mapa em "campos" (não "colunas", que é da tabela-direta).
        const camposAtuais = { ...((rascunho.fixos as { campos?: Record<string, string> }).campos ?? {}) };
        for (const [campo, valor] of Object.entries(mapeamento)) {
          if (valor && !camposAtuais[campo]) {
            camposAtuais[campo] = valor;
          }
        }
        const prox: InstanciaDeReceita = {
          ...rascunho,
          fixos: { ...(rascunho.fixos as Record<string, unknown>), campos: camposAtuais },
        };
        setRascunho(prox);
        toast.success(t("Campos sugeridos preenchidos."));
      } else {
        toast.warning(t("Nenhum CCT JetEngine encontrado para este prefixo."));
      }
    } catch (err) {
      showApiError(err);
    } finally {
      setSugerindoJetEngine(false);
    }
  };

  if (motor !== "mysql") return null;
  if (opcoes.length === 0 && receitas.length === 0) return null;

  // Query falhou: nunca fica em silêncio (Living System, item 1). Mostra mensagem
  // legível com botão para tentar de novo.
  if (query.isError) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("Não foi possível carregar as receitas.")}{" "}
        <Button size="sm" onClick={() => query.refetch()}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  return (
    <Card className="border border-border">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm font-semibold">{t("Receitas prontas")}</CardTitle>
        {canWrite && opcoes.length > 0 && (
          <Button size="sm" onClick={adicionar}>
            {t("Adicionar receita")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!query.data && (
          <p className="text-sm text-muted-foreground">{t("Carregando receitas…")}</p>
        )}
        {query.data && receitas.length === 0 && canWrite && (
          <p className="text-sm text-muted-foreground">
            {t(
              "Nenhuma receita cadastrada ainda. Adicione uma para o assistente consultar o banco de origem.",
            )}
          </p>
        )}

        {receitas.map((inst) => {
          const receita = receitaDe(inst.receita);
          const editandoEsta = rascunho?.id === inst.id;
          const fixos = inst.fixos as Record<string, unknown>;
          const cols = (fixos.prefixo as string | undefined) ?? PREFIXO_PADRAO;

          if (editandoEsta && canWrite) {
            const ehAcf = receita?.id === "acf-imoveis";
            const ehTabelaDireta = receita?.id === "tabela-direta";
            const ehJetEngine = receita?.id === "jetengine-imoveis";
            return (
              <Card key={inst.id} className="mb-2 border border-border p-3">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                  <div className="col-span-1 md:col-span-2">
                    <Label htmlFor={idInputRotulo} className="text-xs text-muted-foreground">
                      {t("Rótulo")}
                    </Label>
                    <Input
                      id={idInputRotulo}
                      value={inst.rotulo}
                      onChange={(e) => {
                        const prox = { ...inst, rotulo: e.target.value };
                        setRascunho(prox);
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor={idInputDescricao} className="text-xs text-muted-foreground">
                      {t("Descrição")}
                    </Label>
                    <Input
                      id={idInputDescricao}
                      value={inst.descricao}
                      onChange={(e) => {
                        const prox = { ...inst, descricao: e.target.value };
                        setRascunho(prox);
                      }}
                    />
                  </div>
                  {!ehTabelaDireta && (
                  <div>
                    <Label htmlFor={idInputPrefixo} className="text-xs text-muted-foreground">
                      {t("Prefixo das tabelas")}
                    </Label>
                    <Input
                      id={idInputPrefixo}
                      value={cols}
                      onChange={(e) => {
                        const valor = e.target.value;
                        if (!PREFIXO_REGEX.test(valor)) return;
                        const prox = { ...inst, fixos: { ...(fixos as Record<string, unknown>), prefixo: valor } };
                        setRascunho(prox);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("O prefixo aparece antes de _posts no banco do WordPress (padrão wp_).")}
                    </p>
                  </div>
                  )}
                  {ehAcf && (
                    <div>
                      <Label htmlFor={idInputPostType} className="text-xs text-muted-foreground">
                        {t("Tipo de post")}
                      </Label>
                      <Input
                        id={idInputPostType}
                        value={(fixos.post_type as string | undefined) ?? POST_TYPE_PADRAO}
                        onChange={(e) => {
                          const valor = e.target.value;
                          if (!POST_TYPE_REGEX.test(valor)) return;
                          const prox = { ...inst, fixos: { ...(fixos as Record<string, unknown>), post_type: valor } };
                          setRascunho(prox);
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("Qual tipo de post do WordPress (padrão imovel).")}
                      </p>
                    </div>
                  )}
                  <div className="col-span-1 flex items-end md:col-span-1">
                    <Switch
                      checked={inst.ativa}
                      onCheckedChange={(ativa) => {
                        const prox = { ...inst, ativa };
                        setRascunho(prox);
                      }}
                    />
                    <Label className="ml-2 text-xs text-muted-foreground">{t("Ativa")}</Label>
                  </div>
                </div>

                <div className="mt-2 border-t pt-3">
                  <DestinoDaInstancia
                    destino={inst.destino}
                    editavel
                    onChange={(destino) => {
                      const { destino: _antigo, ...resto } = inst;
                      void _antigo;
                      setRascunho(destino ? { ...resto, destino } : resto);
                    }}
                  />
                </div>

                {ehAcf && (
                  <div className="mt-2 border-t pt-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      {t("Mapeamento de campos (meta_key)")}
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {CAMPOS_ACF.map((c) => {
                        const idInput = idsCamposAcf[c.chave];
                        const valorAtual = ((fixos.campos as Record<string, string> | undefined)?.[c.chave] ?? "");
                        const obrigatorio = c.chave !== "cidade" && c.chave !== "area";
                        return (
                          <div key={c.chave} className="col-span-1">
                            <Label
                              htmlFor={idInput}
                              className={`text-xs text-muted-foreground ${obrigatorio ? "font-medium" : ""}`}
                            >
                              {t(c.rotulo)}
                              {obrigatorio ? " *" : ""}
                            </Label>
                            <Input
                              id={idInput}
                              value={valorAtual}
                              onChange={(e) => {
                                const valor = e.target.value;
                                if (!/^[A-Za-z0-9_\-]{1,64}$/.test(valor) && valor !== "") return;
                                const proxCampos = { ...((fixos.campos as Record<string, string> | undefined) ?? {}), [c.chave]: valor };
                                const prox = { ...inst, fixos: { ...(fixos as Record<string, unknown>), campos: proxCampos } };
                                setRascunho(prox);
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2 flex items-end gap-2">
                      <Button
                        size="sm"
                        onClick={sugerirCampos}
                        disabled={sugerindo}
                        id={idInputSugerir}
                      >
                        {sugerindo ? t("Sugerindo…") : t("Sugerir campos")}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        {t("Preenche só os campos ainda vazios; a palavra final é sua.")}
                      </p>
                    </div>
                  </div>
                )}

                {ehTabelaDireta && (
                  <div className="mt-2 border-t pt-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      {t("Tabela e colunas")}
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="col-span-1">
                        <Label htmlFor={`${idInputTd}-tabela`} className="text-xs text-muted-foreground font-medium">
                          {t("Tabela")}
                        </Label>
                        <Input
                          id={`${idInputTd}-tabela`}
                          value={(fixos.tabela as string | undefined) ?? ""}
                          onChange={(e) => {
                            const valor = e.target.value;
                            if (!/^[A-Za-z0-9_]{1,64}$/.test(valor)) return;
                            setRascunho({ ...inst, fixos: { ...fixos, tabela: valor } });
                          }}
                        />
                      </div>
                      {CAMPOS_TABELA_DIRETA.map((c) => (
                        <div key={c.chave} className="col-span-1">
                          <Label htmlFor={`${idInputTd}-${c.chave}`} className="text-xs text-muted-foreground font-medium">
                            {t(c.rotulo)}
                          </Label>
                          <Input
                            id={`${idInputTd}-${c.chave}`}
                            value={(fixos.colunas as Record<string, string> | undefined)?.[c.chave] ?? ""}
                            onChange={(e) => {
                              const valor = e.target.value;
                              if (!/^[A-Za-z0-9_]{1,64}$/.test(valor)) return;
                              setRascunho({
                                ...inst,
                                fixos: { ...fixos, colunas: { ...(fixos.colunas as object), [c.chave]: valor } },
                              });
                            }}
                          />
                        </div>
                      ))}
                      <div className="col-span-1">
                        <Label htmlFor={`${idInputTd}-imagem`} className="text-xs text-muted-foreground font-medium">
                          {t("Coluna da foto")}
                        </Label>
                        <Input
                          id={`${idInputTd}-imagem`}
                          aria-describedby={`${idInputTd}-imagem-dica`}
                          value={(fixos.colunas as Record<string, string> | undefined)?.imagem ?? ""}
                          onChange={(e) => {
                            const valor = e.target.value;
                            if (valor !== "" && !/^[A-Za-z0-9_]{1,64}$/.test(valor)) return;
                            const proxColunas = { ...((fixos.colunas as Record<string, unknown> | undefined) ?? {}) };
                            // Campo opcional: vazio remove a chave (o servidor recusa string vazia).
                            if (valor === "") delete proxColunas.imagem;
                            else proxColunas.imagem = valor;
                            setRascunho({ ...inst, fixos: { ...fixos, colunas: proxColunas } });
                          }}
                        />
                        <p id={`${idInputTd}-imagem-dica`} className="mt-1 text-xs text-muted-foreground">
                          {t("Opcional: coluna com o endereço (URL) da imagem.")}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 flex items-end gap-2">
                      <Button
                        size="sm"
                        onClick={sugerirCamposTabelaDiretaHandler}
                        disabled={sugerindoTabelaDireta}
                      >
                        {sugerindoTabelaDireta ? t("Sugerindo…") : t("Sugerir campos")}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        {t("Preenche só os campos ainda vazios; a palavra final é sua.")}
                      </p>
                    </div>
                  </div>
                )}

                {ehJetEngine && (
                  <div className="mt-2 border-t pt-3">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="col-span-1">
                        <Label htmlFor={`${idInputJe}-slug`} className="text-xs text-muted-foreground font-medium">
                          {t("Slug do CCT")}
                        </Label>
                        <Input
                          id={`${idInputJe}-slug`}
                          value={(fixos.slug as string | undefined) ?? ""}
                          onChange={(e) => {
                            const valor = e.target.value;
                            if (valor !== "" && !/^[a-z0-9_-]{1,40}$/.test(valor)) return;
                            setRascunho({ ...inst, fixos: { ...fixos, slug: valor } });
                          }}
                        />
                      </div>
                    </div>
                    <div className="mt-2 border-t pt-3">
                      <p className="mb-2 text-xs font-medium text-muted-foreground">
                        {t("Mapeamento de campos (coluna do CCT)")}
                      </p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {CAMPOS_JETENGINE.map((c) => (
                          <div key={c.chave} className="col-span-1">
                            <Label htmlFor={`${idInputJe}-${c.chave}`} className="text-xs text-muted-foreground font-medium">
                              {t(c.rotulo)}
                            </Label>
                            <Input
                              id={`${idInputJe}-${c.chave}`}
                              value={(fixos.campos as Record<string, string> | undefined)?.[c.chave] ?? ""}
                              onChange={(e) => {
                                const valor = e.target.value;
                                if (valor !== "" && !/^[A-Za-z0-9_]{1,64}$/.test(valor)) return;
                                const proxCampos = { ...((fixos.campos as Record<string, string> | undefined) ?? {}) };
                                // Campo vazio sai do mapa: o servidor recusa string vazia.
                                if (valor === "") delete proxCampos[c.chave];
                                else proxCampos[c.chave] = valor;
                                setRascunho({ ...inst, fixos: { ...fixos, campos: proxCampos } });
                              }}
                            />
                          </div>
                        ))}
                        <div className="col-span-1">
                          <Label htmlFor={`${idInputJe}-imagem`} className="text-xs text-muted-foreground font-medium">
                            {t("Campo da foto")}
                          </Label>
                          <Input
                            id={`${idInputJe}-imagem`}
                            aria-describedby={`${idInputJe}-imagem-dica`}
                            value={(fixos.campos as Record<string, string> | undefined)?.imagem ?? ""}
                            onChange={(e) => {
                              const valor = e.target.value;
                              if (valor !== "" && !/^[A-Za-z0-9_]{1,64}$/.test(valor)) return;
                              const proxCampos = { ...((fixos.campos as Record<string, string> | undefined) ?? {}) };
                              if (valor === "") delete proxCampos.imagem;
                              else proxCampos.imagem = valor;
                              setRascunho({ ...inst, fixos: { ...fixos, campos: proxCampos } });
                            }}
                          />
                          <p id={`${idInputJe}-imagem-dica`} className="mt-1 text-xs text-muted-foreground">
                            {t("Opcional: URL da imagem ou ID do anexo do WordPress.")}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 flex items-end gap-2">
                        <Button
                          size="sm"
                          onClick={sugerirCamposJetEngineHandler}
                          disabled={sugerindoJetEngine}
                        >
                          {sugerindoJetEngine ? t("Sugerindo…") : t("Sugerir campos")}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                          {t("Preenche só os campos ainda vazios; a palavra final é sua.")}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={salvar}>
                    {t("Salvar")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRascunho(null)}>
                    {t("Cancelar")}
                  </Button>
                  <Button size="sm" onClick={() => executarPreview(inst)} disabled={previewando}>
                    {previewando ? t("Pré-visualizando…") : t("Pré-visualizar")}
                  </Button>
                  {canWrite && (
                    <>
                      {confirmandoRemocao === inst.id ? (
                        <>
                          <Button size="sm" variant="outline" onClick={confirmarRemocao}>
                            {t("Sim")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={cancelarRemocao}>
                            {t("Não")}
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="destructive" onClick={() => remover(inst.id)}>
                          {t("Remover")}
                        </Button>
                      )}
                    </>
                  )}
                </div>
                {preview && preview.instancia.id === inst.id && (
                  <div className="mt-3 border-t pt-2">
                    <p className="mb-1 text-xs text-muted-foreground">
                      {t("Pré-visualização (até 5 linhas)")} — {preview.linhas_devolvidas}{" "}
                      {t("linhas")}
                      {preview.truncado ? ` · ${t("truncado")}` : ""}
                    </p>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {preview.colunas.map((c) => (
                              <TableCell key={c} className="text-xs font-medium">
                                {c}
                              </TableCell>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {preview.linhas.map((linha, i) => (
                            <TableRow key={i}>
                              {preview.colunas.map((c) => (
                                <TableCell key={c} className="text-xs">
                                  {String(linha[c] ?? "")}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </Card>
            );
          }

          return (
            <Card key={inst.id} className="mb-2 border border-border p-3">
              <div className="flex flex-row items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {inst.rotulo || (receita?.rotulo ?? inst.receita)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {inst.descricao || (receita?.descricao ?? "")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("Prefixo:")} <span className="font-mono">{cols}</span>
                  </p>
                  <DestinoDaInstancia destino={inst.destino} editavel={false} podeLerFunis={canWrite} />
                  {ehAcfInstance(receita) && (
                    <p className="text-xs text-muted-foreground">
                      {t("Tipo de post:")}{" "}
                      <span className="font-mono">{((fixos.post_type as string | undefined) ?? POST_TYPE_PADRAO)}</span>
                    </p>
                  )}
                </div>
                <div className="flex gap-1">
                  <Badge variant={inst.ativa ? "success" : "secondary"}>
                    {inst.ativa ? t("Ativa") : t("Inativa")}
                  </Badge>
                  {canWrite && (
                    <Button size="sm" variant="outline" onClick={() => editar(inst)}>
                      {t("Editar")}
                    </Button>
                  )}
                  {canWrite && (
                    <Button size="sm" onClick={() => executarPreview(inst)} disabled={previewando}>
                      {previewando ? t("Pré-visualizando…") : t("Pré-visualizar")}
                    </Button>
                  )}
                  {canWrite && (
                    <>
                      {confirmandoRemocao === inst.id ? (
                        <>
                          <Button size="sm" variant="outline" onClick={confirmarRemocao}>
                            {t("Sim")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={cancelarRemocao}>
                            {t("Não")}
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="destructive" onClick={() => remover(inst.id)}>
                          {t("Remover")}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {preview && preview.instancia.id === inst.id && (
                <div className="mt-3 border-t pt-2">
                  <p className="mb-1 text-xs text-muted-foreground">
                    {t("Pré-visualização (até 5 linhas)")} — {preview.linhas_devolvidas}{" "}
                    {t("linhas")}
                    {preview.truncado ? ` · ${t("truncado")}` : ""}
                  </p>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {preview.colunas.map((c) => (
                            <TableCell key={c} className="text-xs font-medium">
                              {c}
                            </TableCell>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.linhas.map((linha, i) => (
                          <TableRow key={i}>
                            {preview.colunas.map((c) => (
                              <TableCell key={c} className="text-xs">
                                {String(linha[c] ?? "")}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ehAcfInstance(receita: DefinicaoDeReceita | undefined): boolean {
  return receita?.id === "acf-imoveis";
}

interface DestinoProps {
  destino: DestinoDaInstancia | undefined;
  editavel: boolean;
  /** No cartão: só quem pode ler os funis (gestor+) vê os nomes. */
  podeLerFunis?: boolean;
  onChange?: (destino: DestinoDaInstancia | undefined) => void;
}

/**
 * O funil e a etapa onde nasce o lead quando o cliente se interessa por um item
 * (Spec 25 R5 / D6). No cartão mostra o destino ou o aviso de que não há; na edição
 * deixa escolher entre os funis e etapas DA ORGANIZAÇÃO (o servidor confere de novo).
 */
function DestinoDaInstancia({ destino, editavel, podeLerFunis = true, onChange }: DestinoProps) {
  const t = useT();
  const idFunil = useId();
  const idEtapa = useId();
  const [funilEscolhido, setFunilEscolhido] = useState<string>(destino?.pipeline_id ?? "");
  const funis = useFunisParaDestino(editavel || (podeLerFunis && !!destino));
  const pipelineId = editavel ? funilEscolhido || null : (destino?.pipeline_id ?? null);
  const etapas = useEtapasParaDestino(pipelineId, editavel || (podeLerFunis && !!destino));

  if (!editavel) {
    if (!destino) {
      return (
        <p className="text-xs text-muted-foreground">
          {t("Sem funil de destino: interesse vira aviso na Central")}
        </p>
      );
    }
    const nomeFunil = funis.data?.find((f) => f.id === destino.pipeline_id)?.name;
    const nomeEtapa = etapas.data?.find((e) => e.id === destino.stage_id)?.name;
    return (
      <p className="text-xs text-muted-foreground">
        {t("Leads vão para:")}{" "}
        <span className="font-medium">
          {nomeFunil && nomeEtapa ? `${nomeFunil} › ${nomeEtapa}` : t("o funil configurado")}
        </span>
      </p>
    );
  }

  if (funis.isError) {
    return <p className="text-xs text-muted-foreground">{t("Não foi possível carregar os funis.")}</p>;
  }
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">{t("Funil de destino")}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <Label htmlFor={idFunil} className="text-xs text-muted-foreground">
            {t("Funil")}
          </Label>
          <select
            id={idFunil}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={funilEscolhido}
            onChange={(e) => {
              setFunilEscolhido(e.target.value);
              onChange?.(undefined);
            }}
          >
            <option value="">{t("Sem funil de destino")}</option>
            {(funis.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor={idEtapa} className="text-xs text-muted-foreground">
            {t("Etapa de destino")}
          </Label>
          <select
            id={idEtapa}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            disabled={!funilEscolhido}
            value={destino?.stage_id ?? ""}
            onChange={(e) => {
              if (!funilEscolhido || !e.target.value) return onChange?.(undefined);
              onChange?.({ pipeline_id: funilEscolhido, stage_id: e.target.value });
            }}
          >
            <option value="">{t("Escolha a etapa")}</option>
            {(etapas.data ?? [])
              .filter((e) => !e.is_won && !e.is_lost)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("Quando o cliente demonstra interesse em um item, o lead nasce neste funil e etapa.")}
      </p>
    </div>
  );
}
