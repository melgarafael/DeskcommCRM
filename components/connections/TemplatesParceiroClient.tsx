"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/types";
import { PencilSimple, Trash } from "@/lib/ui/icons";
import { PreviaDaDefinicao } from "./PreviaDaDefinicao";
import { DialogoDeApagarModelo, type AlvoDoApagamento } from "./DialogoDeApagarModelo";
import { FormularioDaDefinicao, type CorpoDoModelo, type ModeloEmEdicao } from "./FormularioDaDefinicao";
import { apiClient } from "@/lib/api/client";
import { lerConteudo, paraFormulario } from "@/lib/channels/template-conteudo";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";

/**
 * As definições aprovadas do canal intermediado.
 *
 * ─── Por que esta tela não existia ─────────────────────────────────────────
 *
 * A aba "Templates da Meta" vive dentro do canal OFICIAL, e o endpoint dela
 * resolve a conexão por `metaSessionForOrg`. Numa instalação que só tem o canal
 * intermediado, o operador não tinha nem a aba nem a lista — e o seletor do
 * inbox dizia "nenhum modelo aprovado ainda" para uma conta cheia deles.
 *
 * O adapter já sabia listar, criar, editar e apagar desde que o canal entrou. O
 * que faltava era a porta.
 *
 * ─── Sincronizar é explícito, não automático ───────────────────────────────
 *
 * A lista mostra o ESPELHO — instantâneo, e é o que o resto do CRM lê. Puxar da
 * plataforma é um botão porque é chamada de rede que pode demorar, e porque
 * sincronizar sozinho ao abrir a tela esconderia a diferença entre "não tenho
 * nenhuma" e "não consegui perguntar".
 *
 * ─── O formulário e o diálogo de apagar são COMPARTILHADOS (#3635) ──────────
 *
 * Saíram daqui para `FormularioDaDefinicao`/`DialogoDeApagarModelo` quando o
 * canal oficial direto passou a gerenciar modelo pela tela: as duas telas fazem
 * a mesma coisa na mesma API, e duas cópias envelheceriam separadas.
 */
interface TemplateParceiro {
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejectedReason: string | null;
  syncedAt: string;
  components: unknown[];
}

const COR_DO_ESTADO: Record<string, string> = {
  APPROVED: "text-emerald-700 dark:text-emerald-400",
  PENDING: "text-amber-700 dark:text-amber-400",
  REJECTED: "text-destructive",
  PAUSED: "text-amber-700 dark:text-amber-400",
  DISABLED: "text-muted-foreground",
};

/**
 * Modelos do parceiro. `rota` permite reusar o MESMO componente para um segundo
 * parceiro Graph-compatível sem duplicar a tela — o default é a rota do parceiro
 * por credencial, e a aba nova passa a dela.
 */
