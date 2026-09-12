"use client";

import { useT } from "@/hooks/i18n/useT";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import type { PipelineConfigPatch } from "@/lib/schemas/settings";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { customFieldSchema, type CustomFieldDef } from "@/lib/schemas/settings";
import { Plus, Trash } from "@/lib/ui/icons";
import { AgentMappingSection, ancoraDoMapeamento } from "./_mapping";
import { StagesSection, ancoraDasEtapas } from "./_stages";

export interface PipelineRow {
  id: string;
  name: string;
  slug: string;
  vocabulary: Record<string, string> | null;
  settings: Record<string, unknown> | null;
}

/**
 * Os tipos de campo que esta tela oferece — DERIVADOS do schema, nunca
 * reescritos à mão.
 *
 * Quando a lista era digitada aqui, ela encolheu sem ninguém ver: `multiselect`
 * existia em `customFieldSchema`, era gravado pela API e aparecia no dossiê
 * (`components/contacts/CustomFieldsEditor.tsx`), mas faltava nesta lista. O
 * efeito para quem abria a tela era um campo que parecia corrompido — o
 * `<Select>` recebia `value="multiselect"`, nenhum `SelectItem` casava, e o
 * seletor ficava EM BRANCO. Pior: as opções do campo só apareciam para
 * `select`, então um multiselect ficava sem como ser editado, e a saída óbvia
 * (escolher um tipo para "consertar" o branco) transformava a escolha múltipla
 * em escolha única.
 *
 * Derivar do schema faz a divergência deixar de ser possível: tipo novo lá
 * nasce oferecido aqui.
 */
export const TIPOS_DE_CAMPO = customFieldSchema.shape.type.options;

/** Tipos cujo valor sai de uma lista fechada — são os que mostram o campo de opções. */
export function tipoTemOpcoes(tipo: CustomFieldDef["type"]): boolean {
  return tipo === "select" || tipo === "multiselect";
}

function readLostReasons(settings: Record<string, unknown> | null): string[] {
  if (!settings) return [];
  const r = (settings as { lost_reasons?: unknown }).lost_reasons;
  return Array.isArray(r) ? (r as string[]) : [];
}

