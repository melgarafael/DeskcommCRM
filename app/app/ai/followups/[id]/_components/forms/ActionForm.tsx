"use client";

import { useState } from "react";

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
import { actionConfigSchema } from "@/lib/followup/graph-schema";
import { MODOS_DA_ACAO, opcoes, type ModoDaAcao } from "@/lib/followup/vocabulario";
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
  const doCanal = aprovados.data ?? [];

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
      <p className="text-xs text-text-muted">
        {t("Você ainda não tem modelos de mensagem. Crie um em Ajustes → Modelos e ele aparece aqui.")}
      </p>
    );
  }

  const SEM_MODELO = "__nenhum__";
  const escolhido = doCanal.find((m) => m.id === valor);
  return (
    <div className="space-y-2">
      <Select
        value={valor === "" ? SEM_MODELO : valor}
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
      {escolhido && <p className="whitespace-pre-line text-xs text-text-muted">{escolhido.texto}</p>}
      {soAprovados && doCanal.length === 0 && (
        <p className="text-xs text-text-muted">
          {t("Nenhum modelo aprovado no WhatsApp ainda. Crie um em Conexões → Modelos e ele aparece aqui quando for aprovado.")}
        </p>
      )}
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
  const [error, setError] = useState<string | null>(null);

  const commit = (next: {
    mode: ModoDaAcao;
    body: string;
    promptHint: string;
    fallbackTemplateId: string;
    templateId: string;
  }) => {
    const candidate =
      next.mode === "text"
        ? { mode: "text" as const, body: next.body }
        : next.mode === "ai_message"
          ? {
              mode: "ai_message" as const,
              prompt_hint: next.promptHint,
              ...(next.fallbackTemplateId.trim() ? { fallback_template_id: next.fallbackTemplateId } : {}),
            }
          : { mode: "template" as const, template_id: next.templateId };
    const parsed = actionConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const fields = { body, promptHint, fallbackTemplateId, templateId };

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
            {t("Sai exatamente assim, sem IA. No laço,")} {t("{{volta}}")} e {t("{{voltas}}")} {t("viram o número da volta.")}
          </p>
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
          <p className="text-xs text-text-muted">
            {t("Depois de 24 horas sem resposta do cliente, só um modelo aprovado no WhatsApp chega até ele.")}
          </p>
        </div>
      )}
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}
