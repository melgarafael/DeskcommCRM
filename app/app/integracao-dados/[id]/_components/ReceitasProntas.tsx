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

import { previewReceita, salvarReceitas, useReceitasDaConexao } from "@/hooks/external-db/useReceitasDaConexao";
import { randomId } from "@/lib/random-id";
import { ApiError } from "@/lib/api/types";
import { useT } from "@/hooks/i18n/useT";
import { RECEITAS, receitaDe } from "@/lib/external-db/receitas/registro";
import {
  chaveDoRotulo,
  chaveUnica,
  MAX_CAMPOS_WORDPRESS,
  MAX_CATEGORIAS_WORDPRESS,
  type CategoriaMapeada,
  type CampoMapeado,
  type FiltroDeCampo,
  type FiltroDeCategoria,
  type TipoDeCampo,
} from "@/lib/external-db/receitas/wordpress-conteudo";
// O NÍVEL do termo (qualquer/filho/raiz) mora no módulo da taxonomia: é a
// hierarquia do WordPress, e não sai pela receita.
import type { NivelDaTaxonomia } from "@/lib/external-db/receitas/taxonomia";
import {
  MODELOS_WORDPRESS,
  categoriasDoModelo,
  camposDoModelo,
  modeloDe,
} from "@/lib/external-db/receitas/modelos-wordpress";
import type { InstanciaDeReceita } from "@/lib/external-db/receitas/tipos";
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
const BUSCA_PADRAO = { limite: 5 };

/** O id da receita genérica de WordPress (a que a tela monta campo a campo). */
const RECEITA_WORDPRESS = "wordpress-conteudo";

/** A regex do `meta_key`: mesma da receita, aqui para o campo da tela. */
const META_KEY_REGEX = /^[A-Za-z0-9_\-]{1,64}$/;

/** A regex do slug da taxonomia: mesma da receita, aqui para o campo da tela. */
const TAXONOMIA_REGEX = /^[a-z0-9_-]{1,32}$/;

/** A regex do tipo de post: mesma da receita. */
const POST_TYPE_REGEX = /^[a-z0-9_\-]{1,20}$/;

/** A regex da chave do dado: mesma da receita. */
const CHAVE_REGEX = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * O que a tela está editando do conteúdo do WordPress.
 *
 * O editor é a FONTE da verdade enquanto a edição está aberta: os "fixos" que
 * vão para o banco são DERIVADOS dele. Isso resolve o caso em que a pessoa
 * escreve o rótulo e ainda não digitou o nome do campo no site — a chave
 * vazia seria recusada pelo servidor, e o texto meio escrito se perderia a
 * cada tecla.
 */
interface CampoEditado {
  /** O nome do dado na saída. Vem do rótulo, mas a pessoa pode editar. */
  chave: string;
  /** A pessoa editou a chave na mão: o rótulo não pode mais mudá-la. */
  chaveManual: boolean;
  rotulo: string;
  meta_key: string;
  tipo: TipoDeCampo;
  filtro: FiltroDeCampo;
}

interface CategoriaEditada {
  chave: string;
  chaveManual: boolean;
  rotulo: string;
  taxonomia: string;
  nivel: NivelDaTaxonomia;
  filtro: FiltroDeCategoria;
}

interface EditorDoWordpress {
  campos: CampoEditado[];
  categorias: CategoriaEditada[];
  /** O campo do site que esconde o conteúdo. */
  esconderCampo: string;
  /** Os valores a esconder, separados por vírgula. */
  esconderValores: string;
}

/** Os valores a esconder, já separados e limpos. */
function valoresOcultos(texto: string): string[] {
  return texto
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .slice(0, 10);
}

/**
 * Os "fixos" que a tela grava, DERIVADOS do editor.
 *
 * Regras: campo apagado = chave removida (nunca vazio, que o servidor recusa);
 * categoria escolhida mas sem nome = ainda não mapeada; e o que esconder sem
 * valor = não escondido.
 */
function fixosDoEditor(
  editor: EditorDoWordpress,
  prefixo: string,
  postType: string,
): Record<string, unknown> {
  const campos: CampoMapeado[] = editor.campos.map((c) => ({
    chave: c.chave,
    rotulo: c.rotulo.trim(),
    meta_key: c.meta_key.trim(),
    tipo: c.tipo,
    filtro: c.filtro,
  }));
  const categorias: CategoriaMapeada[] = editor.categorias.map((c) => ({
    chave: c.chave,
    rotulo: c.rotulo.trim(),
    taxonomia: c.taxonomia.trim(),
    nivel: c.nivel,
    filtro: c.filtro,
  }));

  const fixos: Record<string, unknown> = { prefixo, post_type: postType, campos, categorias };

  const metaKey = editor.esconderCampo.trim();
  const valores = valoresOcultos(editor.esconderValores);
  if (metaKey.length > 0 && valores.length > 0) {
    fixos.esconder = { meta_key: metaKey, valores };
  }

  return fixos;
}

