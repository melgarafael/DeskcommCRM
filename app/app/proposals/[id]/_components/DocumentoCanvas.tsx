// app/app/proposals/[id]/_components/DocumentoCanvas.tsx
"use client";

import { useEffect, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { ApiSuccess } from "@/lib/api/wrappers";
import { ROTULO_DO_MODELO } from "@/lib/propostas/modelos/rotulos";

interface SecaoDocumento {
  id: string;
  title: string;
  body: string;
  faltantes: string[];
  editada?: boolean;
}

type Onde = "briefing" | "campo_prazo" | "itens" | "contato" | "negocio" | "sistema";

interface ModeloDisponivel {
  slug: string;
  nome: string;
  oculto?: boolean;
}

/**
 * O seletor mostra só os modelos não ocultos — MAS sempre inclui o modelo
 * atual do documento, marcado " (desligado)" quando estiver oculto. Sem
 * isto, o `<select>` controlado exibiria outra opção sem aviso.
 */
function opcoesVisiveis(
  modelos: ModeloDisponivel[] | null,
  slugAtual: string | null,
  t: (chave: string) => string,
): Array<[string, string]> {
  if (!modelos) return Object.entries(ROTULO_DO_MODELO);
  const visiveis: Array<[string, string]> = modelos
    .filter((m) => !m.oculto)
    .map((m) => [m.slug, m.nome]);
  const atual = slugAtual ? modelos.find((m) => m.slug === slugAtual) : undefined;
  if (atual?.oculto && !visiveis.some(([s]) => s === atual.slug)) {
    visiveis.push([atual.slug, `${atual.nome} ${t("(desligado)")}`]);
  }
  return visiveis;
}

interface CampoFaltando {
  caminho: string;
  rotulo: string;
  onde: Onde;
  secoes: string[];
}

interface Documento {
  status?: string;
  modeloSlug: string | null;
  modeloSlugSugerido: string | null;
  secoes: SecaoDocumento[];
  variaveisFaltando: string[];
  camposFaltando?: CampoFaltando[];
  temSecaoEditada?: boolean;
  prontidao: { status: string; checklist: Record<string, boolean> } | null;
  resumoComercial: string | null;
}

type Traduz = (chave: string) => string;

export interface DocumentoCanvasProps {
  propostaId: string;
  /** manager+ e sem suporte só-leitura — quem a rota PATCH aceita. */
  podeRevisar?: boolean;
  emRascunho?: boolean;
  /** O editor incrementa quando salva algo que muda o documento (prazo, itens). */
  versao?: number;
  /**
   * Chamado depois que o PATCH de `/modelo` volta bem — com o slug confirmado.
   * É o que o editor usa para liberar "Enviar ao cliente" sem recarregar a
   * página: a rota de envio recusa proposta sem modelo, e a tela não pode
   * continuar mostrando a proposta como se não tivesse.
   */
  onModeloConfirmado?: (slug: string) => void;
}

const DICA_POR_ONDE: Record<Exclude<Onde, "briefing">, string> = {
  campo_prazo: "Preencha no campo Prazo (dias úteis), abaixo.",
  itens: "Vem do total dos itens da proposta.",
  contato: "Vem do cadastro do contato.",
  negocio: "Vem do card do negócio, no funil.",
  sistema: "Calculado pelo sistema.",
};

function CampoQueFalta({
  campo,
  editavel,
  ocupado,
  valorInicial,
  onPreencher,
  t,
}: {
  campo: CampoFaltando;
  editavel: boolean;
  ocupado: boolean;
  valorInicial?: string;
  onPreencher: (valor: string) => void;
  t: Traduz;
}) {
  const [valor, setValor] = useState(valorInicial ?? "");
  const idDoCampo = `campo-${campo.caminho}`;
  if (campo.onde !== "briefing" || !editavel) {
    return (
      <li>
        <span className="font-medium">{t(campo.rotulo)}</span>
        {campo.onde !== "briefing" ? (
          <>
            <span aria-hidden> — </span>
            <span>{t(DICA_POR_ONDE[campo.onde])}</span>
          </>
        ) : null}
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-1 sm:flex-row sm:items-center">
      <label htmlFor={idDoCampo} className="font-medium sm:w-56">
        {t(campo.rotulo)}
      </label>
      <Input id={idDoCampo} value={valor} onChange={(e) => setValor(e.target.value)} className="flex-1 bg-white" />
      <Button size="sm" disabled={ocupado || valor.trim().length === 0} onClick={() => onPreencher(valor.trim())}>
        {t("Preencher")}
      </Button>
    </li>
  );
}

function EditorDeSecao({
  secao,
  ocupado,
  onSalvar,
  onRestaurar,
  t,
}: {
  secao: SecaoDocumento;
  ocupado: boolean;
  onSalvar: (texto: string) => void;
  onRestaurar: () => void;
  t: Traduz;
}) {
  const [texto, setTexto] = useState(secao.body);
  const idDaCaixa = `secao-${secao.id}`;
  const mudou = texto.trim() !== secao.body.trim();
  return (
    <div className="space-y-1">
      <label htmlFor={idDaCaixa} className="block text-sm font-semibold">
        {secao.title}
      </label>
      <Textarea
        id={idDaCaixa}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        rows={Math.min(12, Math.max(3, Math.ceil(texto.length / 90)))}
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={ocupado || !mudou || texto.trim().length === 0} onClick={() => onSalvar(texto.trim())}>
          {t("Salvar seção")}
        </Button>
        {secao.editada ? (
          <Button size="sm" variant="outline" disabled={ocupado} onClick={onRestaurar}>
            {t("Voltar ao texto do modelo")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function DocumentoCanvas({ propostaId, podeRevisar = false, emRascunho = false, versao = 0, onModeloConfirmado }: DocumentoCanvasProps) {
  const t = useT();
  const [doc, setDoc] = useState<Documento | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const [modelosDisponiveis, setModelosDisponiveis] = useState<ModeloDisponivel[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .get<ApiSuccess<ModeloDisponivel[]>>("/api/v1/settings/proposal-templates", { signal: controller.signal })
      .then((res) => !controller.signal.aborted && setModelosDisponiveis(res.data))
      .catch(() => {
        /* sem a lista, o seletor cai nos 8 da plataforma — nunca some */
      });
    return () => controller.abort();
  }, []);

  const opcoesDeModelo = opcoesVisiveis(modelosDisponiveis, doc?.modeloSlug ?? doc?.modeloSlugSugerido ?? null, t);

  const [sugestoes, setSugestoes] = useState<Record<string, string>>({});
  const [preenchendo, setPreenchendo] = useState(false);
  const [avisoDeSugestao, setAvisoDeSugestao] = useState<string | null>(null);

  async function preencherComConversa() {
    setPreenchendo(true);
    setAvisoDeSugestao(null);
    try {
      const res = await apiClient.post<
        ApiSuccess<{ disponivel: boolean; motivo: string | null; sugestoes: Array<{ campo: string; rotulo: string; valor: string }> }>
      >(`/api/v1/proposals/${propostaId}/preencher-com-conversa`, {});
      if (!res.data.disponivel) {
        setAvisoDeSugestao(res.data.motivo ?? t("A IA não está disponível agora."));
        return;
      }
      if (res.data.sugestoes.length === 0) {
        setAvisoDeSugestao(t("A conversa não respondeu nenhum dos campos que faltam."));
        return;
      }
      setSugestoes(Object.fromEntries(res.data.sugestoes.map((s) => [s.campo, s.valor])));
    } catch (error) {
      showApiError(error);
    } finally {
      setPreenchendo(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .get<ApiSuccess<Documento>>(`/api/v1/proposals/${propostaId}/documento`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setDoc(res.data);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        showApiError(error);
      });
    return () => controller.abort();
  }, [propostaId, versao, recarga]);

  async function executar(acao: () => Promise<unknown>): Promise<boolean> {
    setOcupado(true);
    try {
      await acao();
      setRecarga((n) => n + 1);
      return true;
    } catch (error) {
      showApiError(error);
      return false;
    } finally {
      setOcupado(false);
    }
  }

  const confirmarModelo = async (slug: string, descartar = false) => {
    const ok = await executar(() =>
      apiClient.patch(
        `/api/v1/proposals/${propostaId}/modelo`,
        descartar ? { template_slug: slug, descartar_reescritas: true } : { template_slug: slug },
      ),
    );
    if (ok) onModeloConfirmado?.(slug);
  };

  if (!doc) return null;

  const secoes = doc.secoes ?? [];
  const camposFaltando = doc.camposFaltando ?? [];
  // Resposta de rota antiga (sem camposFaltando) ainda conta pelas ocorrências.
  const totalDePendencias = camposFaltando.length > 0 ? camposFaltando.length : (doc.variaveisFaltando ?? []).length;
  const editavel = podeRevisar && emRascunho;

  if (!doc.modeloSlug) {
    const rotuloSugerido = doc.modeloSlugSugerido ? opcoesDeModelo.find(([s]) => s === doc.modeloSlugSugerido)?.[1] : null;
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm text-gray-600 space-y-3">
        {doc.modeloSlugSugerido ? (
          <p>
            {t("A IA sugeriu o modelo")} <strong>{rotuloSugerido ?? doc.modeloSlugSugerido}</strong>.
          </p>
        ) : (
          <p>{t("Nenhum modelo escolhido para esta proposta ainda.")}</p>
        )}
        <div className="flex items-center gap-2">
          {doc.modeloSlugSugerido && (
            <button
              type="button"
              disabled={ocupado}
              onClick={() => void confirmarModelo(doc.modeloSlugSugerido!)}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {t("Usar este modelo")}
            </button>
          )}
          <select
            disabled={ocupado}
            defaultValue=""
            onChange={(e) => e.target.value && void confirmarModelo(e.target.value)}
            className="rounded-md border px-2 py-1.5 text-sm"
          >
            <option value="" disabled>
              {t("Ou escolha outro modelo")}
            </option>
            {opcoesDeModelo.map(([slug, rotulo]) => (
              <option key={slug} value={slug}>
                {rotulo}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  const trocarModelo = (slug: string) => {
    if (!slug || slug === doc.modeloSlug) return;
    if (doc.temSecaoEditada) {
      if (!window.confirm(t("Trocar o modelo descarta as seções reescritas à mão. Continuar?"))) return;
      void confirmarModelo(slug, true);
      return;
    }
    void confirmarModelo(slug);
  };

  return (
    <div className="rounded-lg border p-4 space-y-4">
      {editavel && (
        <div className="flex items-center gap-2 text-sm">
          <span>{t("Modelo do documento")}</span>
          <select
            aria-label={t("Modelo do documento")}
            disabled={ocupado}
            value={doc.modeloSlug}
            onChange={(e) => trocarModelo(e.target.value)}
            className="rounded-md border px-2 py-1.5 text-sm"
          >
            {opcoesDeModelo.map(([slug, rotulo]) => (
              <option key={slug} value={slug}>
                {rotulo}
              </option>
            ))}
          </select>
        </div>
      )}

      {totalDePendencias > 0 && (
        <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
          <p className="font-medium">
            {t("Não é possível enviar")} — {totalDePendencias} {t("pendência(s)")}
          </p>
          {camposFaltando.length > 0 && (
            <>
              <p>{t("O que falta preencher:")}</p>
              {editavel && camposFaltando.some((c) => c.onde === "briefing") && (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={preenchendo || ocupado} onClick={preencherComConversa}>
                    {preenchendo ? t("Lendo a conversa…") : t("Preencher com a conversa")}
                  </Button>
                  {avisoDeSugestao && <span className="text-gray-500">{avisoDeSugestao}</span>}
                </div>
              )}
              <ul className="space-y-2">
                {camposFaltando.map((c) => (
                  <CampoQueFalta
                    key={`${c.caminho}:${sugestoes[c.caminho] ?? ""}`}
                    campo={c}
                    editavel={editavel}
                    ocupado={ocupado}
                    valorInicial={sugestoes[c.caminho]}
                    t={t}
                    onPreencher={(valor) =>
                      executar(() => apiClient.patch(`/api/v1/proposals/${propostaId}/documento`, { campo: c.caminho, valor }))
                    }
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="space-y-4">
        {secoes.map((s) =>
          editavel ? (
            <EditorDeSecao
              key={`${s.id}:${s.body}`}
              secao={s}
              ocupado={ocupado}
              t={t}
              onSalvar={(texto) =>
                executar(() => apiClient.patch(`/api/v1/proposals/${propostaId}/documento`, { secaoId: s.id, texto }))
              }
              onRestaurar={() =>
                executar(() => apiClient.patch(`/api/v1/proposals/${propostaId}/documento`, { secaoId: s.id, texto: null }))
              }
            />
          ) : (
            <div key={s.id}>
              <div className="text-sm font-semibold">{s.title}</div>
              <div className="text-sm whitespace-pre-wrap">{s.body}</div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