export function TemplatesParceiroClient({
  rota = "/api/v1/channels/partner/templates",
  gerenciar = true,
}: {
  rota?: string;
  /** Mostra Editar/Apagar no modelo aberto. A prévia aparece sempre. */
  gerenciar?: boolean;
} = {}) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const qc = useQueryClient();
  const [criando, setCriando] = useState(false);
  const [aberto, setAberto] = useState<string | null>(null);
  // EDITAR reusa o formulário de criar, já preenchido com o texto aprovado.
  const [editando, setEditando] = useState<ModeloEmEdicao | null>(null);
  // APAGAR em dois passos: confirmar, e — se o modelo está em uso num follow-up
  // ou no prompt do agente — ver ONDE antes de confirmar de novo.
  const [apagando, setApagando] = useState<AlvoDoApagamento | null>(null);
  const formulario = useRef<HTMLDivElement>(null);

  const limparFormulario = () => {
    setCriando(false);
    setEditando(null);
  };

  const abrirEdicao = (tpl: TemplateParceiro) => {
    setEditando({
      name: tpl.name,
      language: tpl.language,
      category: tpl.category,
      components: tpl.components,
    });
    setCriando(true);
    requestAnimationFrame(() => formulario.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const lista = useQuery({
    queryKey: ["partner-templates", rota],
    queryFn: async () =>
      apiClient.get<{ data: { templates: TemplateParceiro[] } }>(rota),
  });

  const acao = useMutation({
    // A MESMA rota responde a sincronizar e à gestão: o corpo é a união das duas
    // formas, e é a rota que valida.
    mutationFn: async (corpoReq: CorpoDoModelo | { acao: "sincronizar" }) =>
      apiClient.post<{ data: { sincronizadas: number; total: number } }>(rota, corpoReq),
    onSuccess: (r, corpoReq) => {
      qc.invalidateQueries({ queryKey: ["partner-templates"] });
      // Invalida também o seletor do inbox: sem isto o operador sincroniza aqui,
      // volta à conversa e o seletor segue dizendo que não há nenhuma.
      qc.invalidateQueries({ queryKey: ["channel-templates"] });
      // E a lista do construtor de follow-up, que oferece os aprovados.
      qc.invalidateQueries({ queryKey: ["followup-modelos-aprovados"] });
      toast.success(
        corpoReq.acao === "editar"
          ? t("Modelo atualizado e enviado para revisão.")
          : `${r.data.sincronizadas} ${t("de")} ${r.data.total} ${t("sincronizada(s).")}`,
      );
      limparFormulario();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? t(e.message) : t("Não consegui falar com a plataforma.")),
  });

  const apagar = useMutation({
    mutationFn: async (v: { alvo: AlvoDoApagamento; confirmado: boolean }) =>
      apiClient.post<{ data: { sincronizadas: number; total: number } }>(rota, {
        acao: "apagar",
        name: v.alvo.name,
        language: v.alvo.language,
        confirmado: v.confirmado,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["partner-templates"] });
      qc.invalidateQueries({ queryKey: ["channel-templates"] });
      qc.invalidateQueries({ queryKey: ["followup-modelos-aprovados"] });
      toast.success(t("Modelo apagado."));
      setApagando(null);
      setAberto(null);
    },
    onError: (e: unknown, v) => {
      if (e instanceof ApiError && e.code === "template_in_use") {
        const usos = Array.isArray(e.details?.usos) ? (e.details.usos as string[]) : [];
        setApagando({ ...v.alvo, usos });
        return;
      }
      toast.error(e instanceof Error ? t(e.message) : t("Não consegui falar com a plataforma."));
    },
  });

  const templates = lista.data?.data.templates ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {t(
            "O que a plataforma aprovou para este número. É daqui que sai a mensagem quando a janela de 24h fecha.",
          )}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => acao.mutate({ acao: "sincronizar" })}
            disabled={acao.isPending}
          >
            {acao.isPending ? t("Sincronizando…") : t("Sincronizar")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => (criando ? limparFormulario() : setCriando(true))}
          >
            {criando ? t("Cancelar") : t("Criar modelo")}
          </Button>
        </div>
      </div>

      {criando && (
        <div ref={formulario}>
          <FormularioDaDefinicao
            // A `key` remonta o formulário ao trocar de alvo: nascer do modelo
            // escolhido, e não carregar o texto do anterior.
            key={editando ? `${editando.name}:${editando.language}` : "novo"}
            editando={editando}
            salvando={acao.isPending}
            onEnviar={(corpo) => acao.mutate(corpo)}
          />
        </div>
      )}

      {lista.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("Nenhum modelo espelhado ainda. Clique em")} <strong>{t("Sincronizar")}</strong>{" "}
          {t("para trazer os que já existem na plataforma.")}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {templates.map((tpl) => {
            const chave = `${tpl.name}|${tpl.language}`;
            const c = lerConteudo(tpl.components);
            const f = paraFormulario(c);
            const expandido = aberto === chave;
            return (
              <li key={chave} className="px-3 py-2">
                {/* A linha inteira ABRE o conteúdo. Ver "APPROVED" sem ver o
                    texto obriga a abrir a plataforma para saber o que a
                    definição diz — e é o texto que decide qual mandar. */}
                <button
                  type="button"
                  onClick={() => setAberto(expandido ? null : chave)}
                  className="flex w-full flex-wrap items-center gap-2 text-left"
                  aria-expanded={expandido}
                >
                  <span className="font-mono text-sm">{tpl.name}</span>
                  <span className="text-xs text-muted-foreground">{tpl.language}</span>
                  {tpl.category && (
                    <span className="rounded-md bg-muted px-1.5 text-[10px] uppercase text-muted-foreground">
                      {tpl.category}
                    </span>
                  )}
                  {c.variaveis > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {c.variaveis} {t("valor(es)")}
                    </span>
                  )}
                  <span
                    className={cn(
                      "ml-auto text-xs font-medium",
                      COR_DO_ESTADO[tpl.status?.toUpperCase()] ?? "text-muted-foreground",
                    )}
                  >
                    {tpl.status}
                  </span>
                </button>

                {/* O motivo da recusa é o que diz o que corrigir, e fica SEMPRE
                    à vista — não escondido atrás do clique: quem precisa dele
                    não sabe que precisa procurar. */}
                {tpl.rejectedReason && (
                  <p className="mt-1 text-[11px] text-destructive">{tpl.rejectedReason}</p>
                )}

                {expandido && (
                  <div className="mt-2 flex flex-col gap-2" data-modelo-aberto={tpl.name}>
                    {c.body ? (
                      <PreviaDaDefinicao
                        cabecalho={f.cabecalho}
                        midiaUrl={f.midiaUrl}
                        corpo={f.corpo}
                        rodape={f.rodape}
                        botoes={f.botoes}
                      />
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {t("Sem corpo espelhado — sincronize para trazer o conteúdo.")}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {gerenciar && (
                        <>
                          <Button type="button" variant="outline" size="sm" onClick={() => abrirEdicao(tpl)}>
                            <PencilSimple size={14} className="mr-1.5" aria-hidden />
                            {t("Editar")}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setApagando({ name: tpl.name, language: tpl.language, usos: null })}
                          >
                            <Trash size={14} className="mr-1.5" aria-hidden />
                            {t("Apagar")}
                          </Button>
                        </>
                      )}
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {t("Sincronizado em")} {new Date(tpl.syncedAt).toLocaleString(tagDoIdioma)}
                      </span>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <DialogoDeApagarModelo
        alvo={apagando}
        apagando={apagar.isPending}
        onCancelar={() => setApagando(null)}
        onConfirmar={(confirmado) => apagando && apagar.mutate({ alvo: apagando, confirmado })}
      />
    </div>
  );
}
