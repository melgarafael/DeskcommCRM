"use client";
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DialogoDeApagarModelo, type AlvoDoApagamento } from "./DialogoDeApagarModelo";
import { FormularioDaDefinicao, type CorpoDoModelo, type ModeloEmEdicao } from "./FormularioDaDefinicao";
import {
  useSaveTemplateValues,
  useSyncTemplates,
  useTemplates,
  type TemplatePreview,
  type TemplateSlotView,
  type TemplateView,
} from "@/hooks/channels/useTemplates";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { PencilSimple, Trash } from "@/lib/ui/icons";

/** Só APPROVED pode ser disparado — o resto é informação, não opção. */
function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "APPROVED") return "default";
  if (status === "REJECTED" || status === "DISABLED") return "destructive";
  if (status === "PENDING") return "secondary";
  return "outline";
}

/**
 * O preview é a peça central desta tela. A Meta **não devolve** valores de exemplo
 * (`example` vem null nos templates reais), então o único jeito de o operador saber
 * o que preencher é ver o texto ao redor do parâmetro.
 *
 * O texto aparece INTEIRO e uma vez só, com todos os `{{n}}` marcados. A versão
 * anterior repetia o corpo a cada slot — cada linha destacava o seu e deixava o
 * vizinho cru, o que é tecnicamente correto e ilegível.
 */
function Preview({ preview }: { preview: TemplatePreview }) {
  const t = useT();
  const partes = preview.text.split(/(\{\{\w+\}\})/g);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {t(preview.onde)}
      </span>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">
        {partes.map((parte, i) =>
          /^\{\{\w+\}\}$/.test(parte) ? (
            <span
              key={i}
              className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-medium text-primary ring-1 ring-primary/20"
            >
              {parte.slice(2, -2)}
            </span>
          ) : (
            <span key={i} className="text-muted-foreground">
              {parte}
            </span>
          ),
        )}
      </p>
    </div>
  );
}

function ehMidia(s: TemplateSlotView): boolean {
  return s.expects === "image" || s.expects === "video" || s.expects === "document";
}

/**
 * O link da mídia do cabeçalho, salvo NO MODELO e não no disparo.
 *
 * A plataforma exige o link em todo envio de modelo com cabeçalho de mídia — o
 * arquivo enviado na aprovação é só amostra. Até aqui a única porta para salvar
 * era o painel da janela fechada, que só grava DEPOIS de um envio: para deixar o
 * modelo pronto, o operador tinha de disparar para um cliente. Aqui ele salva
 * sem enviar nada, na mesma tela em que sincroniza. Campo vazio esquece o link.
 */
function LinkDaMidia({ tpl, slot }: { tpl: TemplateView; slot: TemplateSlotView }) {
  const t = useT();
  const salvar = useSaveTemplateValues();
  const salvo = tpl.savedValues[slot.valueKey] ?? "";
  const [valor, setValor] = useState(salvo);
  const limpo = valor.trim();
  // A plataforma só baixa `https://` com host; a rota recusa o resto com um
  // código (`link_invalido`) que chegaria cru ao aviso. Dizer antes, no campo.
  const linkInvalido = limpo !== "" && !/^https:\/\/[^\s/]+/i.test(limpo);
  const id = `link:${tpl.name}:${tpl.language}:${slot.valueKey}`;

  async function gravar() {
    await salvar.mutateAsync({
      name: tpl.name,
      language: tpl.language,
      values: { [slot.valueKey]: limpo },
    });
    toast.success(limpo ? t("Link salvo no modelo.") : t("Link removido do modelo."));
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs uppercase tracking-wide text-muted-foreground">
        {t(slot.onde)} · {slot.expects}
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          disabled={salvar.isPending}
          data-testid="template-link-midia"
        />
        <Button
          variant="outline"
          onClick={gravar}
          disabled={limpo === salvo || linkInvalido || salvar.isPending}
          data-testid="btn-salvar-link"
        >
          {salvar.isPending
            ? t("Salvando…")
            : !limpo && salvo
              ? t("Remover link")
              : t("Salvar link")}
        </Button>
      </div>
      {linkInvalido ? (
        <span className="text-xs text-destructive" role="status">
          {t("Use um link público que comece com https://")}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          {salvo
            ? t("Link salvo: o painel do modelo na conversa já vem preenchido com ele.")
            : t("Link público (https) do arquivo. Salvo aqui, o painel do modelo na conversa já vem preenchido.")}
        </span>
      )}
    </div>
  );
}

