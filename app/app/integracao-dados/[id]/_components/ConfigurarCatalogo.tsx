"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiClient } from "@/lib/api/client";
import {
  useCatalogoMapeamento,
  useSalvarCatalogoMapeamento,
  type CatalogoMapeamentoDTO,
  type ColunaConfigDTO,
  type OperadorDeBusca,
  type PapelColuna,
  type SalvarCatalogoBody,
} from "@/hooks/external-db/useCatalogoMapeamento";

/** Papel → coluna correspondente na linha de `catalog_mappings` (config antiga). */
const CAMPO_DO_PAPEL: Record<PapelColuna, keyof CatalogoMapeamentoDTO> = {
  nome: "col_nome",
  versao: "col_versao",
  ano: "col_ano",
  cor: "col_cor",
  km: "col_km",
  preco: "col_preco",
  imagem: "col_imagem",
  estoque: "col_estoque",
  cilindrada: "col_cilindrada",
  tipo: "col_tipo",
};

/** Papéis que, na config antiga, eram critério de comparação. */
const PAPEIS_COMPARACAO: readonly PapelColuna[] = ["nome", "cilindrada", "preco", "tipo"];

/** Defaults dos checkboxes (o dono ajusta). Só para mapeamento NOVO. */
const IA_PADRAO = [
  "nome",
  "versao",
  "marca",
  "categoria",
  "ano",
  "cor",
  "preco",
  "cilindrada",
  "quilometragem",
  "estoque",
];
const CRITERIO_PADRAO = [
  "nome",
  "marca",
  "versao",
  "categoria",
  "ano",
  "cor",
  "preco",
  "cilindrada",
];
const MOSTRAR_PADRAO = ["ano", "cor", "preco", "quilometragem"];
const COMPARAR_PADRAO = ["cilindrada", "preco"];
/** C-090: colunas de casamento do modo "enviar todas que casam" (default: igual a Comparar). */
const ENVIO_PADRAO = ["cilindrada", "preco"];
const ORDEM_PADRAO: Record<string, number> = { nome: 1, versao: 1, cilindrada: 2, preco: 3 };

export interface TabelaParaCatalogo {
  schema: string;
  nome: string;
  colunas: Array<{ nome: string }>;
}

interface Props {
  connectionId: string;
  tabela: TabelaParaCatalogo;
  aberto: boolean;
  aoMudarAberto: (aberto: boolean) => void;
}

interface Linha {
  coluna: string;
  /** Valor enviado à IA (contexto). */
  ia: boolean;
  /** A IA pode usar como filtro na consulta ampla. */
  criterio: boolean;
  /** Aparece na legenda que vai com a foto. */
  mostrar: boolean;
  /** O motor usa para ordenar as semelhantes. */
  comparar: boolean;
  /** C-090: coluna de casamento do modo "enviar todas que casam". */
  envio: boolean;
  /** Prioridade (1 = mais importante); 1 também compõe o nome. */
  ordem: string;
}

/** Deriva a configuração por coluna a partir do mapeamento salvo (config antiga). */
function configAntiga(
  m: CatalogoMapeamentoDTO,
  colunas: readonly string[],
): Map<string, ColunaConfigDTO> {
  const mapa = new Map<string, ColunaConfigDTO>();
  const legenda = m.legenda ?? [];
  const ordem = m.ordem ?? {};
  for (const papel of Object.keys(CAMPO_DO_PAPEL) as PapelColuna[]) {
    const coluna = m[CAMPO_DO_PAPEL[papel]] as string | null;
    if (coluna === null || coluna === undefined) continue;
    mapa.set(coluna, {
      coluna,
      ia: true,
      criterio: true,
      mostrar: legenda.includes(coluna),
      comparar: PAPEIS_COMPARACAO.includes(papel),
      ...(typeof ordem[papel] === "number" ? { ordem: ordem[papel] } : {}),
      compoe_nome: ordem[papel] === 1,
    });
  }
  for (const coluna of legenda) {
    if (mapa.has(coluna)) continue;
    mapa.set(coluna, { coluna, ia: true, criterio: true, mostrar: true, comparar: false, compoe_nome: false });
  }
  return mapa;
}

