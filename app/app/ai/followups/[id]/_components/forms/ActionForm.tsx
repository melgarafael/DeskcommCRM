"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FonteDeVariavel, VariaveisDoModelo } from "@/lib/channels/meta/variaveis-do-fluxo";
import { actionConfigSchema } from "@/lib/followup/graph-schema";
import type { VariavelDoModelo } from "@/lib/followup/modelos-aprovados";
import { MODOS_DA_ACAO, opcoes, type ModoDaAcao } from "@/lib/followup/vocabulario";
import { camposDoFunil, camposPorEscopo } from "@/lib/leads/campos-do-funil";
import { usePipelines } from "@/hooks/webhooks/useWebhookSources";
import { useMessageTemplates } from "@/hooks/inbox/useMessageTemplates";
import { useModelosAprovadosDoFluxo } from "@/hooks/followup/useModelosAprovadosDoFluxo";
import { useT } from "@/hooks/i18n/useT";

import type { ConfigOf } from "./shared";

/**
 * O seletor de modelo, no lugar dos dois `<Input>` que pediam um UUID colado à
 * mão. Trata os três estados em vez de fingir que a lista sempre chega:
 * carregando, vazia e erro — porque um seletor vazio sem explicação é o mesmo
 * beco sem saída que o campo de UUID era, só que mais bonito.
 *
 * Duas origens, em grupos separados: os textos prontos (Ajustes → Modelos) e os
 * modelos APROVADOS no WhatsApp. A diferença não é cosmética: com a janela de
 * 24 h fechada, só o aprovado chega ao cliente — por isso o plano B da mensagem
 * por IA (`soAprovados`) só oferece esse grupo.
 */
