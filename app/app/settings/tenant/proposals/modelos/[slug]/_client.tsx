"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { ApiSuccess } from "@/lib/api/wrappers";
import {
  rotuloDaVariavel,
  rotulosDoNegocio,
  type CampoDoFunilParaRotulo,
} from "@/lib/propostas/documento/rotulos-das-variaveis";
import { CHAVE_DO_MODELO_IMPORTADO } from "../_client";

interface Secao { id: string; title: string; body: string; required: boolean; conditional: boolean }
interface Modelo { nome: string; descricao: string | null; sections: Secao[]; sectionOrder: string[]; origem?: string }

const VARIAVEL = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

/**
 * O nome legível de uma variável na tela.
 *
 * Rótulo de campo do funil é TEXTO QUE A EMPRESA DIGITOU: passa direto, sem
 * `t()` — traduzir dado do operador mudaria o dado na tela. Só o rótulo que o
 * produto define (`ROTULO_DA_VARIAVEL`) é traduzido.
 */
function RotuloDaVariavel({ caminho, rotulos }: { caminho: string; rotulos: Record<string, string> }) {
  const t = useT();
  const doFunil = rotulos[caminho];
  if (doFunil !== undefined) return <>{doFunil}</>;
  return <>{t(rotuloDaVariavel(caminho))}</>;
}

/** Variável que o sistema preenche sozinho — nunca é pergunta ao cliente. */
function ehCalculadaPeloSistema(caminho: string): boolean {
  return (
    caminho.startsWith("investment.") ||
    caminho.startsWith("commercial_terms.") ||
    caminho.startsWith("approval.") ||
    // `{{lead.<chave>}}` vem do CARD do negócio (#4533), não da conversa.
    caminho === "lead" ||
    caminho.startsWith("lead.") ||
    caminho === "client.name" ||
    caminho === "client.company_or_name"
  );
}

function idLivre(secoes: Secao[]): string {
  let n = secoes.length + 1;
  while (secoes.some((s) => s.id === `secao_${n}`)) n++;
  return `secao_${n}`;
}