export function TemplatesClient() {
  const t = useT();
  const { data, isPending } = useTemplates();
  const sync = useSyncTemplates();
  const qc = useQueryClient();

  // ─── Criar, editar e apagar pela TELA (#3635) ─────────────────────────────
  //
  // Antes daqui, quem opera o canal oficial direto criava o modelo no Gerenciador
  // do WhatsApp, esperava a aprovação e voltava para "Sincronizar". O formulário
  // e o diálogo de apagar são os MESMOS da tela do parceiro: a API é a mesma
  // (`/{waba}/message_templates`), o que muda é a credencial, e isso é do
  // servidor — esta tela só manda `acao`.
  const [criando, setCriando] = useState(false);
  const [editando, setEditando] = useState<ModeloEmEdicao | null>(null);
  const [apagando, setApagando] = useState<AlvoDoApagamento | null>(null);
  const formulario = useRef<HTMLDivElement>(null);

  const waba = data?.data.waba ?? null;
  const templates = data?.data.templates ?? null;

  /** As duas listas que leem o espelho: o seletor do inbox e o construtor de fluxo. */
  function invalidarEspelho() {
    qc.invalidateQueries({ queryKey: ["channel-templates"] });
    qc.invalidateQueries({ queryKey: ["templates-da-conversa"] });
    qc.invalidateQueries({ queryKey: ["followup-modelos-aprovados"] });
  }

  const gestao = useMutation({
    mutationFn: (corpo: CorpoDoModelo) =>
      apiClient.post<{ data: Record<string, number> }>("/api/v1/channels/templates", corpo),
    onSuccess: (_r, corpo) => {
      invalidarEspelho();
      toast.success(
        corpo.acao === "editar"
          ? t("Modelo atualizado e enviado para revisão.")
          : t("Modelo criado e enviado para revisão."),
      );
      setCriando(false);
      setEditando(null);
    },
    // A mensagem da ROTA chega ao operador: é ela que distingue "sem permissão
    // na conta" de "nome inválido" de "não deu".
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? t(e.message) : t("Não consegui falar com a plataforma.")),
  });

  const apagar = useMutation({
    mutationFn: (v: { alvo: AlvoDoApagamento; confirmado: boolean }) =>
      apiClient.post<{ data: Record<string, number> }>("/api/v1/channels/templates", {
        acao: "apagar",
        name: v.alvo.name,
        language: v.alvo.language,
        confirmado: v.confirmado,
      }),
    onSuccess: () => {
      invalidarEspelho();
      toast.success(t("Modelo apagado."));
      setApagando(null);
    },
    onError: (e: unknown, v) => {
      // Modelo em uso: a rota devolve ONDE (follow-up, agente) e a caixa
      // continua aberta com a lista à vista.
      if (e instanceof ApiError && e.code === "template_in_use") {
        const usos = Array.isArray(e.details?.usos) ? (e.details.usos as string[]) : [];
        setApagando({ ...v.alvo, usos });
        return;
      }
      toast.error(e instanceof Error ? t(e.message) : t("Não consegui falar com a plataforma."));
    },
  });

  const abrirEdicao = (tpl: TemplateView) => {
    setEditando({
      name: tpl.name,
      language: tpl.language,
      category: tpl.category,
      components: tpl.components ?? [],
    });
    setCriando(true);
    requestAnimationFrame(() => formulario.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  async function sincronizar() {
    const res = await sync.mutateAsync();
    const { inserted, updated, disabled } = res.data;
    toast.success(
      `${t("Sincronizado:")} ${inserted} ${t("novo(s),")} ${updated} ${t("atualizado(s),")} ${disabled} ${t("desativado(s).")}`,
    );
  }

  if (isPending || templates === null) {
    return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  }

  // Estado vazio que ENSINA — distinguir "canal não conectado" de "conectado sem
  // template" é a diferença entre o operador saber o próximo passo ou não.
  if (!waba) {
    return (
      <Card className="p-6">
        <h2 className="font-medium">{t("Canal oficial não conectado")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Os templates vivem na sua conta do WhatsApp Business (Meta) — esta tela é um espelho deles. Conecte o canal oficial em")}{" "}
          <strong>{t("Conexões WhatsApp")}</strong> {t("para começar a sincronizar.")}
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="templates-root">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="min-w-0 break-words text-sm text-muted-foreground">
          {t("Espelho da conta")} <span className="font-mono text-xs">{waba}</span> ·{" "}
          {templates.length} {t("template(s)")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={sincronizar} disabled={sync.isPending} data-testid="btn-sync">
            {sync.isPending ? t("Sincronizando…") : t("Sincronizar com a Meta")}
          </Button>
          <Button
            onClick={() => {
              setEditando(null);
              setCriando((v) => !v);
            }}
            data-testid="btn-criar-modelo"
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
            salvando={gestao.isPending}
            // A imagem do cabeçalho é guardada no NOSSO storage — a rota é a
            // mesma para qualquer canal, com o caminho desta fonte.
            rotaDeMidia="/api/v1/channels/templates/media"
            onEnviar={(corpo) => gestao.mutate(corpo)}
          />
        </div>
      )}

      {templates.length === 0 ? (
        <Card className="p-6">
          <h2 className="font-medium">{t("Nenhum template ainda")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Crie o modelo aqui mesmo em")} <strong>{t("Criar modelo")}</strong>.{" "}
            {t("Só templates aprovados podem ser enviados fora da janela de 24 horas.")}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {templates.map((tpl) => (
            <Card key={`${tpl.name}:${tpl.language}`} className="p-4" data-testid="template-card">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{tpl.name}</span>
                <Badge variant="outline" className="font-mono text-xs">
                  {tpl.language}
                </Badge>
                <Badge variant={statusTone(tpl.status)}>{tpl.status}</Badge>
                {tpl.category ? (
                  <Badge variant="outline" className="text-xs">
                    {tpl.category}
                  </Badge>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {tpl.slots.length === 0
                    ? t("sem parâmetros")
                    : `${tpl.slots.length} ${t("parâmetro(s)")}`}
                </span>
              </div>

              {tpl.rejectedReason ? (
                <p className="mt-2 text-sm text-destructive">
                  {t("Recusado:")} {tpl.rejectedReason}
                </p>
              ) : null}

              {tpl.previews.length > 0 || tpl.slots.length > 0 ? (
                <div className="mt-3 flex flex-col gap-3 border-l-2 border-muted pl-3">
                  {tpl.previews.map((p, i) => (
                    <Preview key={`${p.onde}:${i}`} preview={p} />
                  ))}
                  {/* Slots SEM texto ao redor: header de mídia. É justamente o
                      parâmetro que contar `{{n}}` não enxerga. */}
                  {tpl.slots
                    .filter((s) => s.expects !== "text")
                    .map((s, i) =>
                      ehMidia(s) ? (
                        // `salvo` na chave: o campo nasce do link salvo e não o
                        // acompanha depois. Se o link mudar por outra porta (o
                        // painel da conversa), o refetch remonta o campo em vez
                        // de deixar o valor velho pronto para ser gravado de volta.
                        <LinkDaMidia
                          key={`m:${s.valueKey}:${tpl.savedValues[s.valueKey] ?? ""}`}
                          tpl={tpl}
                          slot={s}
                        />
                      ) : (
                        <div key={`m:${s.onde}:${i}`} className="flex flex-col gap-0.5">
                          <span className="text-xs uppercase tracking-wide text-muted-foreground">
                            {t(s.onde)} · {s.expects}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {t("arquivo de")} {s.expects} {t("enviado no disparo")}
                          </span>
                        </div>
                      ),
                    )}
                </div>
              ) : null}

              {/* Editar e apagar pela TELA: era o que faltava para o canal
                  oficial direto. A categoria viaja junto porque é ela que o
                  formulário mostra travada. Só no modelo DESTA conexão: o do
                  parceiro também está no espelho, e a rota oficial o recusa. */}
              {tpl.daConexao ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => abrirEdicao(tpl)}>
                    <PencilSimple size={14} className="mr-1.5" aria-hidden />
                    {t("Editar")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setApagando({ name: tpl.name, language: tpl.language, usos: null })}
                  >
                    <Trash size={14} className="mr-1.5" aria-hidden />
                    {t("Apagar")}
                  </Button>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
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