function SeletorDeModelo({
  id,
  valor,
  onChange,
  permiteVazio,
  soAprovados,
}: {
  id: string;
  valor: string;
  onChange: (templateId: string) => void;
  permiteVazio: boolean;
  soAprovados: boolean;
}) {
  const t = useT();
  const textos = useMessageTemplates();
  const aprovados = useModelosAprovadosDoFluxo();
  const prontos = soAprovados ? [] : (textos.data ?? []);
  // O plano B da IA não tem mapa de variáveis: só modelo sem variável serve a ele.
  const doCanal = (aprovados.data ?? []).filter((m) => !soAprovados || m.variaveis.length === 0);

  // Seguimento do #3056: o id gravado que não está em nenhuma das listas (fluxo
  // importado de outra conta, modelo apagado) deixava o seletor EM BRANCO, sem
  // dizer nada. Só afirma a ausência com as duas listas carregadas — lista que
  // falhou ou não pôde ser lida não prova que o modelo sumiu. Indisponível, o
  // `value` vai "" — é o que faz o Radix mostrar o placeholder «Escolha um modelo».
  const listasLidas = (soAprovados || textos.isSuccess) && aprovados.isSuccess;
  const indisponivel = listasLidas && valor !== "" && !prontos.some((m) => m.id === valor) && !doCanal.some((m) => m.id === valor);
  const aviso = indisponivel && (
    <p role="alert" className="text-xs text-warning-fg">
      {t("O modelo que estava aqui não está disponível nesta conta. Escolha um modelo para este passo.")}
    </p>
  );

  if ((!soAprovados && textos.isLoading) || aprovados.isLoading) {
    return <p className="text-xs text-text-muted">{t("Carregando seus modelos…")}</p>;
  }
  if ((soAprovados || textos.isError) && aprovados.isError) {
    return (
      <p className="text-xs text-error-fg">
        {t("Não consegui carregar seus modelos de mensagem. Recarregue a página.")}
      </p>
    );
  }
  // O plano B é OPCIONAL: sem modelo aprovado, o seletor continua de pé com
  // "Nenhum" e diz o que falta — trocá-lo por uma frase faria o campo sumir da
  // tela justamente para quem ainda não tem modelo, e nada explicaria onde ele foi.
  if (!soAprovados && prontos.length === 0 && doCanal.length === 0) {
    return (
      <div className="space-y-2">
        {aviso}
        <p className="text-xs text-text-muted">
          {t("Você ainda não tem modelos de mensagem. Crie um em Ajustes → Modelos e ele aparece aqui.")}
        </p>
      </div>
    );
  }

  const SEM_MODELO = "__nenhum__";
  const escolhido = doCanal.find((m) => m.id === valor);
  return (
    <div className="space-y-2">
      <Select
        value={indisponivel ? "" : valor === "" ? SEM_MODELO : valor}
        onValueChange={(v) => onChange(v === SEM_MODELO ? "" : v)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={t("Escolha um modelo")} />
        </SelectTrigger>
        <SelectContent>
          {permiteVazio && <SelectItem value={SEM_MODELO}>{t("Nenhum")}</SelectItem>}
          {prontos.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("Textos prontos")}</SelectLabel>
              {prontos.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.title}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {doCanal.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("Aprovados no WhatsApp")}</SelectLabel>
              {doCanal.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name} ({m.language})
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      {aviso}
      {escolhido && <p className="whitespace-pre-line text-xs text-text-muted">{escolhido.texto}</p>}
      {soAprovados && doCanal.length === 0 && (
        <p className="text-xs text-text-muted">
          {t("Nenhum modelo aprovado no WhatsApp ainda. Crie um em Conexões → Modelos e ele aparece aqui quando for aprovado.")}
        </p>
      )}
    </div>
  );
}

const FONTE_NOME = "__contact_name__";
const FONTE_PRIMEIRO_NOME = "__contact_first_name__";
const FONTE_LIVRE = "__livre__";

/**
 * De onde sai cada variável de um modelo aprovado: nome do contato ou campo do
 * negócio. O valor é lido na hora do envio; variável sem origem, ou vazia no
 * contato, pula o passo com o motivo (`lib/channels/meta/variaveis-do-fluxo.ts`).
 */
function MapaDeVariaveis({
  variaveis,
  valor,
  onChange,
}: {
  variaveis: VariavelDoModelo[];
  valor: VariaveisDoModelo;
  onChange: (next: VariaveisDoModelo) => void;
}) {
  const t = useT();
  const pipelines = usePipelines();
  // Só campos do NEGÓCIO: o envio lê `crm_leads.custom_fields`, e o valor de um
  // campo do contato mora em `contacts.custom_fields` — escolhê-lo pularia o
  // passo em toda inscrição (#2791; mesmo filtro do quadro e do calendário).
  const campos = (pipelines.data?.data ?? []).flatMap((p) =>
    camposPorEscopo(camposDoFunil(p.settings), "negocio"),
  );
  const camposUnicos = [...new Map(campos.map((c) => [c.key, c])).values()];
  const faltando = variaveis.filter((v) => !valor[v.chave]);

  const definir = (chave: string, fonte: FonteDeVariavel) => onChange({ ...valor, [chave]: fonte });

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{t("De onde sai cada variável")}</p>
      {variaveis.map((v) => {
        const fonte = valor[v.chave];
        const selecionado =
          fonte?.kind === "contact_name"
            ? FONTE_NOME
            : fonte?.kind === "contact_first_name"
              ? FONTE_PRIMEIRO_NOME
              : fonte?.kind === "lead_custom"
                ? camposUnicos.some((c) => c.key === fonte.key)
                  ? fonte.key
                  : FONTE_LIVRE
                : "";
        const id = `variavel-${v.chave.replace(/[^a-z0-9]/gi, "-")}`;
        return (
          <div key={v.chave} className="space-y-1">
            <Label htmlFor={id} className="text-xs">
              <span className="font-mono">{v.marcador}</span>
              {v.noCabecalho ? ` · ${t("no cabeçalho")}` : ""}
              {v.antes || v.depois ? (
                <span className="ml-1 text-text-muted">
                  «…{v.antes.slice(-24)} <span className="font-mono">{v.marcador}</span> {v.depois.slice(0, 24)}…»
                </span>
              ) : null}
            </Label>
            <Select
              value={selecionado}
              onValueChange={(escolha) => {
                if (escolha === FONTE_NOME) definir(v.chave, { kind: "contact_name" });
                else if (escolha === FONTE_PRIMEIRO_NOME) definir(v.chave, { kind: "contact_first_name" });
                else if (escolha === FONTE_LIVRE) definir(v.chave, { kind: "lead_custom", key: "campo" });
                else definir(v.chave, { kind: "lead_custom", key: escolha });
              }}
            >
              <SelectTrigger id={id}>
                <SelectValue placeholder={t("Escolha a origem")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FONTE_PRIMEIRO_NOME}>{t("Primeiro nome do contato")}</SelectItem>
                <SelectItem value={FONTE_NOME}>{t("Nome do contato")}</SelectItem>
                {camposUnicos.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label} ({c.key})
                  </SelectItem>
                ))}
                <SelectItem value={FONTE_LIVRE}>{t("Outro campo do negócio")}</SelectItem>
              </SelectContent>
            </Select>
            {fonte?.kind === "lead_custom" && !camposUnicos.some((c) => c.key === fonte.key) && (
              <Input
                aria-label={t("Chave do campo do negócio")}
                value={fonte.key}
                onChange={(e) => definir(v.chave, { kind: "lead_custom", key: e.target.value.trim() })}
              />
            )}
          </div>
        );
      })}
      <p className={faltando.length > 0 ? "text-xs text-error-fg" : "text-xs text-text-muted"}>
        {t(
          "Se faltar a origem de alguma variável, ou se o dado estiver vazio no contato, o passo é pulado e o motivo aparece na linha do tempo.",
        )}
      </p>
    </div>
  );
}