/** Monta as linhas (uma por coluna da tabela) a partir do mapeamento salvo. */
function montarLinhas(
  m: CatalogoMapeamentoDTO | null,
  tabela: TabelaParaCatalogo,
): Linha[] {
  const mesma = m !== null && m.table_name === tabela.nome && m.schema_name === tabela.schema;
  const colunas = tabela.colunas.map(({ nome }) => nome);

  if (mesma && m.colunas !== undefined && m.colunas.length > 0) {
    const porColuna = new Map(m.colunas.map((c) => [c.coluna, c]));
    return colunas.map((coluna) => {
      const c = porColuna.get(coluna);
      return {
        coluna,
        ia: c?.ia ?? false,
        criterio: c?.criterio ?? false,
        mostrar: c?.mostrar ?? false,
        comparar: c?.comparar ?? false,
        envio: c?.envio ?? false,
        ordem: c?.ordem !== undefined ? String(c.ordem) : "",
      };
    });
  }
  if (mesma) {
    const antiga = configAntiga(m, colunas);
    return colunas.map((coluna) => {
      const c = antiga.get(coluna);
      return {
        coluna,
        ia: c?.ia ?? false,
        criterio: c?.criterio ?? false,
        mostrar: c?.mostrar ?? false,
        comparar: c?.comparar ?? false,
        envio: c?.envio ?? false,
        ordem: c?.ordem !== undefined ? String(c.ordem) : "",
      };
    });
  }
  // Mapeamento NOVO: marca o essencial para os primeiros testes.
  return colunas.map((coluna) => ({
    coluna,
    ia: IA_PADRAO.includes(coluna),
    criterio: CRITERIO_PADRAO.includes(coluna),
    mostrar: MOSTRAR_PADRAO.includes(coluna),
    comparar: COMPARAR_PADRAO.includes(coluna),
    envio: ENVIO_PADRAO.includes(coluna),
    ordem: ORDEM_PADRAO[coluna] !== undefined ? String(ORDEM_PADRAO[coluna]) : "",
  }));
}

/** Acha a primeira coluna cujo nome casa com um dos alvos (exato, depois contém). */
function acharColuna(colunas: readonly string[], alvos: readonly string[]): string {
  const norm = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const alvosNorm = alvos.map(norm);
  for (const alvo of alvosNorm) {
    const exata = colunas.find((c) => norm(c) === alvo);
    if (exata) return exata;
  }
  for (const alvo of alvosNorm) {
    const contem = colunas.find((c) => norm(c).includes(alvo));
    if (contem) return contem;
  }
  return "";
}

