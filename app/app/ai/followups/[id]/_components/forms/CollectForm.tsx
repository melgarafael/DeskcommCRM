"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { collectConfigSchema, type ContactFlowFieldType } from "@/lib/followup/graph-schema";
import { TIPOS_DE_CAMPO, opcoes } from "@/lib/followup/vocabulario";
import { useT } from "@/hooks/i18n/useT";

import type { ConfigOf } from "./shared";

/**
 * Pergunta de um fluxo de ATENDIMENTO (nó `collect`). O nó não envia nada: ele
 * declara o CAMPO que precisa ser preenchido. O valor entra em
 * `contact_flow_data` (chave = `key`) e, quando todos os obrigatórios estão
 * preenchidos, o fluxo conclui.
 *
 * Mesma regra dos demais formulários: o campo só grava no nó vivo quando o
 * candidato passa no schema — senão erro inline e o canvas mantém o último
 * válido.
 */
export function CollectForm({
  config,
  onChange,
}: {
  config: ConfigOf<"collect">;
  onChange: (c: ConfigOf<"collect">) => void;
}) {
  const t = useT();
  const [label, setLabel] = useState(config.label);
  const [key, setKey] = useState(config.key);
  const [type, setType] = useState<ContactFlowFieldType>(config.type);
  const [required, setRequired] = useState(config.required);
  const [permiteCorrecao, setPermiteCorrecao] = useState(config.permite_correcao);
  const [question, setQuestion] = useState(config.question ?? "");
  const [options, setOptions] = useState((config.options ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);

  const commit = (next: {
    label: string;
    key: string;
    type: ContactFlowFieldType;
    required: boolean;
    permiteCorrecao: boolean;
    question: string;
    options: string;
  }) => {
    const listaDeOpcoes = next.options
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const candidate = {
      label: next.label,
      key: next.key,
      type: next.type,
      required: next.required,
      permite_correcao: next.permiteCorrecao,
      ...(next.question.trim() ? { question: next.question } : {}),
      ...(next.type === "select" ? { options: listaDeOpcoes } : {}),
    };
    const parsed = collectConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const state = { label, key, type, required, permiteCorrecao, question, options };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="collect-label">{t("Pergunta (o que a IA deve perguntar)")}</Label>
        <Input
          id="collect-label"
          maxLength={80}
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            commit({ ...state, label: e.target.value });
          }}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="collect-key">{t("Chave do campo (onde a resposta é guardada)")}</Label>
        <Input
          id="collect-key"
          maxLength={60}
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            commit({ ...state, key: e.target.value });
          }}
        />
        <p className="text-xs text-text-muted">
          {t("Minúsculas, sem espaço (ex.: cidade, cnh, moto_interesse).")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="collect-type">{t("Tipo da resposta")}</Label>
        <Select
          value={type}
          onValueChange={(v) => {
            const next = v as ContactFlowFieldType;
            setType(next);
            commit({ ...state, type: next });
          }}
        >
          <SelectTrigger id="collect-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opcoes(TIPOS_DE_CAMPO).map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {t(rotulo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {type === "select" && (
        <div className="space-y-2">
          <Label htmlFor="collect-options">{t("Opções (separe por vírgula)")}</Label>
          <Input
            id="collect-options"
            value={options}
            onChange={(e) => {
              setOptions(e.target.value);
              commit({ ...state, options: e.target.value });
            }}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="collect-required">{t("Obrigatória")}</Label>
        <Switch
          id="collect-required"
          checked={required}
          onCheckedChange={(v) => {
            setRequired(v);
            commit({ ...state, required: v });
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label htmlFor="collect-correcao">{t("Permitir correção")}</Label>
          <p className="text-xs text-text-muted">
            {t("Se o cliente mudar de ideia, a nova informação substitui a anterior.")}
          </p>
        </div>
        <Switch
          id="collect-correcao"
          checked={permiteCorrecao}
          onCheckedChange={(v) => {
            setPermiteCorrecao(v);
            commit({ ...state, permiteCorrecao: v });
          }}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="collect-question">{t("Texto sugerido (opcional)")}</Label>
        <Textarea
          id="collect-question"
          maxLength={400}
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
            commit({ ...state, question: e.target.value });
          }}
        />
        <p className="text-xs text-text-muted">
          {t("A IA pode adaptar a pergunta ao tom da conversa.")}
        </p>
      </div>

      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}