export function ActionForm({
  config,
  onChange,
}: {
  config: ConfigOf<"action">;
  onChange: (c: ConfigOf<"action">) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState(config.mode);
  const [body, setBody] = useState(config.mode === "text" ? config.body : "");
  const [promptHint, setPromptHint] = useState(config.mode === "ai_message" ? config.prompt_hint : "");
  const [fallbackTemplateId, setFallbackTemplateId] = useState(
    config.mode === "ai_message" ? (config.fallback_template_id ?? "") : "",
  );
  const [templateId, setTemplateId] = useState(config.mode === "template" ? config.template_id : "");
  const [templateValues, setTemplateValues] = useState<VariaveisDoModelo>(
    config.mode === "template" ? (config.template_values ?? {}) : {},
  );
  const aprovados = useModelosAprovadosDoFluxo();
  const variaveisDe = (id: string) => aprovados.data?.find((m) => m.id === id)?.variaveis ?? [];
  // #2734 — mídia OPCIONAL do passo: com uma imagem, um vídeo, um áudio ou um
  // documento (#2972), o texto acima vira a LEGENDA. O upload pela tela ainda não
  // existe nesta fatia — o campo é a URL.
  const [mediaUrl, setMediaUrl] = useState(
    config.mode === "text" ? (config.media_url ?? "") : "",
  );
  const [error, setError] = useState<string | null>(null);

  const commit = (next: {
    mode: ModoDaAcao;
    body: string;
    mediaUrl: string;
    promptHint: string;
    fallbackTemplateId: string;
    templateId: string;
    templateValues: VariaveisDoModelo;
  }) => {
    // Só as variáveis do modelo escolhido: trocar de modelo não carrega o mapa do
    // anterior. Sem a lista carregada não se poda nada — podar às cegas apagaria
    // o mapa salvo.
    const chaves = variaveisDe(next.templateId).map((v) => v.chave);
    const mapa =
      aprovados.data === undefined
        ? next.templateValues
        : Object.fromEntries(Object.entries(next.templateValues).filter(([chave]) => chaves.includes(chave)));
    const candidate =
      next.mode === "text"
        ? {
            mode: "text" as const,
            body: next.body,
            ...(next.mediaUrl.trim() ? { media_url: next.mediaUrl.trim() } : {}),
          }
        : next.mode === "ai_message"
          ? {
              mode: "ai_message" as const,
              prompt_hint: next.promptHint,
              ...(next.fallbackTemplateId.trim() ? { fallback_template_id: next.fallbackTemplateId } : {}),
            }
          : {
              mode: "template" as const,
              template_id: next.templateId,
              ...(Object.keys(mapa).length > 0 ? { template_values: mapa } : {}),
            };
    const parsed = actionConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const fields = { body, mediaUrl, promptHint, fallbackTemplateId, templateId, templateValues };
  const variaveisDoEscolhido = variaveisDe(templateId);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="action-mode">{t("Como escrever a mensagem")}</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as ModoDaAcao;
            setMode(next);
            commit({ mode: next, ...fields });
          }}
        >
          <SelectTrigger id="action-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opcoes(MODOS_DA_ACAO).map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {t(rotulo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {mode === "text" ? (
        <div className="space-y-2">
          <Label htmlFor="action-body">{t("Texto enviado ao contato")}</Label>
          <Textarea
            id="action-body"
            maxLength={4000}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              commit({ mode, ...fields, body: e.target.value });
            }}
          />
          <p className="text-xs text-text-muted">
            {t("Sai exatamente assim, sem IA. No laço,")} {t("{{volta}}")} {t("e")} {t("{{voltas}}")} {t("viram o número da volta.")}
          </p>
          <p className="text-xs text-text-muted">
            {t('Para não depender do dado, ponha um texto de reserva: {{primeiro_nome|"aluno"}}.')}
          </p>
          <div className="space-y-2">
            <Label htmlFor="action-media-url">{t("Imagem, vídeo, áudio ou documento (opcional)")}</Label>
            <Input
              id="action-media-url"
              type="url"
              maxLength={2000}
              value={mediaUrl}
              placeholder="https://…/oferta.pdf"
              onChange={(e) => {
                setMediaUrl(e.target.value);
                commit({ mode, ...fields, mediaUrl: e.target.value });
              }}
            />
            <p className="text-xs text-text-muted">
              {t("Com uma imagem, um vídeo, um áudio ou um documento, o texto acima vira a legenda do arquivo (o áudio sai como mensagem de voz, sem legenda — o texto não vai junto). Depois de 24 horas sem resposta do cliente, a mídia não sai — só um modelo aprovado chega até ele.")}
            </p>
          </div>
        </div>
      ) : mode === "ai_message" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="action-prompt-hint">{t("Instrução para a IA")}</Label>
            <Textarea
              id="action-prompt-hint"
              maxLength={1000}
              value={promptHint}
              onChange={(e) => {
                setPromptHint(e.target.value);
                commit({ mode, ...fields, promptHint: e.target.value });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="action-fallback">
              {t("Se a janela de 24 horas já tiver fechado, mandar este modelo aprovado no lugar da IA")}
            </Label>
            <SeletorDeModelo
              id="action-fallback"
              valor={fallbackTemplateId}
              permiteVazio
              soAprovados
              onChange={(v) => {
                setFallbackTemplateId(v);
                commit({ mode, ...fields, fallbackTemplateId: v });
              }}
            />
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="action-template-id">{t("Modelo de mensagem")}</Label>
          <SeletorDeModelo
            id="action-template-id"
            valor={templateId}
            permiteVazio={false}
            soAprovados={false}
            onChange={(v) => {
              setTemplateId(v);
              commit({ mode, ...fields, templateId: v });
            }}
          />
          {variaveisDoEscolhido.length > 0 && (
            <MapaDeVariaveis
              variaveis={variaveisDoEscolhido}
              valor={templateValues}
              onChange={(next) => {
                setTemplateValues(next);
                commit({ mode, ...fields, templateValues: next });
              }}
            />
          )}
          <p className="text-xs text-text-muted">
            {t("Depois de 24 horas sem resposta do cliente, só um modelo aprovado no WhatsApp chega até ele.")}
          </p>
        </div>
      )}
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}