export function PipelinesClient({
  pipelines,
  podeEditarConfig,
}: {
  pipelines: PipelineRow[];
  /** Vocabulário/custom fields são admin (a server action recusa o resto). */
  podeEditarConfig: boolean;
}) {
  const t = useT();
  if (pipelines.length === 0) {
    // ⚠️ NÃO PROMETA UM CAMINHO QUE NÃO EXISTE. Criar funil não é feito por
    // nenhuma tela, rota ou action deste produto — só por script de instalação;
    // e como o instalador não provisiona funil, ESTE é o estado de toda
    // instalação nova. O texto anterior mandava "crie um no quadro", e o quadro
    // vazio manda "Ir para Configurações": pingue-pongue fechado, com o usuário
    // procurando um botão que não existe em lugar nenhum.
    return (
      <Card className="p-6 text-sm leading-relaxed text-muted-foreground">
        {t("Você ainda não tem nenhum funil. Enquanto for assim, o agente atende normalmente, mas não tem para onde levar o card de ninguém — não há etapas para onde mover. Criar o funil é feito por quem instalou o sistema, direto no banco; depois ele aparece aqui para você escolher a etapa de cada passo.")}
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {pipelines.map((p) => (
        <Card key={p.id} className="space-y-6 p-6">
          <header>
            <h2 className="text-base font-semibold">{p.name}</h2>
            <p className="text-xs text-muted-foreground">/{p.slug}</p>
          </header>
          {/* As ETAPAS vêm primeiro, e a ordem é a do raciocínio de quem
              configura: primeiro o quadro existe do jeito da sua operação,
              depois se decide o que o assistente faz com ele. Invertido, a
              primeira coisa que o dono da clínica vê é um mapeamento sobre
              colunas de e-commerce que ele nem sabia que dava para trocar. */}
          <StagesSection pipelineId={p.id} ancoraMapeamento={ancoraDoMapeamento(p.id)} />
          <div className="border-t border-border pt-6">
            <AgentMappingSection pipelineId={p.id} ancoraEtapas={ancoraDasEtapas(p.id)} />
          </div>
          {podeEditarConfig && <PipelineEditor pipeline={p} />}
        </Card>
      ))}
    </div>
  );
}

function PipelineEditor({ pipeline }: { pipeline: PipelineRow }) {
  const t = useT();
  const v = pipeline.vocabulary ?? {};
  const [lead, setLead] = useState(v.lead ?? "Lead");
  const [deal, setDeal] = useState(v.deal ?? "Deal");
  const [won, setWon] = useState(v.won ?? "Ganho");
  const [lost, setLost] = useState(v.lost ?? "Perdido");
  const [reasonsText, setReasonsText] = useState(readLostReasons(pipeline.settings).join(", "));
  const [fields, setFields] = useState<CustomFieldDef[]>(camposDoFunil(pipeline.settings));
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const ok: CustomFieldDef[] = [];
    for (const f of fields) {
      const parsed = customFieldSchema.safeParse(f);
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? t("Campo inválido."));
        return;
      }
      ok.push(parsed.data);
    }
    const reasons = reasonsText
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const patch: PipelineConfigPatch = {
      vocabulary: { lead, deal, won, lost },
      fields: ok,
      lost_reasons: reasons,
    };
    startTransition(async () => {
      const r = await updatePipelineConfig(pipeline.id, patch);
      if (r.ok) toast.success(`${pipeline.name} ${t("atualizado.")}`);
      else toast.error(`${t("Erro:")} ${r.error}`);
    });
  }


  return (
    <div className="space-y-4 border-t border-border pt-6">
      <h3 className="text-sm font-semibold">{t("Vocabulário e campos")}</h3>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs">Lead</Label>
          <Input value={lead} onChange={(e) => setLead(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Deal</Label>
          <Input value={deal} onChange={(e) => setDeal(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Won</Label>
          <Input value={won} onChange={(e) => setWon(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Lost</Label>
          <Input value={lost} onChange={(e) => setLost(e.target.value)} />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("Motivos de perda (separados por vírgula)")}</Label>
        <Input value={reasonsText} onChange={(e) => setReasonsText(e.target.value)} />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("Campos do lead neste funil")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("Aparecem no dossiê do negócio. No follow-up, você escolhe em qual campo gravar a resposta.")}
        </p>
        {fields.map((f, i) => (
          <div key={`${f.key}-${i}`} className="grid gap-2 rounded-md border border-border p-2 md:grid-cols-[1fr_1fr_8rem_auto]">
            <Input
              aria-label={`${t("Chave do campo")} ${i + 1}`}
              placeholder={t("chave (endereco)")}
              value={f.key}
              onChange={(e) => {
                const next = [...fields];
                next[i] = { ...f, key: e.target.value };
                setFields(next);
              }}
            />
            <Input
              aria-label={`${t("Rótulo do campo")} ${i + 1}`}
              placeholder={t("Rótulo (Endereço)")}
              value={f.label}
              onChange={(e) => {
                const next = [...fields];
                next[i] = { ...f, label: e.target.value };
                setFields(next);
              }}
            />
            <Select
              value={f.type}
              onValueChange={(type) => {
                const next = [...fields];
                next[i] = { ...f, type: type as CustomFieldDef["type"] };
                setFields(next);
              }}
            >
              <SelectTrigger aria-label={`${t("Tipo do campo")} ${i + 1}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIPOS_DE_CAMPO.map((tipo) => (
                  <SelectItem key={tipo} value={tipo}>
                    {tipo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${t("Remover campo")} ${f.label || i + 1}`}
              onClick={() => setFields(fields.filter((_, j) => j !== i))}
            >
              <Trash size={14} aria-hidden />
            </Button>
            {tipoTemOpcoes(f.type) && (
              <Input
                className="md:col-span-3"
                aria-label={`${t("Opções do campo")} ${i + 1}`}
                placeholder={t("Opções, separadas por vírgula")}
                value={(f.options ?? []).map((o) => o.label).join(", ")}
                onChange={(e) => {
                  const options = e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map((label) => ({ value: label, label }));
                  const next = [...fields];
                  next[i] = { ...f, options };
                  setFields(next);
                }}
              />
            )}
          </div>
        ))}
        {fields.length < 50 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setFields([
                ...fields,
                { key: `campo_${fields.length + 1}`, label: t("Novo campo"), type: "text" },
              ])
            }
          >
            <Plus size={14} aria-hidden className="mr-1" /> {t("Adicionar campo")}
          </Button>
        )}
      </div>

      <div className="flex sm:justify-end">
        <Button onClick={handleSave} disabled={isPending} className="w-full sm:w-auto">
          {isPending ? t("Salvando…") : t("Salvar vocabulário e campos")}
        </Button>
      </div>
    </div>
  );
}