/** O editor a partir dos "fixos" gravados (o que a pessoa tinha salvo). */
function editorDoWordpress(fixos: unknown): EditorDoWordpress {
  const f = (fixos ?? {}) as {
    campos?: CampoMapeado[];
    categorias?: CategoriaMapeada[];
    esconder?: { meta_key?: string; valores?: string[] };
  };
  return {
    campos: (f.campos ?? []).map((c) => ({ ...c, chaveManual: true })),
    categorias: (f.categorias ?? []).map((c) => ({ ...c, chaveManual: true })),
    esconderCampo: f.esconder?.meta_key ?? "",
    esconderValores: (f.esconder?.valores ?? []).join(", "),
  };
}

/** O editor de uma instância nova: uma linha de campo para a pessoa preencher. */
function editorPadraoWordpress(): EditorDoWordpress {
  return {
    campos: [
      { chave: "", chaveManual: false, rotulo: "", meta_key: "", tipo: "texto", filtro: "nenhum" },
    ],
    categorias: [],
    esconderCampo: "",
    esconderValores: "",
  };
}

/**
 * O filtro que ainda cabe no tipo escolhido.
 *
 * "Contém" é de texto; "mínimo" e "máximo" são de número. Trocar o tipo
 * limpa o filtro que não cabe mais — senão a tela ofereceria um filtro que o
 * servidor recusa.
 */
function filtroQueCabe(tipo: TipoDeCampo, filtro: FiltroDeCampo): FiltroDeCampo {
  if (filtro === "nenhum") return "nenhum";
  if (tipo === "texto") return filtro === "contem" ? "contem" : "nenhum";
  return filtro === "contem" ? "nenhum" : filtro;
}

/**
 * A tela já tem coisa preenchida? (para pedir confirmação antes de trocar)
 *
 * O TIPO DE POST conta como conteúdo: o modelo "Imóveis" traz o tipo dele, e
 * aplicá-lo troca o tipo que a pessoa digitou. Sem esta conta, o modelo
 * trocava o tipo de post em silêncio — e o site que o tipo não era o do modelo
 * parava de responder.
 */
function temConteudo(editor: EditorDoWordpress | null, postType: string): boolean {
  if (!editor) return false;
  return (
    postType.trim().length > 0 ||
    editor.campos.some((c) => c.rotulo.trim().length > 0 || c.meta_key.trim().length > 0) ||
    editor.categorias.some((c) => c.rotulo.trim().length > 0 || c.taxonomia.trim().length > 0) ||
    editor.esconderCampo.trim().length > 0 ||
    editor.esconderValores.trim().length > 0
  );
}

/**
 * O que impede a gravação, em português de leigo.
 *
 * A tela impede aqui o que o servidor recusaria em 422: é mais honesto dizer
 * "preencha o rótulo" do que devolver um erro de validação depois do clique.
 * A frase é ESTÁTICA (uma chave de dicionário), nunca montada em runtime.
 * Recebe `t` para devolver a frase JÁ traduzida no idioma da tela.
 */
function problemaDoEditor(
  t: (texto: string) => string,
  editor: EditorDoWordpress | null,
  postType: string,
): string | null {
  if (!editor) return null;
  if (postType.trim().length === 0) return t("Escreva o tipo de post do site.");
  if (editor.campos.length === 0) return t("Mapeie pelo menos um campo do site.");
  for (const campo of editor.campos) {
    if (campo.rotulo.trim().length === 0 || campo.meta_key.trim().length === 0) {
      return t("Preencha o rótulo e o nome do campo de todos os dados.");
    }
    // O rótulo que não vira chave (só símbolos) deixaria o dado sem nome na
    // saída — e o servidor recusaria com um erro de validação que a pessoa
    // não entende. A tela recusa antes, dizendo o que escrever.
    if (campo.chave.trim().length === 0) {
      return t(
        "Um dos rótulos não virou uma chave. Escreva o rótulo com letras ou números.",
      );
    }
  }
  for (const categoria of editor.categorias) {
    if (categoria.rotulo.trim().length === 0 || categoria.taxonomia.trim().length === 0) {
      return t("Preencha o rótulo e o nome da categoria de todos os dados.");
    }
    if (categoria.chave.trim().length === 0) {
      return t(
        "Um dos rótulos não virou uma chave. Escreva o rótulo com letras ou números.",
      );
    }
  }
  return null;
}

function receitasDisponiveis(motor: "mysql" | "postgres"): DefinicaoDeReceita[] {
  return [...RECEITAS.values()].filter((r) => r.motores.includes(motor));
}

/**
 * O rótulo de cada caminho de erro do Zod, no idioma da tela.
 *
 * A chave é o CAMINHO do campo que falhou — "campos", "esconder.meta_key",
 * "campos.1.chave" —, e a tela procura primeiro o caminho inteiro, depois o
 * primeiro pedaço ("campos") e por último o ÚLTIMO ("chave"): com o pedaço
 * sozinho, "meta_key" e "valores" viravam o mesmo rótulo, e ninguém sabia o
 * que corrigir.
 */
