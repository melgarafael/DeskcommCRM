"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { ApiError } from "@/lib/api/types";
import { PencilSimple, Trash } from "@/lib/ui/icons";
import { PreviaDaDefinicao } from "./PreviaDaDefinicao";
import { apiClient } from "@/lib/api/client";
import {
  contarVariaveis,
  IDIOMAS_DA_DEFINICAO,
  lerConteudo,
  LIMITE_BOTOES,
  LIMITE_CORPO,
  LIMITE_RODAPE,
  montarComponents,
  paraFormulario,
  type BotaoDaDefinicao,
} from "@/lib/channels/template-conteudo";
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
  const [nome, setNome] = useState("");
  const [idioma, setIdioma] = useState("es");
  const [categoria, setCategoria] = useState("UTILITY");
  const [corpo, setCorpo] = useState("");
  const [rodape, setRodape] = useState("");
  const [exemplos, setExemplos] = useState<string[]>([]);
  const [cabecalho, setCabecalho] = useState("");
  const [midiaUrl, setMidiaUrl] = useState("");
  const [botoes, setBotoes] = useState<BotaoDaDefinicao[]>([]);
  const [subindo, setSubindo] = useState(false);
  const [aberto, setAberto] = useState<string | null>(null);
  // EDITAR reusa o formulário de criar, já preenchido com o texto aprovado. Nome,
  // idioma e categoria ficam travados: a plataforma não deixa mudá-los depois de
  // criado, e oferecer o campo seria prometer uma edição que ela recusa.
  const [editando, setEditando] = useState<{ name: string; language: string } | null>(null);
  // APAGAR em dois passos: confirmar, e — se o modelo está em uso num follow-up
  // ou no prompt do agente — ver ONDE antes de confirmar de novo.
  const [apagando, setApagando] = useState<{ tpl: TemplateParceiro; usos: string[] | null } | null>(null);
  const formulario = useRef<HTMLDivElement>(null);

  const limparFormulario = () => {
    setCriando(false);
    setEditando(null);
    setNome("");
    setCorpo("");
    setRodape("");
    setExemplos([]);
    setCabecalho("");
    setMidiaUrl("");
    setBotoes([]);
    setCategoria("UTILITY");
  };

  const abrirEdicao = (tpl: TemplateParceiro) => {
    const f = paraFormulario(lerConteudo(tpl.components));
    setEditando({ name: tpl.name, language: tpl.language });
    setNome(tpl.name);
    setIdioma(tpl.language);
    setCategoria(tpl.category ?? "UTILITY");
    setCabecalho(f.cabecalho);
    setMidiaUrl(f.midiaUrl);
    setCorpo(f.corpo);
    setRodape(f.rodape);
    setExemplos(f.exemplos);
    setBotoes(f.botoes);
    setCriando(true);
    requestAnimationFrame(() => formulario.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  // Quantas amostras a revisão vai exigir. Recalculado enquanto se digita: o
  // operador vê o campo aparecer no instante em que escreve `{{1}}`, e não
  // descobre a exigência numa recusa que chega horas depois.
  const nVariaveis = contarVariaveis(corpo);

  const lista = useQuery({
    queryKey: ["partner-templates", rota],
    queryFn: async () =>
      apiClient.get<{ data: { templates: TemplateParceiro[] } }>(rota),
  });

  const acao = useMutation({
    mutationFn: async (corpoReq: Record<string, unknown>) =>
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
    mutationFn: async (v: { tpl: TemplateParceiro; confirmado: boolean }) =>
      apiClient.post<{ data: { sincronizadas: number; total: number } }>(rota, {
        acao: "apagar",
        name: v.tpl.name,
        language: v.tpl.language,
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
        setApagando({ tpl: v.tpl, usos });
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
        <div
          ref={formulario}
          className="grid scroll-mt-4 gap-4 rounded-md border border-border p-3 lg:grid-cols-[1fr_20rem]"
          data-formulario-do-modelo={editando ? "editar" : "criar"}
        >
          <div className="flex flex-col gap-2">
          {editando && (
            <p className="text-sm font-medium">
              {t("Editando")} <span className="font-mono">{editando.name}</span>{" "}
              <span className="text-xs font-normal text-muted-foreground">
                — {t("nome, idioma e categoria não mudam depois de criado.")}
              </span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="nome_do_modelo"
              aria-label={t("Nome do modelo")}
              disabled={!!editando}
              className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
            />
            {/* LISTA, e não campo livre. O contrato descreve o formato e não
                enumera os valores; digitar é onde o erro nasce — `esp`, `ES`,
                `es-AR` e `español` são todos recusados, e a recusa volta como
                "language not supported" horas depois. */}
            <select
              value={idioma}
              onChange={(e) => setIdioma(e.target.value)}
              aria-label={t("Idioma")}
              disabled={!!editando}
              className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
            >
              {IDIOMAS_DA_DEFINICAO.map((i) => (
                <option key={i.codigo} value={i.codigo}>
                  {t(i.rotulo)} ({i.codigo})
                </option>
              ))}
            </select>
          </div>
          {/* A CATEGORIA é obrigatória no contrato e não era oferecida: tudo
              saía como UTILITY. Mandar promoção como utility é reclassificado
              (ou recusado) pela revisão — e a tarifa da categoria errada é mais
              cara. O padrão continua UTILITY porque é o caso comum de
              atendimento, mas agora é escolha. */}
          <select
            value={categoria}
            onChange={(e) => setCategoria(e.target.value)}
            aria-label={t("Categoria")}
            disabled={!!editando}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
          >
            <option value="UTILITY">
              {t("Utilidade — aviso de pedido, agendamento, cobrança")}
            </option>
            <option value="MARKETING">{t("Marketing — promoção, novidade, reengajamento")}</option>
            <option value="AUTHENTICATION">{t("Autenticação — código de verificação")}</option>
          </select>

          {/* CABEÇALHO opcional: texto OU mídia, nunca os dois — a plataforma
              aceita um formato por definição, e mandar ambos é recusa. */}
          <div className="flex flex-wrap gap-2">
            <input
              value={cabecalho}
              onChange={(e) => {
                setCabecalho(e.target.value);
                if (e.target.value) setMidiaUrl("");
              }}
              placeholder={t("Cabeçalho de texto (opcional)")}
              aria-label={t("Cabeçalho de texto")}
              disabled={!!midiaUrl}
              className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
            />
            {/* SUBIR, e não colar URL. Colar exigia que o operador já tivesse a
                imagem hospedada em algum lugar público — que é justamente o que
                ele não tem. O arquivo vai para o nosso storage e a rota devolve
                um link assinado, que é o que a plataforma baixa na revisão. */}
            <label
              className={cn(
                "flex h-9 flex-1 cursor-pointer items-center justify-center rounded-md border border-dashed border-input px-2 text-sm text-muted-foreground hover:bg-muted",
                cabecalho && "pointer-events-none opacity-50",
              )}
            >
              {subindo
                ? t("Subindo…")
                : midiaUrl
                  ? t("Trocar imagem")
                  : t("Subir imagem (JPG/PNG)")}
              <input
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                aria-label={t("Imagem do cabeçalho")}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setSubindo(true);
                  try {
                    const fd = new FormData();
                    fd.append("file", f);
                    const r = await fetch("/api/v1/channels/partner/templates/media", {
                      method: "POST",
                      body: fd,
                    });
                    const j = (await r.json()) as { data?: { url?: string }; error?: { message?: string } };
                    if (!r.ok || !j.data?.url) {
                      // A mensagem da rota CHEGA ao operador: é ela que
                      // distingue "formato" de "tamanho" de "erro nosso".
                      toast.error(t(j.error?.message ?? "Não consegui subir a imagem."));
                      return;
                    }
                    setMidiaUrl(j.data.url);
                    setCabecalho("");
                  } finally {
                    setSubindo(false);
                    e.target.value = "";
                  }
                }}
              />
            </label>
          </div>

          <div className="flex flex-col gap-1">
            <textarea
              value={corpo}
              onChange={(e) => setCorpo(e.target.value.slice(0, LIMITE_CORPO))}
              placeholder={t("Texto da mensagem. Use {{1}}, {{2}} para os valores que mudam.")}
              aria-label={t("Conteúdo")}
              className="min-h-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
            {/* O contador existe porque passar do limite é RECUSA, e a recusa
                chega horas depois sem dizer que o problema era o tamanho. */}
            <span className="self-end text-[10px] text-muted-foreground">
              {corpo.length}/{LIMITE_CORPO}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <input
              value={rodape}
              onChange={(e) => setRodape(e.target.value.slice(0, LIMITE_RODAPE))}
              placeholder={t("Rodapé (opcional) — texto pequeno no fim da mensagem")}
              aria-label={t("Rodapé")}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
            <span className="self-end text-[10px] text-muted-foreground">
              {rodape.length}/{LIMITE_RODAPE}
            </span>
          </div>

          {/* BOTÕES: até três, e cada tipo pede um campo diferente. URL sem
              endereço e telefone sem número são recusados — por isso o campo
              extra aparece junto com o tipo, e não escondido atrás de outro
              clique. */}
          <div className="flex flex-col gap-1.5">
            {botoes.map((b, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select
                  value={b.tipo}
                  onChange={(e) => {
                    const p = [...botoes];
                    p[i] = { ...b, tipo: e.target.value as BotaoDaDefinicao["tipo"] };
                    setBotoes(p);
                  }}
                  aria-label={`${t("Tipo do botão")} ${i + 1}`}
                  className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="quick_reply">{t("Resposta rápida")}</option>
                  <option value="url">{t("Abrir link")}</option>
                  {/* NÃO usar t("Ligar") aqui: essa chave já existe no dicionário
                      traduzida como "Activar" (o toggle de automações em
                      RulesTab.tsx) — mesma palavra fonte, sentido diferente
                      ("Llamar", não "Activar"). Texto puro evita a tradução errada. */}
                  <option value="phone_number">Ligar</option>
                </select>
                <input
                  value={b.texto}
                  onChange={(e) => {
                    const p = [...botoes];
                    p[i] = { ...b, texto: e.target.value };
                    setBotoes(p);
                  }}
                  placeholder={t("Texto do botão")}
                  aria-label={`${t("Texto do botão")} ${i + 1}`}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                />
                {b.tipo === "url" && (
                  <input
                    value={b.url ?? ""}
                    onChange={(e) => {
                      const p = [...botoes];
                      p[i] = { ...b, url: e.target.value };
                      setBotoes(p);
                    }}
                    placeholder="https://…"
                    aria-label={`${t("URL do botão")} ${i + 1}`}
                    className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                  />
                )}
                {b.tipo === "phone_number" && (
                  <input
                    value={b.telefone ?? ""}
                    onChange={(e) => {
                      const p = [...botoes];
                      p[i] = { ...b, telefone: e.target.value };
                      setBotoes(p);
                    }}
                    placeholder="+595…"
                    aria-label={`${t("Telefone do botão")} ${i + 1}`}
                    className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                  />
                )}
                <button
                  type="button"
                  onClick={() => setBotoes(botoes.filter((_, j) => j !== i))}
                  className="text-xs text-muted-foreground hover:text-destructive"
                  aria-label={`${t("Remover botão")} ${i + 1}`}
                >
                  {t("remover")}
                </button>
              </div>
            ))}
            {botoes.length < LIMITE_BOTOES && (
              <button
                type="button"
                onClick={() => setBotoes([...botoes, { tipo: "quick_reply", texto: "" }])}
                className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                + {t("Adicionar botão")} ({botoes.length}/{LIMITE_BOTOES})
              </button>
            )}
          </div>

          {nVariaveis > 0 && (
            /* ESTE É O CAMPO QUE FALTAVA, e a causa das recusas.
               A revisão exige uma AMOSTRA de cada `{{n}}` — sem ela a definição
               é recusada, e a recusa chega horas depois sem ninguém ligar uma
               coisa à outra. O formulário deixava digitar `{{1}}` e nunca
               pedia o exemplo. */
            <div className="flex flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50/50 p-2 dark:border-amber-800/60 dark:bg-amber-950/20">
              <p className="text-[11px] text-amber-900 dark:text-amber-200">
                {t("A revisão exige um exemplo de cada valor. Sem eles o modelo é recusado.")}
              </p>
              {Array.from({ length: nVariaveis }, (_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">
                    {`{{${i + 1}}}`}
                  </span>
                  <input
                    value={exemplos[i] ?? ""}
                    onChange={(e) => {
                      const proximo = [...exemplos];
                      proximo[i] = e.target.value;
                      setExemplos(proximo);
                    }}
                    placeholder={t("ex.: María")}
                    aria-label={`${t("Exemplo do valor")} ${i + 1}`}
                    className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                  />
                </div>
              ))}
            </div>
          )}

          {/* O formato do nome e o texto são validados PELA PLATAFORMA, e a
              recusa dela chega inteira ao operador. Repetir a regra aqui a faria
              envelhecer separado da fonte. */}
          <p className="text-[11px] text-muted-foreground">
            {editando
              ? t(
                  "Ao salvar, a plataforma revisa o modelo de novo. A Meta limita quantas vezes um modelo aprovado pode ser editado; se passar do limite, a resposta dela aparece aqui.",
                )
              : t(
                  "A plataforma revisa antes de aprovar — o modelo nasce pendente e some da lista de envio até ela decidir.",
                )}
          </p>
          <div className="flex sm:justify-end">
            <Button
              type="button"
              size="sm"
              disabled={!nome.trim() || !corpo.trim() || acao.isPending}
              onClick={() => {
                const components = montarComponents({
                  body: corpo,
                  footer: rodape,
                  exemplos,
                  cabecalho: { texto: cabecalho, midiaUrl },
                  botoes,
                });
                acao.mutate(
                  editando
                    ? { acao: "editar", name: editando.name, language: editando.language, components }
                    : { acao: "criar", name: nome.trim(), language: idioma.trim(), category: categoria, components },
                );
              }}
              className="w-full sm:w-auto"
            >
              {editando ? t("Salvar e enviar para revisão") : t("Enviar para revisão")}
            </Button>
          </div>
          </div>

          {/* A prévia fica AO LADO, não embaixo: embaixo ela sai da tela junto
              com o botão de enviar, e o operador manda sem ter olhado. */}
          <div className="lg:sticky lg:top-4 lg:self-start">
            <PreviaDaDefinicao
              cabecalho={cabecalho}
              midiaUrl={midiaUrl}
              corpo={corpo}
              rodape={rodape}
              botoes={botoes}
            />
          </div>
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
                            onClick={() => setApagando({ tpl, usos: null })}
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

      <AlertDialog open={apagando !== null} onOpenChange={(v) => !v && !apagar.isPending && setApagando(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Apagar o modelo")} <span className="font-mono">{apagando?.tpl.name}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Ele é apagado também na plataforma do WhatsApp, e não dá para desfazer. A Meta não deixa usar o mesmo nome de novo por 30 dias.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {apagando?.usos && apagando.usos.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50/50 p-2 text-sm dark:border-amber-800/60 dark:bg-amber-950/20">
              <p className="font-medium">{t("Este modelo está em uso:")}</p>
              <ul className="mt-1 list-disc pl-5">
                {apagando.usos.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Sem ele, esse passo do follow-up é pulado e o agente não consegue mandá-lo. Troque antes, ou apague assim mesmo.")}
              </p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={apagar.isPending}>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={apagar.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                // Não fecha sozinho: se a rota responder "em uso", o diálogo
                // continua aberto mostrando onde.
                e.preventDefault();
                if (apagando) apagar.mutate({ tpl: apagando.tpl, confirmado: apagando.usos !== null });
              }}
            >
              {apagar.isPending
                ? t("Apagando…")
                : apagando?.usos && apagando.usos.length > 0
                  ? t("Apagar assim mesmo")
                  : t("Apagar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