export function ConfigurarCatalogo({ connectionId, tabela, aberto, aoMudarAberto }: Props) {
  const t = useT();
  const mapeamento = useCatalogoMapeamento(aberto);
  const salvar = useSalvarCatalogoMapeamento();

  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [nome, setNome] = useState<string>("");
  const [prefixo, setPrefixo] = useState<string>("");
  const [foto, setFoto] = useState<string>("");
  const [similaresAtivo, setSimilaresAtivo] = useState(false);
  const [similares, setSimilares] = useState<string>("");
  const [enabled, setEnabled] = useState(true);
  const [similaridade, setSimilaridade] = useState(false);
  const [operador, setOperador] = useState<OperadorDeBusca>("contem");
  const [verificando, setVerificando] = useState(false);
  const [colunasVivas, setColunasVivas] = useState<string[] | null>(null);

  useEffect(() => {
    if (!aberto) return;
    const m: CatalogoMapeamentoDTO | null = mapeamento.data ?? null;
    const mesma = m !== null && m.table_name === tabela.nome && m.schema_name === tabela.schema;
    const salvo = mesma ? m : null;
    const nomes = tabela.colunas.map(({ nome: n }) => n);
    setLinhas(montarLinhas(m, tabela));
    setNome(
      salvo
        ? (salvo.col_nome ?? "")
        : acharColuna(nomes, ["nome", "modelo"]) || (nomes[0] ?? ""),
    );
    setPrefixo(
      salvo
        ? ((salvo.colunas ?? []).find((c) => c.prefixo_nome === true)?.coluna ?? "")
        : acharColuna(nomes, ["marca", "fabricante"]),
    );
    setFoto(salvo ? (salvo.col_imagem ?? "") : acharColuna(nomes, ["imagem_url", "imagem", "foto_url", "foto"]));
    setSimilaresAtivo(salvo !== null && salvo.col_similares != null && salvo.col_similares !== "");
    setSimilares(
      salvo
        ? (salvo.col_similares ?? "")
        : acharColuna(nomes, ["moto_similar", "similares", "similar"]),
    );
    setEnabled(salvo ? salvo.enabled : true);
    setSimilaridade(salvo ? salvo.similaridade_deterministica : false);
    setOperador(salvo ? salvo.busca_operador : "contem");
    setColunasVivas(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto, tabela.schema, tabela.nome, mapeamento.data]);

  function atualizar(indice: number, patch: Partial<Linha>) {
    setLinhas((atual) => atual.map((l, i) => (i === indice ? { ...l, ...patch } : l)));
  }

  /** Relê as colunas da tabela AO VIVO e reajusta as linhas (novas/sumidas). */
  async function verificarEstrutura() {
    setVerificando(true);
    try {
      const res = await apiClient.get<{ data: { colunas: string[] } }>(
        `/api/v1/external-db/connections/${connectionId}/tables/${tabela.schema}/${tabela.nome}?limit=1`,
      );
      const vivas = res.data.colunas ?? [];
      const antes = new Set(linhas.map((l) => l.coluna));
      const novas = vivas.filter((c) => !antes.has(c));
      const removidas = linhas.filter((l) => l.coluna !== "" && !vivas.includes(l.coluna)).map((l) => l.coluna);

      setColunasVivas(vivas);
      setLinhas((atuais) =>
        vivas.map((col) => {
          const existente = atuais.find((l) => l.coluna === col);
          if (existente) return existente;
          return {
            coluna: col,
            ia: IA_PADRAO.includes(col),
            criterio: CRITERIO_PADRAO.includes(col),
            mostrar: MOSTRAR_PADRAO.includes(col),
            comparar: COMPARAR_PADRAO.includes(col),
            envio: ENVIO_PADRAO.includes(col),
            ordem: ORDEM_PADRAO[col] !== undefined ? String(ORDEM_PADRAO[col]) : "",
          };
        }),
      );

      if (novas.length > 0 || removidas.length > 0) {
        const partes = [
          novas.length > 0 ? `${novas.length} nova(s): ${novas.join(", ")}` : "",
          removidas.length > 0 ? `${removidas.length} removida(s): ${removidas.join(", ")}` : "",
        ].filter(Boolean);
        toast.success(`Estrutura atualizada — ${partes.join(" · ")}`);
      } else {
        toast.success("Estrutura conferida — nada mudou.");
      }
    } catch (err) {
      showApiError(err);
    } finally {
      setVerificando(false);
    }
  }

  function salvarMapeamento() {
    if (nome.trim() === "") {
      toast.error("Escolha a coluna com o NOME da moto.");
      return;
    }
    const body: SalvarCatalogoBody = {
      connection_id: connectionId,
      schema_name: tabela.schema,
      table_name: tabela.nome,
      col_nome: nome,
      ...(foto !== "" ? { col_imagem: foto } : {}),
      ...(similaresAtivo && similares !== "" ? { col_similares: similares } : {}),
      busca_operador: operador,
      enabled,
      similaridade_deterministica: similaridade,
      // A QUANTIDADE saiu daqui: fonte única é a config do AGENTE
      // (`ai_agents.config.catalog.similares_qtd`). A coluna do banco fica só
      // como legado e é ignorada pelo motor.
      ordem: {},
      legenda: linhas.filter((l) => l.mostrar).map((l) => l.coluna),
      colunas: linhas.map((l) => ({
        coluna: l.coluna,
        ia: l.ia,
        criterio: l.criterio,
        mostrar: l.mostrar,
        comparar: l.comparar,
        envio: l.envio,
        ...(l.ordem.trim() !== "" ? { ordem: Number(l.ordem) } : {}),
        compoe_nome: l.ordem.trim() === "1",
        prefixo_nome: prefixo !== "" && l.coluna === prefixo,
      })),
    };

    salvar.mutate(body, {
      onSuccess: () => {
        toast.success("Catálogo configurado. O agente já usa este mapeamento.");
        aoMudarAberto(false);
      },
      onError: (err) => showApiError(err),
    });
  }

  const opcoesColuna = tabela.colunas.map(({ nome: n }) => n);

  return (
    <Dialog open={aberto} onOpenChange={aoMudarAberto}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Catálogo do agente — “")}{tabela.nome}{t("”")}</DialogTitle>
          <DialogDescription>
            {t("Diga o que o agente deve fazer com cada coluna: enviar à IA, usar como critério, mostrar no texto e comparar.")}
          </DialogDescription>
        </DialogHeader>

        {/* LEGENDA — explica os controles para quem não é técnico. */}
        <details className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
          <summary className="cursor-pointer font-medium">
            {t("Como preencher (Nome · Foto · Similares · IA · Critério · Mostrar · Comparar · Ordem)")}
          </summary>
          <div className="mt-2 space-y-2 text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">{t("Nome da moto")}</span> {t("— a coluna que identifica e busca a moto (obrigatória).")}
            </p>
            <p>
              <span className="font-medium text-foreground">{t("Foto")}</span> {t("— a coluna com a URL da imagem enviada.")}
            </p>
            <p>
              <span className="font-medium text-foreground">{t("Motos similares (referência)")}</span>{" "}
              {t("— uma coluna que lista motos parecidas (ex.:")} <span className="font-mono">moto_similar</span>
              {t("). Quando o cliente pede uma moto que não temos, o motor procura o pedido nessa coluna e oferece a")}{" "}
              <b>{t("moto real")}</b> {t("que a cita. É usada")} <b>{t("só pelo motor")}</b>
              {t(": a IA nunca vê esses nomes.")}
            </p>
            <p>
              <span className="font-medium text-foreground">{t("Enviar à IA")}</span> {t("— a IA vê o valor desta coluna (contexto). Menos colunas = menos tokens.")}
            </p>
            <p>
              <span className="font-medium text-foreground">{t("Critério da IA")}</span>{" "}
              {t("— a IA pode usar esta coluna para montar o filtro quando não achar o pedido. (Diferente de")}{" "}
              {t("\"Enviar à IA\": aqui ela pode filtrar por ela.)")}
            </p>
            <p>
              <span className="font-medium text-foreground">{t("Mostrar")}</span> {t("— o valor aparece no texto que vai junto com a foto.")}
            </p>
            <p>
              <span className="font-medium text-foreground">{t("Comparar")}</span>{" "}
              {t("— o motor usa esta coluna para ordenar as motos semelhantes (número → mais próximo; texto → mais parecido).")}
            </p>
            <p>
              <span className="font-medium text-foreground">{t("Ordem")}</span>{" "}
              {t("— prioridade (1 = mais importante). Colunas de")} <b>{t("Ordem 1")}</b>{" "}
              {t("também compõem o nome (ex.:")} <span className="font-mono">nome</span> +{" "}
              <span className="font-mono">versao</span> = " Biz 125 FLEX").
            </p>
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-4 py-2">
          <div className="flex items-center gap-2">
            <input
              id="cat-enabled"
              type="checkbox"
              className="h-4 w-4"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <Label htmlFor="cat-enabled">{t("Usar este catálogo no agente")}</Label>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="cat-sim"
              type="checkbox"
              className="h-4 w-4"
              checked={similaridade}
              onChange={(e) => setSimilaridade(e.target.checked)}
            />
            <Label htmlFor="cat-sim">{t("Escolher as semelhantes automaticamente")}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Label>{t("Como buscar")}</Label>
            <Select value={operador} onValueChange={(v) => setOperador(v as OperadorDeBusca)}>
              <SelectTrigger className="h-8 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="contem">{t("Contém (recomendado)")}</SelectItem>
                <SelectItem value="eq">{t("Igual")}</SelectItem>
                <SelectItem value="comeca_com">{t("Começa com")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 rounded-md border border-border/60 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <Label>{t("Nome da moto")}</Label>
            <Select value={nome} onValueChange={setNome}>
              <SelectTrigger className="h-8">
                <SelectValue placeholder={t("Escolha a coluna")} />
              </SelectTrigger>
              <SelectContent>
                {opcoesColuna.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>{t("Prefixo do nome (ex.: marca)")}</Label>
            <Select
              value={prefixo || "__nenhuma__"}
              onValueChange={(v) => setPrefixo(v === "__nenhuma__" ? "" : v)}
            >
              <SelectTrigger className="h-8">
                <SelectValue placeholder={t("Nenhum")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__nenhuma__">{t("Nenhum")}</SelectItem>
                {opcoesColuna.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>{t("Foto (URL da imagem)")}</Label>
            <Select value={foto || "__nenhuma__"} onValueChange={(v) => setFoto(v === "__nenhuma__" ? "" : v)}>
              <SelectTrigger className="h-8">
                <SelectValue placeholder={t("Nenhuma")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__nenhuma__">{t("Nenhuma")}</SelectItem>
                {opcoesColuna.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                id="cat-similares-ativo"
                type="checkbox"
                className="h-4 w-4"
                checked={similaresAtivo}
                onChange={(e) => setSimilaresAtivo(e.target.checked)}
              />
              <Label htmlFor="cat-similares-ativo">{t("Motos similares (referência)")}</Label>
            </div>
            <Select
              value={similares || "__nenhuma__"}
              onValueChange={(v) => setSimilares(v === "__nenhuma__" ? "" : v)}
              disabled={!similaresAtivo}
            >
              <SelectTrigger className="h-8">
                <SelectValue placeholder={t("Nenhuma")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__nenhuma__">{t("Nenhuma")}</SelectItem>
                {opcoesColuna.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {colunasVivas
              ? t("Estrutura conferida agora:") + ` ${colunasVivas.length} ` + t("colunas.")
              : t("Se a tabela mudou no banco, confira a estrutura.")}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={verificarEstrutura}
            disabled={verificando}
            data-testid="catalogo-verificar-estrutura"
          >
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${verificando ? "animate-spin" : ""}`} aria-hidden />
            {verificando ? t("Conferindo…") : t("Verificar estrutura")}
          </Button>
        </div>

        <div className="flex max-h-[42vh] flex-col gap-2 overflow-y-auto rounded-md border border-border/60 p-3">
          <div className="grid grid-cols-[3rem_3rem_3.5rem_3.5rem_3.5rem_1fr_3.5rem] items-center gap-2 text-xs font-semibold text-muted-foreground">
            <span title={t("Enviar o valor para a IA (contexto)")}>IA</span>
            <span title={t("A IA pode usar como filtro")}>{t("Critério")}</span>
            <span title={t("Aparece no texto junto da foto")}>{t("Mostrar")}</span>
            <span title={t("O motor ordena as semelhantes por esta coluna")}>{t("Comparar")}</span>
            <span title={t("Coluna de casamento do modo “Enviar todas que casam”")}>{t("Envio")}</span>
            <span>{t("Coluna")}</span>
            <span title={t("Prioridade (1 = mais importante)")}>{t("Ordem")}</span>
          </div>
          {linhas.map((linha, i) => (
            <div
              key={linha.coluna}
              className="grid grid-cols-[3rem_3rem_3.5rem_3.5rem_3.5rem_1fr_3.5rem] items-center gap-2"
            >
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={linha.ia}
                title={t("Enviar o valor desta coluna para a IA")}
                onChange={(e) => atualizar(i, { ia: e.target.checked })}
              />
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={linha.criterio}
                title={t("A IA pode usar esta coluna como filtro")}
                onChange={(e) => atualizar(i, { criterio: e.target.checked })}
              />
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={linha.mostrar}
                title={t("Exibir este valor no texto que vai junto com a foto")}
                onChange={(e) => atualizar(i, { mostrar: e.target.checked })}
              />
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={linha.comparar}
                title={t("Usar esta coluna para ordenar as motos semelhantes")}
                onChange={(e) => atualizar(i, { comparar: e.target.checked })}
              />
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={linha.envio}
                title={t("Coluna de casamento quando o agente está no modo “enviar todas que casam”")}
                onChange={(e) => atualizar(i, { envio: e.target.checked })}
              />
              <span className="truncate font-mono text-xs" title={linha.coluna}>
                {linha.coluna}
              </span>
              <Input
                type="number"
                min={1}
                max={9}
                value={linha.ordem}
                placeholder="—"
                onChange={(e) => atualizar(i, { ordem: e.target.value })}
                className="h-8"
              />
            </div>
          ))}
        </div>

        {mapeamento.data && mapeamento.data.table_name !== tabela.nome && (
          <p className="text-xs text-muted-foreground">
            {t("Hoje o catálogo é a tabela “")}{mapeamento.data.table_name}{t("”. Salvar aqui troca para esta.")}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => aoMudarAberto(false)}>
            {t("Cancelar")}
          </Button>
          <Button onClick={salvarMapeamento} disabled={salvar.isPending}>
            {salvar.isPending ? t("Salvando…") : t("Salvar catálogo")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