function rotulosDoErro(t: (texto: string) => string): Record<string, string> {
  return {
    // A instância.
    descricao: t("Descrição"),
    rotulo: t("Nome da receita"),
    // Os "fixos" da receita.
    prefixo: t("Prefixo das tabelas"),
    post_type: t("Tipo de post"),
    campos: t("Campos do site"),
    categorias: t("Categorias do site"),
    esconder: t("Esconder itens"),
    "esconder.meta_key": t("Campo a esconder"),
    "esconder.valores": t("Valores a esconder"),
    // Os últimos pedaços de um caminho com índice ("campos.1.chave").
    chave: t("Chave"),
    filtro: t("Filtro"),
    meta_key: t("Campo no site"),
    taxonomia: t("Categoria no site"),
    nivel: t("Nível"),
    tipo: t("Tipo"),
  };
}

/** O rótulo legível de um caminho de erro, do mais específico ao mais geral. */
function rotuloDoCaminho(rotulos: Record<string, string>, caminho: string): string {
  const partes = caminho.split(".");
  return (
    rotulos[caminho] ??
    rotulos[partes[0] ?? caminho] ??
    rotulos[partes[partes.length - 1] ?? caminho] ??
    caminho
  );
}

export default function ReceitasProntas({ connectionId, motor, canWrite }: Props) {
  const t = useT();
  const query = useReceitasDaConexao(connectionId);
  const idInputRotulo = useId();
  const idInputDescricao = useId();
  const idInputPrefixo = useId();
  const idInputPostType = useId();
  const idInputWordpress = useId();

  // Uma linha em edição (rascunho local, ainda não salvo). A lista completa
  // sempre deriva do servidor (query.data) + o rascunho em edição, então
  // acompanha o servidor após cada refetch sem setState síncrono em efeito.
  const [rascunho, setRascunho] = useState<InstanciaDeReceita | null>(null);
  // O que a tela está editando (a fonte da verdade dos "fixos" em edição).
  const [editor, setEditor] = useState<EditorDoWordpress | null>(null);
  // A tela de ESCOLHER a receita (só na adição; editar não troca a receita).
  const [escolhendo, setEscolhendo] = useState(false);
  // O modelo que espera confirmação ("isto apaga o que você preencheu").
  const [confirmandoModelo, setConfirmandoModelo] = useState<string | null>(null);
  // As chaves (o nome do dado na saída) só aparecem no "avançado".
  const [mostrandoChaves, setMostrandoChaves] = useState(false);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    instancia: { id: string; receita: string; rotulo: string };
    colunas: string[];
    linhas: Record<string, unknown>[];
    linhas_devolvidas: number;
    truncado?: boolean;
  } | null>(null);
  const [previewando, setPreviewando] = useState(false);

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
  // A receita escolhida é a do registro, e o motor da conexão decide quais
  // aparecem. Uma receita pode ter VÁRIAS instâncias (imóveis e veículos no
  // mesmo site), então a lista NÃO esconde as receitas já cadastradas.
  const opcoes = receitasDisponiveis(motor);

  const salvar = async () => {
    if (!canWrite) return;
    if (rascunho) {
      const problema = problemaDoEditor(
        t,
        editor,
        String((rascunho.fixos as { post_type?: string } | undefined)?.post_type ?? ""),
      );
      if (problema) {
        toast.error(problema);
        return;
      }
    }
    try {
      await salvarReceitas(connectionId, lista);
      toast.success(t("Salvo."));
      setRascunho(null);
      setEditor(null);
      setEscolhendo(false);
      setConfirmandoModelo(null);
      await query.refetch();
    } catch (err) {
      // 422 de validação do Zod: a rota devolve `details.fieldErrors` com o
      // campo que falhou. Mostra qual campo e por quê, em vez do genérico
      // "Campos inválidos."
      if (err instanceof ApiError && err.code === "validation_failed") {
        const fieldErrors = (err.details as
          | { fieldErrors?: Record<string, string[]> }
          | undefined)?.fieldErrors;
        const campo = fieldErrors ? Object.keys(fieldErrors)[0] : undefined;
        const motivo = fieldErrors && campo ? fieldErrors[campo]?.[0] : undefined;
        if (fieldErrors && campo) {
          // O rótulo do CAMINHO que falhou, em português de leigo: o Zod da
          // receita responde por "campos", "esconder.meta_key"…
          const rotulos = rotulosDoErro(t);
          const label = rotuloDoCaminho(rotulos, campo);
          toast.error(
            t("O campo {campo} não pôde ser salvo: {motivo}")
              .replace("{campo}", label)
              .replace("{motivo}", t(motivo ?? "")),
          );
          return;
        }
      }
      showApiError(err);
    }
  };

  /** Troca um campo do editor e recalcula os "fixos" que vão para o banco. */
  const mudarEditor = (novo: EditorDoWordpress, postType?: string) => {
    setEditor(novo);
    if (!rascunho) return;
    const f = (rascunho.fixos ?? {}) as { prefixo?: string; post_type?: string };
    const tipoDePost = postType ?? f.post_type ?? "";
    setRascunho({
      ...rascunho,
      fixos: fixosDoEditor(novo, f.prefixo ?? PREFIXO_PADRAO, tipoDePost),
    });
  };

  /** As chaves já usadas — para o rótulo repetido não virar o mesmo dado. */
  const chavesUsadas = (indice: number): string[] => {
    if (!editor) return [];
    return [
      ...editor.campos.filter((_, i) => i !== indice).map((c) => c.chave),
      ...editor.categorias.map((c) => c.chave),
    ];
  };

  const mudarCampo = (indice: number, mudanca: Partial<CampoEditado>) => {
    if (!editor) return;
    const campos = editor.campos.map((c, i) => {
      if (i !== indice) return c;
      const novo: CampoEditado = { ...c, ...mudanca };
      // A chave segue o rótulo — a não ser que a pessoa tenha editado a chave
      // na mão (no "avançado").
      if (!c.chaveManual && mudanca.rotulo !== undefined) {
        novo.chave = chaveUnica(chaveDoRotulo(mudanca.rotulo), chavesUsadas(indice));
      }
      // O filtro tem de caber no tipo.
      if (mudanca.tipo !== undefined && mudanca.filtro === undefined) {
        novo.filtro = filtroQueCabe(mudanca.tipo, c.filtro);
      }
      return novo;
    });
    mudarEditor({ ...editor, campos });
  };

  const mudarCategoria = (indice: number, mudanca: Partial<CategoriaEditada>) => {
    if (!editor) return;
    const categorias = editor.categorias.map((c, i) => {
      if (i !== indice) return c;
      const novo: CategoriaEditada = { ...c, ...mudanca };
      if (!c.chaveManual && mudanca.rotulo !== undefined) {
        const usadas = [
          ...editor.campos.map((x) => x.chave),
          ...editor.categorias.filter((_, j) => j !== indice).map((x) => x.chave),
        ];
        novo.chave = chaveUnica(chaveDoRotulo(mudanca.rotulo), usadas);
      }
      return novo;
    });
    mudarEditor({ ...editor, categorias });
  };

  const adicionarCampo = () => {
    if (!editor) return;
    if (editor.campos.length >= MAX_CAMPOS_WORDPRESS) return;
    const campos = [
      ...editor.campos,
      {
        // A chave nasce VAZIA: ela é gerada do rótulo, que a pessoa escreve
        // (e a chave não pode depender do idioma da tela).
        chave: "",
        chaveManual: false,
        rotulo: "",
        meta_key: "",
        tipo: "texto" as TipoDeCampo,
        filtro: "nenhum" as FiltroDeCampo,
      },
    ];
    mudarEditor({ ...editor, campos });
  };

  const removerCampo = (indice: number) => {
    if (!editor) return;
    const campos = editor.campos.filter((_, i) => i !== indice);
    mudarEditor({ ...editor, campos });
  };

  const adicionarCategoria = () => {
    if (!editor) return;
    if (editor.categorias.length >= MAX_CATEGORIAS_WORDPRESS) return;
    const categorias = [
      ...editor.categorias,
      {
        chave: "",
        chaveManual: false,
        rotulo: "",
        taxonomia: "",
        nivel: "qualquer" as NivelDaTaxonomia,
        filtro: "nenhum" as FiltroDeCategoria,
      },
    ];
    mudarEditor({ ...editor, categorias });
  };

  const removerCategoria = (indice: number) => {
    if (!editor) return;
    const categorias = editor.categorias.filter((_, i) => i !== indice);
    mudarEditor({ ...editor, categorias });
  };

  /**
   * Aplica um MODELO: ele só preenche a configuração da tela.
   *
   * Trocar de modelo apaga o que estava preenchido — inclusive o TIPO DE
   * POST, que o modelo traz o dele. Por isso a tela pergunta antes, e o tipo
   * de post digitado conta como coisa preenchida.
   */
  const aplicarModelo = (id: string) => {
    const modelo = modeloDe(id);
    if (!modelo) return;
    const postTypeAtual = String(
      (rascunho?.fixos as { post_type?: string } | undefined)?.post_type ?? "",
    );
    if (temConteudo(editor, postTypeAtual) && confirmandoModelo !== id) {
      setConfirmandoModelo(id);
      return;
    }
    setConfirmandoModelo(null);
    const campos = camposDoModelo(modelo).map((c) => ({ ...c, chaveManual: false }));
    const categorias = categoriasDoModelo(modelo).map((c) => ({ ...c, chaveManual: false }));
    const novo: EditorDoWordpress = {
      campos:
        campos.length > 0
          ? campos
          : [
              {
                chave: "",
                chaveManual: false,
                rotulo: "",
                meta_key: "",
                tipo: "texto",
                filtro: "nenhum",
              },
            ],
      categorias,
      esconderCampo: modelo.esconder?.meta_key ?? "",
      esconderValores: (modelo.esconder?.valores ?? []).join(", "),
    };
    // O "Em branco" não sugere tipo de post: o site de cada pessoa o chama do
    // jeito que chama, e chutar um seria levar o nicho para dentro da receita.
    const f = (rascunho?.fixos ?? {}) as { post_type?: string };
    const tipoDePost = modelo.post_type.length > 0 ? modelo.post_type : f.post_type ?? "";
    mudarEditor(novo, tipoDePost);
  };

  /** Cria a instância da receita escolhida. */
  const escolherReceita = (receita: DefinicaoDeReceita) => {
    const ehWordpress = receita.id === RECEITA_WORDPRESS;
    const novoEditor = ehWordpress ? editorPadraoWordpress() : null;
    setEditor(novoEditor);
    setEscolhendo(false);
    setConfirmandoModelo(null);
    setMostrandoChaves(false);
    const nova: InstanciaDeReceita = {
      id: randomId(),
      receita: receita.id,
      rotulo: receita.rotulo,
      descricao: "",
      // A receita do WordPress precisa do prefixo, do tipo de post e do
      // mapeamento de onde vem cada dado: sem os fixos certos, o SQL montado
      // não acha as tabelas.
      fixos: ehWordpress
        ? fixosDoEditor(novoEditor!, PREFIXO_PADRAO, "")
        : { prefixo: PREFIXO_PADRAO },
      ativa: true,
    };
    setRascunho(nova);
  };

  const editar = (inst: InstanciaDeReceita) => {
    if (!canWrite) return;
    setEditor(inst.receita === RECEITA_WORDPRESS ? editorDoWordpress(inst.fixos) : null);
    setEscolhendo(false);
    setConfirmandoModelo(null);
    setMostrandoChaves(false);
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
        {/* Só depois que a lista chegou: salvar troca a lista INTEIRA, e uma
            receita adicionada antes disso apagaria as que já estavam salvas. */}
        {canWrite && query.data && opcoes.length > 0 && (
          <Button size="sm" onClick={() => setEscolhendo(true)}>
            {t("Adicionar receita")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!query.data && <p className="text-sm text-muted-foreground">{t("Carregando receitas…")}</p>}
        {query.data && receitas.length === 0 && canWrite && (
          <p className="text-sm text-muted-foreground">
            {t("Nenhuma receita cadastrada ainda. Adicione uma para o assistente consultar o banco de origem.")}
          </p>
        )}

        {/* ─── A ESCOLHA DA RECEITA (só na adição) ──────────────────────────── */}
        {escolhendo && canWrite && (
          <Card className="border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              {t("Qual receita você quer usar?")}
            </p>
            <div className="space-y-2">
              {opcoes.map((opcao) => (
                <button
                  key={opcao.id}
                  type="button"
                  onClick={() => escolherReceita(opcao)}
                  className="block w-full rounded-md border bg-background p-2 text-left text-sm hover:bg-accent"
                >
                  <span className="block font-medium">{t(opcao.rotulo)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(opcao.resumo ?? opcao.descricao)}
                  </span>
                </button>
              ))}
            </div>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => setEscolhendo(false)}>
              {t("Cancelar")}
            </Button>
          </Card>
        )}

        {receitas.map((inst) => {
          const receita = receitaDe(inst.receita);
          const editandoEsta = rascunho?.id === inst.id;
          const ehWordpress = receita?.id === RECEITA_WORDPRESS;
          const cols =
            inst.fixos && typeof inst.fixos === "object" && "prefixo" in inst.fixos
              ? String((inst.fixos as { prefixo?: string }).prefixo ?? PREFIXO_PADRAO)
              : PREFIXO_PADRAO;
          // Os fixos: o tipo de post e o mapeamento de meta_key por campo.
          const fixosInstancia = (inst.fixos as
            | { post_type?: string; campos?: CampoMapeado[]; categorias?: CategoriaMapeada[] }
            | undefined) ?? {};
          const postType = fixosInstancia.post_type ?? "";
          // O editor é a fonte da verdade dos campos em edição; quando ele não
          // está na mão (ex.: recarregou a tela no meio da edição), ele é
          // reconstruído a partir dos "fixos" salvos — um formulário vazio
          // faria a pessoa salvar o mapeamento apagado sem querer.
          const editorDaInstancia =
            editandoEsta && ehWordpress ? (editor ?? editorDoWordpress(inst.fixos)) : null;

          if (editandoEsta && canWrite) {
            return (
              <Card key={inst.id} className="border border-border p-3 mb-2">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="col-span-1 md:col-span-2">
                    <Label htmlFor={idInputRotulo} className="text-xs text-muted-foreground">
                      {t("Nome da receita")}
                    </Label>
                    <Input
                      id={idInputRotulo}
                      maxLength={80}
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
                      maxLength={300}
                      value={inst.descricao}
                      onChange={(e) => {
                        const prox = { ...inst, descricao: e.target.value };
                        setRascunho(prox);
                      }}
                    />
                  </div>
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
                        const prox = { ...inst, fixos: { ...(inst.fixos as object), prefixo: valor } };
                        setRascunho(prox);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("O prefixo aparece antes de _posts no banco do WordPress (padrão wp_).")}
                    </p>
                  </div>
                  {ehWordpress && (
                    <div>
                      <Label htmlFor={idInputPostType} className="text-xs text-muted-foreground">
                        {t("Tipo de post")}
                      </Label>
                      <Input
                        id={idInputPostType}
                        value={postType}
                        onChange={(e) => {
                          const valor = e.target.value;
                          if (valor !== "" && !POST_TYPE_REGEX.test(valor)) return;
                          const prox = {
                            ...inst,
                            fixos: { ...(inst.fixos as object), post_type: valor },
                          };
                          setRascunho(prox);
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("Qual tipo de post do WordPress (por exemplo, imovel, veiculo, produto).")}
                      </p>
                    </div>
                  )}
                  <div className="col-span-1 md:col-span-1 flex items-end">
                    <Switch
                      checked={inst.ativa}
                      onCheckedChange={(ativa) => {
                        const prox = { ...inst, ativa };
                        setRascunho(prox);
                      }}
                    />
                    <Label className="text-xs ml-2 text-muted-foreground">{t("Ativa")}</Label>
                  </div>
                </div>

                {ehWordpress && editorDaInstancia && (
                  <div className="mt-2 space-y-4 border-t pt-3">
                    {/* ── Modelos ─────────────────────────────────────────────── */}
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">
                        {t("Começar de um modelo")}
                      </p>
                      <p className="text-xs text-muted-foreground mb-2">
                        {t("O modelo só preenche esta tela com uma configuração que serve ao seu site.")}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {MODELOS_WORDPRESS.map((modelo) => (
                          <Button
                            key={modelo.id}
                            size="sm"
                            variant="outline"
                            onClick={() => aplicarModelo(modelo.id)}
                          >
                            {t(modelo.rotulo)}
                          </Button>
                        ))}
                      </div>
                      {confirmandoModelo && (
                        <div className="mt-2 rounded-md border p-2">
                          <p className="text-xs text-muted-foreground mb-1">
                            {t("Trocar de modelo apaga o que você preencheu. Quer continuar?")}
                          </p>
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => aplicarModelo(confirmandoModelo)}>
                              {t("Sim")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setConfirmandoModelo(null)}
                            >
                              {t("Não")}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* ── Campos ──────────────────────────────────────────────── */}
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">
                        {t("Campos do site")}
                      </p>
                      <p className="text-xs text-muted-foreground mb-2">
                        {t("O nome do campo no ACF ou no JetEngine, e o que ele guarda.")}
                      </p>
                      <div className="space-y-2">
                        {editorDaInstancia.campos.map((campo, i) => {
                          const idRotulo = `${idInputWordpress}-campo-${i}-rotulo`;
                          const idMeta = `${idInputWordpress}-campo-${i}-meta`;
                          const idTipo = `${idInputWordpress}-campo-${i}-tipo`;
                          const idFiltro = `${idInputWordpress}-campo-${i}-filtro`;
                          const idChave = `${idInputWordpress}-campo-${i}-chave`;
                          return (
                            <div
                              key={`campo-${i}`}
                              role="group"
                              aria-label={campo.rotulo || t("Campo")}
                              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 items-end"
                            >
                              <div>
                                <Label htmlFor={idRotulo} className="text-xs text-muted-foreground">
                                  {t("Rótulo")}
                                </Label>
                                <Input
                                  id={idRotulo}
                                  maxLength={40}
                                  value={campo.rotulo}
                                  onChange={(e) => mudarCampo(i, { rotulo: e.target.value })}
                                />
                              </div>
                              <div>
                                <Label htmlFor={idMeta} className="text-xs text-muted-foreground">
                                  {t("Campo no site")}
                                </Label>
                                <Input
                                  id={idMeta}
                                  value={campo.meta_key}
                                  onChange={(e) => {
                                    const valor = e.target.value;
                                    if (valor !== "" && !META_KEY_REGEX.test(valor)) return;
                                    mudarCampo(i, { meta_key: valor });
                                  }}
                                />
                              </div>
                              <div>
                                <Label htmlFor={idTipo} className="text-xs text-muted-foreground">
                                  {t("Tipo")}
                                </Label>
                                <select
                                  id={idTipo}
                                  value={campo.tipo}
                                  onChange={(e) =>
                                    mudarCampo(i, { tipo: e.target.value as TipoDeCampo })
                                  }
                                  className="mt-1 block w-full rounded-md border bg-background p-2 text-sm"
                                >
                                  <option value="texto">{t("Texto")}</option>
                                  <option value="numero">{t("Número")}</option>
                                  <option value="preco">{t("Preço")}</option>
                                </select>
                              </div>
                              <div>
                                <Label htmlFor={idFiltro} className="text-xs text-muted-foreground">
                                  {t("Filtro")}
                                </Label>
                                <select
                                  id={idFiltro}
                                  value={campo.filtro}
                                  onChange={(e) =>
                                    mudarCampo(i, { filtro: e.target.value as FiltroDeCampo })
                                  }
                                  className="mt-1 block w-full rounded-md border bg-background p-2 text-sm"
                                >
                                  <option value="nenhum">{t("Nenhum")}</option>
                                  {campo.tipo === "texto" && (
                                    <option value="contem">{t("Contém")}</option>
                                  )}
                                  {campo.tipo !== "texto" && (
                                    <>
                                      <option value="minimo">{t("Mínimo")}</option>
                                      <option value="maximo">{t("Máximo")}</option>
                                    </>
                                  )}
                                </select>
                              </div>
                              {mostrandoChaves && (
                                <div>
                                  <Label htmlFor={idChave} className="text-xs text-muted-foreground">
                                    {t("Chave")}
                                  </Label>
                                  <Input
                                    id={idChave}
                                    value={campo.chave}
                                    onChange={(e) => {
                                      const valor = e.target.value;
                                      if (valor !== "" && !CHAVE_REGEX.test(valor)) return;
                                      mudarCampo(i, { chave: valor, chaveManual: true });
                                    }}
                                  />
                                </div>
                              )}
                              <div>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => removerCampo(i)}
                                  aria-label={t("Remover campo")}
                                >
                                  {t("Remover")}
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={adicionarCampo}>
                          {t("Adicionar campo")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setMostrandoChaves((v) => !v)}
                        >
                          {mostrandoChaves ? t("Esconder as chaves") : t("Chaves (avançado)")}
                        </Button>
                      </div>
                    </div>

                    {/* ── Categorias ──────────────────────────────────────────── */}
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">
                        {t("Categorias do site")}
                      </p>
                      <p className="text-xs text-muted-foreground mb-2">
                        {t("As categorias do WordPress: a taxonomia e o nome do termo.")}
                      </p>
                      <div className="space-y-2">
                        {editorDaInstancia.categorias.map((categoria, i) => {
                          const idRotulo = `${idInputWordpress}-cat-${i}-rotulo`;
                          const idTax = `${idInputWordpress}-cat-${i}-taxonomia`;
                          const idNivel = `${idInputWordpress}-cat-${i}-nivel`;
                          const idFiltro = `${idInputWordpress}-cat-${i}-filtro`;
                          const idChave = `${idInputWordpress}-cat-${i}-chave`;
                          return (
                            <div
                              key={`categoria-${i}`}
                              role="group"
                              aria-label={categoria.rotulo || t("Categoria")}
                              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 items-end"
                            >
                              <div>
                                <Label htmlFor={idRotulo} className="text-xs text-muted-foreground">
                                  {t("Rótulo")}
                                </Label>
                                <Input
                                  id={idRotulo}
                                  maxLength={40}
                                  value={categoria.rotulo}
                                  onChange={(e) => mudarCategoria(i, { rotulo: e.target.value })}
                                />
                              </div>
                              <div>
                                <Label htmlFor={idTax} className="text-xs text-muted-foreground">
                                  {t("Categoria no site")}
                                </Label>
                                <Input
                                  id={idTax}
                                  value={categoria.taxonomia}
                                  onChange={(e) => {
                                    const valor = e.target.value;
                                    if (valor !== "" && !TAXONOMIA_REGEX.test(valor)) return;
                                    mudarCategoria(i, { taxonomia: valor });
                                  }}
                                />
                              </div>
                              <div>
                                <Label htmlFor={idNivel} className="text-xs text-muted-foreground">
                                  {t("Nível")}
                                </Label>
                                <select
                                  id={idNivel}
                                  value={categoria.nivel}
                                  onChange={(e) =>
                                    mudarCategoria(i, {
                                      nivel: e.target.value as NivelDaTaxonomia,
                                    })
                                  }
                                  className="mt-1 block w-full rounded-md border bg-background p-2 text-sm"
                                >
                                  <option value="qualquer">{t("Qualquer")}</option>
                                  <option value="filho">{t("Tem categoria acima")}</option>
                                  <option value="raiz">{t("Não tem categoria acima")}</option>
                                </select>
                              </div>
                              <div>
                                <Label htmlFor={idFiltro} className="text-xs text-muted-foreground">
                                  {t("Filtro")}
                                </Label>
                                <select
                                  id={idFiltro}
                                  value={categoria.filtro}
                                  onChange={(e) =>
                                    mudarCategoria(i, { filtro: e.target.value as FiltroDeCategoria })
                                  }
                                  className="mt-1 block w-full rounded-md border bg-background p-2 text-sm"
                                >
                                  <option value="nenhum">{t("Nenhum")}</option>
                                  <option value="contem">{t("Contém")}</option>
                                  <option value="igual">{t("Igual")}</option>
                                </select>
                              </div>
                              {mostrandoChaves && (
                                <div>
                                  <Label htmlFor={idChave} className="text-xs text-muted-foreground">
                                    {t("Chave")}
                                  </Label>
                                  <Input
                                    id={idChave}
                                    value={categoria.chave}
                                    onChange={(e) => {
                                      const valor = e.target.value;
                                      if (valor !== "" && !CHAVE_REGEX.test(valor)) return;
                                      mudarCategoria(i, { chave: valor, chaveManual: true });
                                    }}
                                  />
                                </div>
                              )}
                              <div>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => removerCategoria(i)}
                                  aria-label={t("Remover categoria")}
                                >
                                  {t("Remover")}
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <Button size="sm" variant="outline" className="mt-2" onClick={adicionarCategoria}>
                        {t("Adicionar categoria")}
                      </Button>
                    </div>

                    {/* ── Esconder itens ───────────────────────────────────────── */}
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">
                        {t("Esconder itens")}
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <Label
                            htmlFor={`${idInputWordpress}-esconder-campo`}
                            className="text-xs text-muted-foreground"
                          >
                            {t("Campo a esconder")}
                          </Label>
                          <Input
                            id={`${idInputWordpress}-esconder-campo`}
                            value={editorDaInstancia.esconderCampo}
                            onChange={(e) => {
                              const valor = e.target.value;
                              if (valor !== "" && !META_KEY_REGEX.test(valor)) return;
                              mudarEditor({
                                ...editorDaInstancia,
                                esconderCampo: valor,
                              });
                            }}
                          />
                        </div>
                        <div>
                          <Label
                            htmlFor={`${idInputWordpress}-esconder-valores`}
                            className="text-xs text-muted-foreground"
                          >
                            {t("Valores a esconder")}
                          </Label>
                          <Input
                            id={`${idInputWordpress}-esconder-valores`}
                            value={editorDaInstancia.esconderValores}
                            onChange={(e) => {
                              mudarEditor({
                                ...editorDaInstancia,
                                esconderValores: e.target.value,
                              });
                            }}
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("Conteúdo com um desses valores no campo não aparece para o cliente.")}
                      </p>
                    </div>
                  </div>
                )}
                <div className="flex gap-2 mt-2">
                  <Button size="sm" onClick={salvar}>
                    {t("Salvar")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => {
                    setRascunho(null);
                    setEditor(null);
                    setConfirmandoModelo(null);
                  }}>
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
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("Pré-visualização (até 5 linhas)")} — {preview.linhas_devolvidas} {preview.linhas_devolvidas === 1 ? t("linha") : t("linhas")}
                      {preview.truncado ? ` · ${t("truncado")}` : ""}
                    </p>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {preview.colunas.map((c) => (
                              <TableCell key={c} className="text-xs font-medium">{c}</TableCell>
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
            <Card key={inst.id} className="border border-border p-3 mb-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">
                    {inst.rotulo || (receita ? t(receita.rotulo) : inst.receita)}
                  </p>
                  <p className="text-xs text-muted-foreground min-w-0 break-words">{inst.descricao || (receita?.descricao ?? "")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("Prefixo:")} <span className="font-mono">{cols}</span>
                  </p>
                  {ehWordpress && (
                    <p className="text-xs text-muted-foreground">
                      {t("Tipo de post:")} <span className="font-mono">{postType}</span>
                    </p>
                  )}
                  {ehWordpress && (fixosInstancia.campos ?? []).length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("Campos:")}{" "}
                      <span className="font-mono">
                        {(fixosInstancia.campos ?? []).map((c) => c.rotulo).join(", ")}
                      </span>
                    </p>
                  )}
                  {ehWordpress && (fixosInstancia.categorias ?? []).length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("Categorias:")}{" "}
                      <span className="font-mono">
                        {(fixosInstancia.categorias ?? []).map((c) => c.rotulo).join(", ")}
                      </span>
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
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
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("Pré-visualização (até 5 linhas)")} — {preview.linhas_devolvidas} {preview.linhas_devolvidas === 1 ? t("linha") : t("linhas")}
                    {preview.truncado ? ` · ${t("truncado")}` : ""}
                  </p>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {preview.colunas.map((c) => (
                            <TableCell key={c} className="text-xs font-medium">{c}</TableCell>
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
