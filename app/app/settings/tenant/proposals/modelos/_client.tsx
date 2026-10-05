"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { ApiSuccess } from "@/lib/api/wrappers";

interface ModeloListado {
  slug: string;
  nome: string;
  origem: "plataforma" | "personalizado" | "empresa";
  secoes: number;
  version: number;
  oculto?: boolean;
}

const ROTULO_DA_ORIGEM: Record<ModeloListado["origem"], string> = {
  plataforma: "Da plataforma",
  personalizado: "Personalizado",
  empresa: "Da empresa",
};

export const CHAVE_DO_MODELO_IMPORTADO = "modelo-importado";

export function ModelosDeProposta() {
  const t = useT();
  const router = useRouter();
  const salvo = useSearchParams().get("salvo");
  const [faixaFechada, setFaixaFechada] = useState(false);
  const [modelos, setModelos] = useState<ModeloListado[] | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [andamento, setAndamento] = useState<string | null>(null);
  const [nomeNovo, setNomeNovo] = useState("");
  const [recarga, setRecarga] = useState(0);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [propostasDesligadas, setPropostasDesligadas] = useState(false);
  const arquivo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .get<ApiSuccess<ModeloListado[]>>("/api/v1/settings/proposal-templates", { signal: controller.signal })
      .then((res) => !controller.signal.aborted && setModelos(res.data))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        // Com as propostas desligadas na organização, a rota responde 404
        // `not_found` (lib/propostas/porta.ts): a tela mora num local que a
        // empresa não habilitou. Em vez do toast cru e do "Carregando…"
        // infinito, um estado próprio com o caminho para ligar.
        if (e instanceof ApiError && e.code === "not_found") {
          setPropostasDesligadas(true);
          return;
        }
        showApiError(e);
      });
    return () => controller.abort();
  }, [recarga]);

  async function acao(fn: () => Promise<unknown>) {
    setOcupado(true);
    try {
      await fn();
      setRecarga((n) => n + 1);
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  async function importar(file: File) {
    setOcupado(true);
    setMensagem(null);
    setAndamento(t("Lendo o arquivo…"));
    const avisoDeIa = setTimeout(
      () => setAndamento(t("A IA está montando as seções (pode levar até um minuto)…")),
      3000,
    );
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/v1/settings/proposal-templates/importar", { method: "POST", body: form, credentials: "same-origin" });
      // O proxy pode cortar a resposta por tempo e devolver corpo que não é
      // JSON: sem esta guarda o `res.json()` lançava e a tela ficava em
      // silêncio, com o botão preso em "ocupado".
      const corpo = (await res.json().catch(() => null)) as {
        data?: { disponivel: boolean; motivo?: string; modelo?: unknown };
        error?: { message: string };
      } | null;
      if (!corpo) {
        setMensagem(t("A leitura demorou demais e foi interrompida. Tente de novo; se repetir, envie um arquivo menor."));
        return;
      }
      if (!res.ok) {
        setMensagem(corpo.error?.message ?? t("Não consegui ler este arquivo."));
        return;
      }
      if (!corpo.data?.disponivel) {
        setMensagem(corpo.data?.motivo ?? t("A IA não está disponível agora."));
        return;
      }
      if (!corpo.data.modelo) {
        setMensagem(t("A IA não conseguiu montar um modelo com este arquivo."));
        return;
      }
      try {
        window.sessionStorage.setItem(CHAVE_DO_MODELO_IMPORTADO, JSON.stringify(corpo.data.modelo));
      } catch {
        setMensagem(t("O navegador bloqueou o armazenamento temporário; libere e tente de novo."));
        return;
      }
      router.push("/app/settings/tenant/proposals/modelos/novo");
    } finally {
      clearTimeout(avisoDeIa);
      setAndamento(null);
      setOcupado(false);
    }
  }

  if (propostasDesligadas) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3 p-6">
        <h1 className="text-xl font-semibold">{t("Modelos de proposta")}</h1>
        <p>
          {t("As propostas estão desligadas para esta organização. Para editar os modelos, ligue as propostas em Configurações › Propostas e salve.")}
        </p>
        <Button asChild variant="outline">
          <Link href="/app/settings/tenant/proposals">{t("Ir para Configurações › Propostas")}</Link>
        </Button>
      </div>
    );
  }

  if (!modelos) return <div className="p-6">{t("Carregando…")}</div>;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <h1 className="text-xl font-semibold">{t("Modelos de proposta")}</h1>

      {salvo && !faixaFechada ? (
        <p role="status" className="flex items-center justify-between gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          <span>{t("Modelo «{nome}» salvo.").replace("{nome}", salvo)}</span>
          <button type="button" aria-label={t("Fechar")} onClick={() => setFaixaFechada(true)} className="rounded-md px-2 py-0.5 hover:bg-green-100">
            ×
          </button>
        </p>
      ) : null}

      <section className="space-y-2 rounded-lg border p-4">
        <h2 className="font-medium">{t("Criar a partir da proposta que a empresa já usa")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Envie um PDF, .md ou .txt de até 5 MB. A IA divide em seções, troca por campos o que muda de um cliente e de um projeto para outro, e você revisa antes de salvar.")}
        </p>
        <input
          ref={arquivo}
          type="file"
          accept=".pdf,.md,.txt,application/pdf,text/plain,text/markdown"
          aria-label={t("Arquivo da proposta")}
          disabled={ocupado}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importar(f);
            e.target.value = "";
          }}
        />
        {ocupado && andamento ? <p role="status" className="text-sm text-muted-foreground">{andamento}</p> : null}
        {mensagem ? <p role="alert" className="text-sm text-red-700">{mensagem}</p> : null}
      </section>

      <section className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1 space-y-1">
          <span className="text-sm font-medium">{t("Novo modelo em branco")}</span>
          <Input value={nomeNovo} onChange={(e) => setNomeNovo(e.target.value)} placeholder={t("Ex.: Locação por temporada")} />
        </label>
        <Button
          disabled={ocupado || nomeNovo.trim().length < 2}
          onClick={() =>
            acao(async () => {
              const res = await apiClient.post<ApiSuccess<{ slug: string }>>("/api/v1/settings/proposal-templates", { acao: "novo", nome: nomeNovo.trim() });
              router.push(`/app/settings/tenant/proposals/modelos/${res.data.slug}`);
            })
          }
        >
          {t("Criar")}
        </Button>
      </section>

      <ul className="divide-y rounded-lg border">
        {modelos.map((m) => (
          <li key={m.slug} className="flex flex-wrap items-center justify-between gap-2 p-3">
            <div>
              <div className="font-medium">{m.nome}</div>
              <div className="text-xs text-muted-foreground">
                {t(ROTULO_DA_ORIGEM[m.origem])} · {m.secoes} {t("seções")}
              </div>
              {m.oculto ? (
                <div className="text-xs text-muted-foreground">
                  {t("Desligado — não aparece para a IA nem no seletor")}
                </div>
              ) : null}
            </div>
            <div className="flex gap-2">
              {(m.origem === "plataforma" || m.origem === "personalizado") && (
                <Button size="sm" variant="outline" disabled={ocupado}
                  onClick={() => acao(() =>
                    apiClient.post("/api/v1/settings/proposal-templates", {
                      acao: m.oculto ? "mostrar" : "ocultar",
                      slug: m.slug,
                    }),
                  )}>
                  {m.oculto ? t("Usar") : t("Não usar")}
                </Button>
              )}
              {m.origem === "plataforma" ? (
                <Button size="sm" variant="outline" disabled={ocupado}
                  onClick={() => acao(async () => {
                    await apiClient.post("/api/v1/settings/proposal-templates", { acao: "personalizar", base_slug: m.slug });
                    router.push(`/app/settings/tenant/proposals/modelos/${m.slug}`);
                  })}>
                  {t("Personalizar")}
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/app/settings/tenant/proposals/modelos/${m.slug}`}>{t("Editar")}</Link>
                  </Button>
                  <Button size="sm" variant="ghost" disabled={ocupado}
                    onClick={() => {
                      const pergunta = m.origem === "personalizado"
                        ? t("Voltar ao modelo da plataforma? As mudanças da empresa deixam de valer nas próximas propostas.")
                        : t("Remover este modelo? As propostas já enviadas não mudam.");
                      if (window.confirm(pergunta)) void acao(() => apiClient.delete(`/api/v1/settings/proposal-templates/${m.slug}`));
                    }}>
                    {m.origem === "personalizado" ? t("Voltar ao modelo da plataforma") : t("Remover")}
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