export function EditorDeModelo({
  slug,
  camposDoFunil = [],
}: {
  slug: string;
  /** Os campos do negócio com o rótulo da empresa (#4533) — lidos no servidor. */
  camposDoFunil?: CampoDoFunilParaRotulo[];
}) {
  const t = useT();
  const router = useRouter();
  const [modelo, setModelo] = useState<Modelo | null>(null);
  const [erros, setErros] = useState<Array<{ campo: string; mensagem: string }>>([]);
  const [ocupado, setOcupado] = useState(false);
  const importado = slug === "novo";

  const rotulosDoNegocioDoFunil = useMemo(() => rotulosDoNegocio(camposDoFunil), [camposDoFunil]);

  useEffect(() => {
    if (importado) {
      try {
        const bruto = window.sessionStorage.getItem(CHAVE_DO_MODELO_IMPORTADO);
        if (bruto) {
          const m = JSON.parse(bruto) as Modelo;
          setModelo({ ...m, descricao: m.descricao ?? null, sections: m.sections.map((s) => ({ ...s })), sectionOrder: m.sectionOrder });
          return;
        }
      } catch {
        /* sem armazenamento: cai no aviso abaixo */
      }
      setModelo({ nome: "", descricao: null, sections: [], sectionOrder: [] });
      return;
    }
    const controller = new AbortController();
    apiClient
      .get<ApiSuccess<Modelo>>(`/api/v1/settings/proposal-templates/${slug}`, { signal: controller.signal })
      .then((res) => !controller.signal.aborted && setModelo(res.data))
      .catch((e: unknown) => !controller.signal.aborted && showApiError(e));
    return () => controller.abort();
  }, [slug, importado]);

  const variaveisUsadas = useMemo(() => {
    const achadas = new Set<string>();
    for (const s of modelo?.sections ?? []) for (const m of s.body.matchAll(VARIAVEL)) achadas.add(m[1]!);
    return [...achadas];
  }, [modelo]);

  /**
   * C4 — o que o sistema calcula sozinho não é pergunta ao cliente: sai do
   * quadro "Este modelo vai pedir ao cliente:". O resto (briefing, prazo,
   * itens, contato) é o que a IA vai precisar perguntar.
   */
  const pedidasAoCliente = useMemo(
    () => variaveisUsadas.filter((v) => !ehCalculadaPeloSistema(v)),
    [variaveisUsadas],
  );

  if (!modelo) return <div className="p-6">{t("Carregando…")}</div>;
  const somenteLeitura = modelo.origem === "plataforma";

  const mudarSecao = (i: number, patch: Partial<Secao>) =>
    setModelo((m) => m && { ...m, sections: m.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const mover = (i: number, delta: -1 | 1) =>
    setModelo((m) => {
      if (!m) return m;
      const j = i + delta;
      if (j < 0 || j >= m.sections.length) return m;
      const s = [...m.sections];
      [s[i], s[j]] = [s[j]!, s[i]!];
      return { ...m, sections: s };
    });

  async function salvar() {
    if (!modelo) return;
    setOcupado(true);
    setErros([]);
    const corpo = {
      nome: modelo.nome,
      descricao: modelo.descricao,
      sections: modelo.sections,
      section_order: modelo.sections.map((s) => s.id),
    };
    try {
      if (importado) {
        await apiClient.post<ApiSuccess<{ slug: string }>>("/api/v1/settings/proposal-templates", { acao: "novo", ...corpo });
        try { window.sessionStorage.removeItem(CHAVE_DO_MODELO_IMPORTADO); } catch { /* ignore */ }
        router.push(`/app/settings/tenant/proposals/modelos?salvo=${encodeURIComponent(modelo.nome)}`);
      } else {
        await apiClient.patch(`/api/v1/settings/proposal-templates/${slug}`, corpo);
        router.push(`/app/settings/tenant/proposals/modelos?salvo=${encodeURIComponent(modelo.nome)}`);
      }
    } catch (e) {
      const detalhes = (e as { details?: { erros?: Array<{ campo: string; mensagem: string }> } }).details;
      if (detalhes?.erros) setErros(detalhes.erros);
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 p-6 lg:grid-cols-[1fr_16rem]">
      <div className="space-y-4">
        {importado && modelo.sections.length === 0 ? (
          <p role="alert" className="text-sm text-amber-800">{t("O modelo importado não está mais disponível. Envie o arquivo de novo.")}</p>
        ) : null}
        {somenteLeitura ? (
          <p className="text-sm text-muted-foreground">{t("Este é um modelo da plataforma. Personalize-o na lista para editar.")}</p>
        ) : null}
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("Nome do modelo")}</span>
          <Input value={modelo.nome} disabled={somenteLeitura} onChange={(e) => setModelo({ ...modelo, nome: e.target.value })} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("Para que serve (opcional)")}</span>
          <Input value={modelo.descricao ?? ""} disabled={somenteLeitura} onChange={(e) => setModelo({ ...modelo, descricao: e.target.value || null })} />
        </label>

        {erros.length > 0 ? (
          <ul role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {erros.map((e, i) => <li key={i}>{t(e.mensagem)}</li>)}
          </ul>
        ) : null}

        {pedidasAoCliente.length > 1 ? (
          <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
            <p className="font-medium">{t("Este modelo vai pedir ao cliente:")}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {pedidasAoCliente.map((v) => (
                <li key={v}><code className="text-xs">{`{{${v}}}`}</code> — <RotuloDaVariavel caminho={v} rotulos={rotulosDoNegocioDoFunil} /></li>
              ))}
            </ul>
          </div>
        ) : (
          <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {t("Este modelo quase não pede nada ao cliente: a IA não saberá o que perguntar. Troque por {{campo}} o que muda de um projeto para outro.")}
          </p>
        )}

        {modelo.sections.map((s, i) => (
          <div key={`${s.id}-${i}`} className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label={t("Título da seção")} value={s.title} disabled={somenteLeitura} onChange={(e) => mudarSecao(i, { title: e.target.value })} className="flex-1" />
              {!somenteLeitura ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => mover(i, -1)} aria-label={t("Subir seção")}>↑</Button>
                  <Button size="sm" variant="ghost" onClick={() => mover(i, 1)} aria-label={t("Descer seção")}>↓</Button>
                  <Button size="sm" variant="ghost" onClick={() => setModelo({ ...modelo, sections: modelo.sections.filter((_, j) => j !== i) })}>{t("Remover")}</Button>
                </>
              ) : null}
            </div>
            <Textarea aria-label={t("Texto da seção")} value={s.body} disabled={somenteLeitura} rows={4} onChange={(e) => mudarSecao(i, { body: e.target.value })} />
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={s.required} disabled={somenteLeitura} onChange={(e) => mudarSecao(i, { required: e.target.checked, conditional: e.target.checked ? false : s.conditional })} />
                {t("Obrigatória")}
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={s.conditional} disabled={somenteLeitura} onChange={(e) => mudarSecao(i, { conditional: e.target.checked, required: e.target.checked ? false : s.required })} />
                {t("Só aparece se tiver dado")}
              </label>
            </div>
          </div>
        ))}

        {!somenteLeitura ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setModelo({ ...modelo, sections: [...modelo.sections, { id: idLivre(modelo.sections), title: "", body: "", required: true, conditional: false }] })}>
              {t("+ Seção")}
            </Button>
            <Button onClick={salvar} disabled={ocupado}>{ocupado ? t("Salvando…") : t("Salvar modelo")}</Button>
          </div>
        ) : null}
      </div>

      <aside className="space-y-2 text-sm">
        <h2 className="font-medium">{t("Campos usados")}</h2>
        <p className="text-xs text-muted-foreground">{t("Escreva {{campo}} no texto; a proposta troca pelo valor de cada cliente.")}</p>
        <ul className="space-y-1">
          {variaveisUsadas.map((v) => (
            <li key={v}><code className="text-xs">{`{{${v}}}`}</code> — <RotuloDaVariavel caminho={v} rotulos={rotulosDoNegocioDoFunil} /></li>
          ))}
        </ul>
        {camposDoFunil.length > 0 ? (
          <div className="space-y-1 pt-2">
            <h2 className="font-medium">{t("Campos do negócio")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("Vêm do card do negócio: quem preenche é o funil, não a proposta.")}
            </p>
            <ul className="space-y-1">
              {Object.keys(rotulosDoNegocioDoFunil).map((variavel) => (
                <li key={variavel}>
                  <code className="text-xs">{`{{${variavel}}}`}</code> — <RotuloDaVariavel caminho={variavel} rotulos={rotulosDoNegocioDoFunil} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
