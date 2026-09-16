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
import { Textarea } from "@/components/ui/textarea";
import { aiClassifyConfigSchema } from "@/lib/followup/graph-schema";
import {
  ALVOS_DA_CLASSIFICACAO,
  ESPERA_PELA_RESPOSTA,
  opcoes,
  type AlvoDaClassificacao,
} from "@/lib/followup/vocabulario";
import { useT } from "@/hooks/i18n/useT";

import { msToMin, minToMs, type ConfigOf } from "./shared";

/**
 * ⚠️ AS CLASSES AQUI USAM A SEMÂNTICA v1 DE PROPÓSITO — não é esquecimento.
 *
 * O contrato do grafo já tem ramos nomeados (`branches`, id estável separado do
 * rótulo), e é tentador fazer este formulário passar a emiti-los: resolveria o
 * defeito de renomear uma classe e soltar a aresta. NÃO FAÇA sem migrar as
 * arestas junto, porque o modo de falha é o pior que existe neste código:
 *
 * As arestas de saída de um nó que já existe estão gravadas como
 * `class_match:<texto>`. Assim que o nó ganha `branches`, ele passa a ser um nó
 * v2: `classEdgeMatch` (node-handlers) devolve `{type:'branch'}`, `selectEdge`
 * não casa a aresta antiga e cai no `always`. Só que o CANVAS continua
 * desenhando tudo certo, porque `branchIdForCondition` resolve `class_match`
 * pelo rótulo — tela correta, roteamento errado, e nada acusando.
 *
 * Migrar um nó exige reescrever as arestas dele NO MESMO INSTANTE. Isso é
 * operação de canvas, com atomicidade, não mudança de formulário.
 *
 * O estado de hoje é seguro e completo do lado do usuário: o nó já desenha uma
 * bolinha por classe e roteia por `class_match`. O que falta é só a identidade
 * estável no rename, e ela tem item próprio.
 */
export function ClassifyForm({
  config,
  onChange,
}: {
  config: ConfigOf<"ai_classify">;
  onChange: (c: ConfigOf<"ai_classify">) => void;
}) {
  const t = useT();
  const [classesText, setClassesText] = useState(config.classes.join(", "));
  const [graceMin, setGraceMin] = useState(msToMin(config.grace_timeout_ms));
  const [target, setTarget] = useState(config.target);
  const [hint, setHint] = useState(config.hint ?? "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: { classesText: string; graceMin: number; target: AlvoDaClassificacao; hint: string }) => {
    const classes = next.classesText
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const candidate = {
      classes,
      grace_timeout_ms: minToMs(next.graceMin),
      target: next.target,
      ...(next.hint.trim() ? { hint: next.hint } : {}),
    };
    const parsed = aiClassifyConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="classify-classes">{t("Classes (separadas por vírgula)")}</Label>
        <Input
          id="classify-classes"
          value={classesText}
          onChange={(e) => {
            setClassesText(e.target.value);
            commit({ classesText: e.target.value, graceMin, target, hint });
          }}
          placeholder={t("interessado, sem interesse")}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="classify-grace">{t(ESPERA_PELA_RESPOSTA.rotulo)}</Label>
        <Input
          id="classify-grace"
          type="number"
          min={ESPERA_PELA_RESPOSTA.minimoMinutos}
          value={graceMin}
          onChange={(e) => {
            const v = Number(e.target.value);
            setGraceMin(v);
            commit({ classesText, graceMin: v, target, hint });
          }}
        />
        <p className="text-xs text-text-muted">{ESPERA_PELA_RESPOSTA.ajuda}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="classify-target">{t("O que a IA vai ler")}</Label>
        <Select
          value={target}
          onValueChange={(v) => {
            const next = v as AlvoDaClassificacao;
            setTarget(next);
            commit({ classesText, graceMin, target: next, hint });
          }}
        >
          <SelectTrigger id="classify-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opcoes(ALVOS_DA_CLASSIFICACAO).map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {t(rotulo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="classify-hint">{t("Instrução (opcional)")}</Label>
        <Textarea
          id="classify-hint"
          maxLength={500}
          value={hint}
          onChange={(e) => {
            setHint(e.target.value);
            commit({ classesText, graceMin, target, hint: e.target.value });
          }}
        />
      </div>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}
