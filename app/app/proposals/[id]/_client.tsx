"use client";

import { useEffect, useRef, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { ApiSuccess } from "@/lib/api/wrappers";
import { formatCents } from "@/lib/money";
import type { ProposalStatus } from "@/lib/propostas/tipos";
import { AssistantPanel } from "./_components/AssistantPanel";
import { DocumentoCanvas } from "./_components/DocumentoCanvas";

interface ProposalItem {
  id?: string;
  product_id: string | null;
  descricao: string;
  quantidade: number;
  preco_unitario_cents: number | null;
  desconto_cents: number;
  position: number;
  /** N4 — preço ATUAL do catálogo (só quando product_id não é nulo). */
  preco_catalogo_atual_cents?: number | null;
}

interface Proposta {
  id: string;
  titulo: string;
  condicoes: string | null;
  valid_until: string | null;
  prazo_dias_uteis: number | null;
  pagamento: string | null;
  status: ProposalStatus;
  revision: number;
  total_cents: number;
  itens: ProposalItem[];
  moeda: string;
  ultima_falha_envio: string | null;
  /** C1 — modelo CONFIRMADO. Nulo/vazio: a rota de envio recusa com 422. */
  template_slug: string | null;
}

interface Produto {
  id: string;
  codigo: string;
  nome: string;
  descricao: string;
  marca: string;
  categoria: string;
  preco_cents: number;
  moeda: string;
}

/**
 * O que a pessoa EDITA — a impressão digital do rascunho na tela.
 *
 * `sujo` não é um estado: é esta assinatura contra a última coisa gravada, e é
 * por isso que ele responde a pergunta certa sem lista de `setState` espalhada
 * por cada campo. O `preco_catalogo_atual_cents` fica de fora de propósito: é
 * informação do CATÁLOGO que viaja junto no GET, e a tela não a edita.
 */
function assinaturaDoRascunho(p: Proposta): string {
  return JSON.stringify({
    titulo: p.titulo,
    condicoes: p.condicoes,
    valid_until: p.valid_until,
    prazo_dias_uteis: p.prazo_dias_uteis,
    pagamento: p.pagamento,
    itens: p.itens.map((it) => [
      it.product_id,
      it.descricao,
      it.quantidade,
      it.preco_unitario_cents,
      it.desconto_cents,
    ]),
  });
}

/**
 * A LINHA EM BRANCO QUE A PESSOA NÃO PREENCHEU.
 *
 * "+ Item à mão" nasce com descrição vazia e preço vazio. Quem clica no botão e
 * não escreve nada — ou clica e desiste — deixa essa linha para trás, e ela vai
 * no PATCH: o `descricao` do schema é `min(1)`, a rota responde 422 "Campos
 * inválidos." e a pessoa não descobre que era a linha que ela mesma criou. É
 * lixo de formulário, não intenção: some.
 *
 * O que NÃO pode sumir é a linha com PREÇO e sem descrição — dinheiro sem nome
 * é proposta pela metade, e descartá-la apagaria calado o que a pessoa já
 * digitou. Essa a tela acusa, dizendo o número.
 */
function linhasParaGravar(itens: ProposalItem[]): ProposalItem[] {
  return itens.filter((it) => it.descricao.trim().length > 0 || it.preco_unitario_cents !== null);
}

/** O caminho do campo que a rota recusou (`itens.2.descricao`), legível. */
function campoRecusado(caminho: string): string {
  const item = /^itens\.(\d+)\.(\w+)$/.exec(caminho);
  if (!item || item[1] === undefined) return caminho;
  return `item ${Number(item[1]) + 1} · ${item[2] ?? ""}`;
}

/**
 * Os campos que a rota recusou, lidos do `details` que ela devolve.
 *
 * A rota responde 422 com `parsed.error.flatten()`, que é `{ formErrors,
 * fieldErrors }`; `fieldErrors` é o mapa do Zod e a chave é o CAMINHO. A tela
 * repetia "Campos inválidos." — que não é mentira, é inútil: a pessoa tem sete
 * campos na frente e nenhum sinal de qual deles a rota viu.
 *
 * Devolve lista VAZIA quando não há `details` legível, e quem chama cai na
 * frase que descreve o outro caso (a proposta mudou, o 409) — que é a majori-
 * tária do que volta de uma edição.
 */
function camposRecusados(details: Record<string, unknown> | undefined): string[] {
  if (!details) return [];
  const porCampo = details.fieldErrors;
  const mapa =
    porCampo && typeof porCampo === "object"
      ? (porCampo as Record<string, unknown>)
      : // `lib/schemas/_validate.ts` e várias rotas gravam o mapa direto, sem
        // a casca do Zod: os dois formatos chegam aqui. `formErrors` é a lista
        // de erros do formulário INTEIRO — não é campo, e não vira nome na frase.
        Object.fromEntries(
          Object.entries(details).filter(
            ([chave, v]) => chave !== "formErrors" && Array.isArray(v) && v.every((m) => typeof m === "string"),
          ),
        );
  return Object.keys(mapa).map(campoRecusado);
}

export function ProposalEditorClient({ id, podeEditar, podeRevisar = false }: { id: string; podeEditar: boolean; podeRevisar?: boolean }) {
  const t = useT();
  const [proposta, setProposta] = useState<Proposta | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [buscaProdutos, setBuscaProdutos] = useState<string>("");
  const [resultadosProdutos, setResultadosProdutos] = useState<Produto[]>([]);
  const [mostraBuscaProdutos, setMostraBuscaProdutos] = useState(false);
  // N4 — "Manter" esconde a faixa só nesta sessão de edição (não persiste).
  const [driftIgnorado, setDriftIgnorado] = useState(false);
  // Salvar prazo/itens muda o documento (prazo e investimento): o canvas recarrega.
  const [versaoDoDocumento, setVersaoDoDocumento] = useState(0);
  const [gerandoPrevia, setGerandoPrevia] = useState(false);
  const abortController = useRef<AbortController | null>(null);
  /**
   * O que estava GRAVADO na última gravação. `null` = ainda não carregou, e aí
   * não há "alteração não salva" para falar: o que está na tela veio do servidor.
   */
  const ultimaGravacao = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortController.current = controller;

    apiClient
      .get<ApiSuccess<Proposta>>(`/api/v1/proposals/${id}`, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        ultimaGravacao.current = assinaturaDoRascunho(res.data);
        setProposta(res.data);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        showApiError(error);
      });

    return () => controller.abort();
  }, [id]);

  useEffect(() => {
    const trimmedBusca = buscaProdutos.trim();
    if (!trimmedBusca) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResultadosProdutos([]);
      return;
    }

    const controller = new AbortController();

    apiClient
      .get<ApiSuccess<Produto[]>>(`/api/v1/products?busca=${encodeURIComponent(trimmedBusca)}`, {
        signal: controller.signal,
      })
      .then((res) => {
        if (!controller.signal.aborted) setResultadosProdutos(res.data);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        showApiError(error);
      });

    return () => controller.abort();
  }, [buscaProdutos]);

  if (!proposta) return <div className="p-6">{t("Carregando…")}</div>;

  const total = proposta.itens.reduce((acc, it) => {
    if (it.preco_unitario_cents === null) return acc;
    const subtotal = Math.round(it.quantidade * it.preco_unitario_cents);
    return acc + Math.max(0, subtotal - it.desconto_cents);
  }, 0);

  // N4 — itens de catálogo cujo preço mudou desde que entraram na proposta.
  // Item manual (sem product_id) nunca participa; produto apagado
  // (preco_catalogo_atual_cents null) também não.
  const itensComDrift = proposta.itens.filter(
    (it) => it.product_id !== null && it.preco_catalogo_atual_cents !== null && it.preco_catalogo_atual_cents !== undefined && it.preco_catalogo_atual_cents !== it.preco_unitario_cents,
  );

  function atualizarItem(idx: number, patch: Partial<ProposalItem>) {
    setProposta((p) =>
      p && {
        ...p,
        itens: p.itens.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
      },
    );
  }

  function adicionarItemManual() {
    setProposta((p) =>
      p && {
        ...p,
        itens: [
          ...p.itens,
          {
            product_id: null,
            descricao: "",
            quantidade: 1,
            preco_unitario_cents: null,
            desconto_cents: 0,
            position: (p.itens.at(-1)?.position ?? 0) + 1000,
          },
        ],
      },
    );
  }

  function adicionarItemDoCatalogo(produto: Produto) {
    setProposta((p) =>
      p && {
        ...p,
        itens: [
          ...p.itens,
          {
            product_id: produto.id,
            descricao: produto.nome,
            quantidade: 1,
            preco_unitario_cents: produto.preco_cents,
            desconto_cents: 0,
            position: (p.itens.at(-1)?.position ?? 0) + 1000,
          },
        ],
      },
    );
    setMostraBuscaProdutos(false);
    setBuscaProdutos("");
  }

  /**
   * Grava o rascunho. Devolve `boolean` porque `enviar()` depende da RESPOSTA:
   * salvar para depois enviar só faz sentido se o salvar deu certo.
   *
   * Antes de sair, duas checagens que só a tela pode fazer:
   * a linha em branco que ninguém preencheu é descartada (`linhasParaGravar`),
   * e a linha com preço e sem descrição é ACUSADA, com o número dela.
   */
  async function salvar(): Promise<boolean> {
    if (!proposta) return false;
    setErro(null);
    const itens = linhasParaGravar(proposta.itens);
    const semDescricao = itens.findIndex((it) => it.descricao.trim().length === 0);
    if (semDescricao >= 0) {
      setErro(t("Preencha a descrição do item {n}.").replace("{n}", String(semDescricao + 1)));
      return false;
    }
    setSalvando(true);
    try {
      const res = await apiClient.patch<ApiSuccess<{ id: string; revision: number; total_cents: number }>>(
        `/api/v1/proposals/${id}`,
        {
          revision: proposta.revision,
          titulo: proposta.titulo,
          condicoes: proposta.condicoes,
          valid_until: proposta.valid_until,
          prazo_dias_uteis: proposta.prazo_dias_uteis,
          pagamento: proposta.pagamento,
          itens,
        },
      );
      // A tabela passa a refletir EXATAMENTE o que foi gravado — a linha
      // descartada some de vez, e `sujo` (que compara com isto) volta a falso.
      ultimaGravacao.current = assinaturaDoRascunho({ ...proposta, itens });
      setProposta((p) =>
        p && {
          ...p,
          revision: res.data.revision,
          total_cents: res.data.total_cents,
          itens,
        },
      );
      setVersaoDoDocumento((n) => n + 1);
      return true;
    } catch (e) {
      setErro(mensagemDaEdicaoRecusada(e));
      showApiError(e);
      return false;
    } finally {
      setSalvando(false);
    }
  }

  /**
   * O que a tela diz quando a gravação não deu certo.
   *
   * Antes era uma frase só, e ela era a errada: 422 de validação recebia
   * "A proposta mudou desde que você abriu" — que descreve o 409 e não o que
   * tinha acontecido. Agora o `details` da rota diz o campo, e a frase nomeia o
   * campo. Sem `details` legível, sobra o caso comum: a proposta mudou.
   */
  function mensagemDaEdicaoRecusada(e: unknown): string {
    if (e instanceof ApiError) {
      const campos = camposRecusados(e.details);
      if (campos.length > 0) {
        return t("O servidor recusou estes campos: {campos}.").replace("{campos}", campos.join("; "));
      }
    }
    return t("A proposta mudou desde que você abriu. Recarregue antes de editar.");
  }

  async function descartar() {
    if (!window.confirm(t("Descartar este rascunho? A proposta anterior (se houver) não é afetada."))) return;
    setSalvando(true);
    setErro(null);
    try {
      await apiClient.delete(`/api/v1/proposals/${id}`);
      window.location.href = "/app/proposals";
    } catch (e) {
      setErro(t("Não foi possível descartar. Confira se você tem papel de gestor."));
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  /**
   * "Enviar ao cliente" envia o que a pessoa acabou de DIGITAR.
   *
   * O defeito medido: ela escreve o preço, clica em Enviar e recebe "Item sem
   * preço" — porque o envio leu a versão GRAVADA, e o preço que ela digitou
   * estava só na tela. O conserto é gravar antes, e abortar o envio se a
   * gravação falhar: enviar o rascunho velho é pior do que não enviar.
   */
  async function enviar() {
    if (!proposta) return;
    // A mesma pergunta do render, respondida NO CLIQUE: o que está na tela é
    // diferente do que está gravado? Ler o `ref` aqui (evento) é permitido —
    // era a leitura durante o render que o `react-hooks` reprovava.
    const sujo = ultimaGravacao.current !== null && ultimaGravacao.current !== assinaturaDoRascunho(proposta);
    if (sujo) {
      const salvou = await salvar();
      if (!salvou) return;
    }
    setSalvando(true);
    setErro(null);
    try {
      await apiClient.post<ApiSuccess<{ id: string; numero: number; ano: number; message_id: string }>>(
        `/api/v1/proposals/${id}/send`,
        {},
      );
      const res = await apiClient.get<ApiSuccess<Proposta>>(`/api/v1/proposals/${id}`);
      ultimaGravacao.current = assinaturaDoRascunho(res.data);
      setProposta(res.data);
    } catch (e) {
      setErro(t("Não foi possível enviar. Confira se você tem papel de gestor."));
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  /**
   * "Ver como o cliente recebe" — abre o PDF que o envio faria AGORA, numa
   * aba nova. `fetch` cru (e não `apiClient`) porque a resposta não é JSON: é o
   * arquivo, que vira blob para o navegador abrir sem sair da tela. A rota é de
   * leitura — não aloca número, não muda status, não envia nada.
   */
  async function verPrevia() {
    setGerandoPrevia(true);
    setErro(null);
    try {
      const res = await fetch(`/api/v1/proposals/${id}/previa`, { credentials: "same-origin" });
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        window.open(url, "_blank", "noopener");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return;
      }
      // O corpo da recusa é o mesmo envelope de erro das outras rotas; quando
      // não é JSON (proxy no meio, 502), a frase genérica é o que a tela mostra.
      const corpo = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setErro(corpo?.error?.message ?? t("Não foi possível gerar a prévia agora."));
    } catch {
      setErro(t("Não foi possível gerar a prévia agora."));
    } finally {
      setGerandoPrevia(false);
    }
  }

  async function decidir(decisao: "aceita" | "recusada", motivo?: string) {
    try {
      await apiClient.post(`/api/v1/proposals/${id}/decide`, { decisao, motivo });
      const res = await apiClient.get<ApiSuccess<Proposta>>(`/api/v1/proposals/${id}`);
      ultimaGravacao.current = assinaturaDoRascunho(res.data);
      setProposta(res.data);
    } catch (e) {
      showApiError(e);
    }
  }

  const editavel = podeEditar && proposta.status === "rascunho";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
      <header>
        <input
          className="text-2xl font-semibold w-full border rounded-md px-2 py-1"
          value={proposta.titulo}
          disabled={!editavel}
          onChange={(e) => setProposta((p) => p && { ...p, titulo: e.target.value })}
          placeholder={t("Título da proposta")}
        />
      </header>

      {erro && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {erro}
        </div>
      )}

      <DocumentoCanvas
        propostaId={id}
        podeRevisar={podeRevisar}
        emRascunho={proposta.status === "rascunho"}
        versao={versaoDoDocumento}
        onModeloConfirmado={(slug) => setProposta((p) => p && { ...p, template_slug: slug })}
      />

      <div className="space-y-2">
        <label className="block text-sm font-medium">{t("Condições")}</label>
        <textarea
          className="w-full rounded-md border p-2 text-sm disabled:bg-muted"
          value={proposta.condicoes ?? ""}
          disabled={!editavel}
          onChange={(e) => setProposta((p) => p && { ...p, condicoes: e.target.value || null })}
          placeholder={t("Ex: Prazo de 30 dias, 50% adiantado")}
          rows={3}
        />
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium">{t("Válido até")}</label>
        <input
          type="date"
          className="w-full rounded-md border p-2 text-sm disabled:bg-muted"
          value={proposta.valid_until ?? ""}
          disabled={!editavel}
          onChange={(e) => setProposta((p) => p && { ...p, valid_until: e.target.value || null })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="prazo-dias-uteis" className="block text-sm font-medium">{t("Prazo (dias úteis)")}</label>
          <input
            id="prazo-dias-uteis"
            type="number"
            min="1"
            max="365"
            step="1"
            className="w-full rounded-md border p-2 text-sm disabled:bg-muted"
            value={proposta.prazo_dias_uteis ?? ""}
            disabled={!editavel}
            onChange={(e) =>
              setProposta((p) => p && { ...p, prazo_dias_uteis: e.target.value === "" ? null : Math.round(Number(e.target.value)) || null })
            }
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="forma-de-pagamento" className="block text-sm font-medium">{t("Forma de pagamento")}</label>
          <input
            id="forma-de-pagamento"
            type="text"
            maxLength={500}
            className="w-full rounded-md border p-2 text-sm disabled:bg-muted"
            value={proposta.pagamento ?? ""}
            disabled={!editavel}
            onChange={(e) => setProposta((p) => p && { ...p, pagamento: e.target.value || null })}
            placeholder={t("Ex: 50% no aceite e 50% na entrega")}
          />
        </div>
      </div>

      {editavel && itensComDrift.length > 0 && !driftIgnorado && (
        <div className="rounded-lg border border-warning/40 bg-warning-bg p-3 text-sm text-warning-fg">
          <p>
            {itensComDrift.length}{" "}
            {itensComDrift.length === 1
              ? t("item mudou de preço no catálogo")
              : t("itens mudaram de preço no catálogo")}
          </p>
          {/*
            Achado Importante da revisão final da C3b+E1: o botão "Manter" só
            escondia este aviso — o preço do item de catálogo é SEMPRE
            resolvido de novo pelo servidor ao salvar (resolverItensDaProposta,
            por desenho: nunca aceita o preço que o cliente mandou). Um botão
            "Manter" que não mantinha nada mentia pro usuário. Não existe hoje
            um jeito de travar o preço antigo (exigiria pricing_status
            'approved' chegando ao resolvedor, fora do escopo deste achado) —
            então a cópia fica honesta em vez de fingir uma trava que não há.
          */}
          <p className="mt-1 text-xs text-warning-fg">
            {t("Ao salvar, o preço do catálogo será aplicado de qualquer forma.")}
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // Só estado LOCAL — ainda precisa de "Salvar" para persistir.
                setProposta((p) =>
                  p && {
                    ...p,
                    itens: p.itens.map((it) =>
                      it.product_id !== null && it.preco_catalogo_atual_cents != null && it.preco_catalogo_atual_cents !== it.preco_unitario_cents
                        ? { ...it, preco_unitario_cents: it.preco_catalogo_atual_cents }
                        : it,
                    ),
                  },
                );
              }}
            >
              {t("Atualizar preços")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDriftIgnorado(true)}>
              {t("Ignorar aviso")}
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr className="border-b">
              <th scope="col" className="p-3 text-left">{t("Descrição")}</th>
              <th scope="col" className="p-3 text-right">{t("Qtd")}</th>
              <th scope="col" className="p-3 text-right">{t("Preço unit.")}</th>
              <th scope="col" className="p-3 text-right">{t("Desconto")}</th>
              <th scope="col" className="p-3 text-right">{t("Subtotal")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {proposta.itens.map((it, idx) => {
              const subtotal = it.preco_unitario_cents === null
                ? null
                : Math.round(it.quantidade * it.preco_unitario_cents) - it.desconto_cents;
              return (
                <tr key={it.id ?? idx}>
                  <td className="p-3">
                    <input
                      className="w-full border rounded-md px-2 py-1 text-sm disabled:bg-muted"
                      value={it.descricao}
                      disabled={!editavel}
                      onChange={(e) => atualizarItem(idx, { descricao: e.target.value })}
                      placeholder={t("Descrição")}
                    />
                  </td>
                  <td className="p-3">
                    <input
                      type="number"
                      className="w-full border rounded-md px-2 py-1 text-sm text-right disabled:bg-muted"
                      value={it.quantidade}
                      disabled={!editavel}
                      onChange={(e) => atualizarItem(idx, { quantidade: Number(e.target.value) || 0 })}
                      min="0"
                      step="1"
                    />
                  </td>
                  <td className="p-3">
                    <input
                      type="number"
                      className="w-full border rounded-md px-2 py-1 text-sm text-right disabled:bg-muted"
                      value={it.preco_unitario_cents === null ? "" : it.preco_unitario_cents / 100}
                      placeholder={t("A definir")}
                      disabled={!editavel || it.product_id !== null}
                      onChange={(e) => {
                        const texto = e.target.value;
                        atualizarItem(idx, {
                          preco_unitario_cents: texto === "" ? null : Math.round(Number(texto) * 100) || 0,
                        });
                      }}
                      min="0"
                      step="0.01"
                    />
                  </td>
                  <td className="p-3">
                    <input
                      type="number"
                      className="w-full border rounded-md px-2 py-1 text-sm text-right disabled:bg-muted"
                      value={it.desconto_cents / 100}
                      disabled={!editavel}
                      onChange={(e) =>
                        atualizarItem(idx, { desconto_cents: Math.round(Number(e.target.value) * 100) || 0 })
                      }
                      min="0"
                      step="0.01"
                    />
                  </td>
                  <td className="p-3 text-right font-medium tabular-nums">
                    {subtotal === null ? t("A definir") : formatCents(Math.max(0, subtotal), proposta.moeda)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editavel && (
        <AssistantPanel
          propostaId={id}
          revision={proposta.revision}
          onAplicado={(r) => {
            setProposta((p) => p && { ...p, revision: r.revision, total_cents: r.total_cents });
            // recarrega a proposta inteira para refletir os itens que o assistente mudou
            apiClient.get<ApiSuccess<Proposta>>(`/api/v1/proposals/${id}`).then((res) => {
              // O assistente grava no servidor: o que voltou É o que está
              // gravado, e `sujo` precisa saber disso.
              ultimaGravacao.current = assinaturaDoRascunho(res.data);
              setProposta(res.data);
            });
          }}
        />
      )}

      {editavel && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={adicionarItemManual}>
            {t("+ Item à mão")}
          </Button>
          <div className="flex-1">
            <input
              type="text"
              className="w-full rounded-md border px-3 py-2 text-sm"
              placeholder={t("Buscar produto no catálogo…")}
              value={buscaProdutos}
              onChange={(e) => {
                setBuscaProdutos(e.target.value);
                setMostraBuscaProdutos(true);
              }}
              onFocus={() => buscaProdutos && setMostraBuscaProdutos(true)}
            />
            {mostraBuscaProdutos && resultadosProdutos.length > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-lg border bg-popover text-popover-foreground shadow-lg">
                {resultadosProdutos.map((produto) => (
                  <button
                    key={produto.id}
                    className="block w-full border-b px-3 py-2 text-left text-sm hover:bg-accent last:border-b-0"
                    onClick={() => adicionarItemDoCatalogo(produto)}
                  >
                    <div className="font-medium">{produto.nome}</div>
                    <div className="text-xs text-muted-foreground">
                      {t("Código")}: {produto.codigo} • {formatCents(produto.preco_cents, produto.moeda)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between rounded-lg border bg-muted p-4">
        <div className="text-lg font-semibold">{t("Total")}</div>
        <div className="text-2xl font-bold tabular-nums">{formatCents(total, proposta.moeda)}</div>
      </div>

      {proposta.status === "rascunho" && proposta.ultima_falha_envio && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {t("O último envio falhou")}: {proposta.ultima_falha_envio}
        </div>
      )}
      {proposta.status === "enviando" && (
        <div className="rounded-lg border border-warning/40 bg-warning-bg p-3 text-sm text-warning-fg">
          {t("Na fila do WhatsApp — sai assim que o canal conectar.")}
        </div>
      )}
      {/* C1 — o envio exige modelo confirmado: o botão desliga com o motivo
          escrito ao lado, em vez de devolver 422 depois de a pessoa ter
          preenchido a proposta inteira. */}
      {proposta.status === "rascunho" && !proposta.template_slug && (
        <p className="text-sm text-warning-fg">{t("Escolha e confirme o modelo da proposta antes de enviar.")}</p>
      )}
      {proposta.status === "rascunho" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={enviar} disabled={salvando || !proposta.template_slug} className="flex-1">
            {t("Enviar ao cliente")}
          </Button>
          <Button onClick={descartar} disabled={salvando} variant="outline">
            {t("Descartar rascunho")}
          </Button>
        </div>
      )}
      {/* C2 — a prévia é leitura: serve em qualquer status, e o arquivo sai da
          MESMA função que monta o do envio. */}
      <div className="flex justify-end">
        <Button onClick={verPrevia} disabled={gerandoPrevia} variant="outline">
          {t("Ver como o cliente recebe")}
        </Button>
      </div>
      {proposta.status === "enviada" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => decidir("aceita")}>
            {t("Marcar como aceita")}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              const motivo = prompt(t("Motivo da recusa (opcional):")) ?? undefined;
              void decidir("recusada", motivo);
            }}
          >
            {t("Marcar como recusada")}
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                const resp = await apiClient.post<ApiSuccess<{ id: string }>>(`/api/v1/proposals/${proposta.id}/revise`, {});
                window.location.href = `/app/proposals/${resp.data.id}`;
              } catch (erro) {
                showApiError(erro);
              }
            }}
          >
            {t("Revisar esta proposta")}
          </Button>
        </div>
      )}
      {editavel && (
        <Button onClick={salvar} disabled={salvando} className="w-full">
          {salvando ? t("Salvando…") : t("Salvar")}
        </Button>
      )}
    </div>
  );
}
