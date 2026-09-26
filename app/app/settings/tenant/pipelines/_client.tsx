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
import { modoDeReabertura } from "@/lib/leads/reabertura";
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

/**
 * Uma etapa do funil, do jeito que o editor de `obrigatorio_em` precisa ler.
 *
 * `is_archived` entra porque a lista É COMPLETA de propósito: descartar a etapa
 * arquivada na leitura apagaria silenciosamente a marca que alguém já fez — o
 * save regrava `fields` inteiro, então o que não aparece na tela some do
 * settings. Arquivada fica visível e marcada; ela não recebe card novo, mas
 * também não é apagada por baixo de quem a marcou.
 */
export interface EtapaDoFunil {
  id: string;
  name: string;
  is_archived: boolean;
}

/**
 * A regra `obrigatorio_em` normalizada — NADA MARCADO É AUSÊNCIA, não `{}`.
 *
 * `undefined` e `{}` significam a mesma coisa para `validaCamposExigidos`, mas
 * só o primeiro deixa o settings do funil idêntico ao de antes do #1536: gravar
 * `{ etapas: [], ao_ganhar: false, ao_perder: false }` encheria todo campo de
 * uma chave morta e faria o critério de aceite nº 3 ("sem `obrigatorio_em` o
 * comportamento é o de antes") depender de olhar para dentro do objeto.
 */
export function normalizaObrigatorioEm(
  regra: CustomFieldDef["obrigatorio_em"],
): CustomFieldDef["obrigatorio_em"] {
  const etapas = regra?.etapas ?? [];
  const aoGanhar = regra?.ao_ganhar === true;
  const aoPerder = regra?.ao_perder === true;
  if (etapas.length === 0 && !aoGanhar && !aoPerder) return undefined;
  return {
    ...(etapas.length > 0 ? { etapas } : {}),
    ...(aoGanhar ? { ao_ganhar: true } : {}),
    ...(aoPerder ? { ao_perder: true } : {}),
  };
}

/** Liga/desliga UMA etapa na regra do campo, sem mexer no resto da marca. */
export function comEtapa(
  regra: CustomFieldDef["obrigatorio_em"],
  etapaId: string,
  marcada: boolean,
): CustomFieldDef["obrigatorio_em"] {
  const etapas = new Set(regra?.etapas ?? []);
  if (marcada) etapas.add(etapaId);
  else etapas.delete(etapaId);
  return normalizaObrigatorioEm({ ...regra, etapas: [...etapas] });
}

/** Liga/desliga um dos dois gatilhos de FECHAMENTO (`ao_ganhar`/`ao_perder`). */
export function comGatilho(
  regra: CustomFieldDef["obrigatorio_em"],
  gatilho: "ao_ganhar" | "ao_perder",
  marcado: boolean,
): CustomFieldDef["obrigatorio_em"] {
  return normalizaObrigatorioEm({ ...regra, [gatilho]: marcado });
}

function readLostReasons(settings: Record<string, unknown> | null): string[] {
  if (!settings) return [];
  const r = (settings as { lost_reasons?: unknown }).lost_reasons;
  return Array.isArray(r) ? (r as string[]) : [];
}


function readWonReasons(settings: Record<string, unknown> | null): string[] {
  const r = (settings as { won_reasons?: unknown } | null)?.won_reasons;
  return Array.isArray(r) ? r.filter((v): v is string => typeof v === "string") : [];
}
export function PipelinesClient({
  pipelines,
  etapas = {},
  podeEditarConfig,
}: {
  pipelines: PipelineRow[];
  /**
   * As etapas de cada funil por id de funil — o que o editor de `obrigatorio_em`
   * oferece como "exigir ao entrar aqui". Opcional só para os testes que não
   * exercitam esta regra; a página sempre manda.
   */
  etapas?: Record<string, EtapaDoFunil[]>;
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
          {podeEditarConfig && <PipelineEditor pipeline={p} etapas={etapas[p.id] ?? []} />}
        </Card>
      ))}
    </div>
  );
}

function PipelineEditor({
  pipeline,
  etapas,
}: {
  pipeline: PipelineRow;
  etapas: EtapaDoFunil[];
}) {
  const t = useT();
  const v = pipeline.vocabulary ?? {};
  const [lead, setLead] = useState(v.lead ?? "Lead");
  const [deal, setDeal] = useState(v.deal ?? "Deal");
  const [won, setWon] = useState(v.won ?? "Ganho");
  const [lost, setLost] = useState(v.lost ?? "Perdido");
  const [reasonsText, setReasonsText] = useState(readLostReasons(pipeline.settings).join(", "));
  const [wonReasonsText, setWonReasonsText] = useState(readWonReasons(pipeline.settings).join(", "));
  const [wonRequired, setWonRequired] = useState(
    (pipeline.settings as { won_reason_required?: unknown } | null)?.won_reason_required === true,
  );
  const [retomaComoNovo, setRetomaComoNovo] = useState(
    modoDeReabertura(pipeline.settings) === "novo_negocio",
  );
  const [fields, setFields] = useState<CustomFieldDef[]>(camposDoFunil(pipeline.settings));
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const ok: CustomFieldDef[] = [];
    for (const f of fields) {
      // O item vazio que a vírgula deixou no input segue vivo até aqui — é o
      // preço de NÃO descartá-lo durante a digitação (ver o `onChange` das
      // opções). Ele nunca foi uma opção: `customFieldSchema` exige
      // `label.min(1)`, então filtrá-lo ANTES de validar é o que separa "acabei
      // de digitar uma vírgula" de "quero gravar uma opção em branco". É aqui
      // também que o espaço do FIM de cada opção é aparado: o `onChange` só
      // apara o início, para não apagar o espaço que a pessoa está digitando.
      const limpo = tipoTemOpcoes(f.type)
        ? {
            ...f,
            options: (f.options ?? [])
              .map((o) => ({ value: o.value.trim(), label: o.label.trim() }))
              .filter((o) => o.label !== ""),
          }
        : f;
      // A regra de `obrigatorio_em` é normalizada AQUI, e não só durante a
      // digitação: um campo que chegou do settings com `{}` ou com marca
      // desligada sai sem a chave — é o que mantém o funil idêntico ao de antes
      // do #1536 enquanto ninguém marca nada.
      const { obrigatorio_em: regraBruta, ...semRegra } = limpo;
      const regra = normalizaObrigatorioEm(regraBruta);
      const base = regra ? { ...semRegra, obrigatorio_em: regra } : semRegra;
      const parsed = customFieldSchema.safeParse(base);
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

    const wonReasons = wonReasonsText
      .split(",")
      .map((s2) => s2.trim())
      .filter((s2) => s2.length > 0);

    const patch: PipelineConfigPatch = {
      vocabulary: { lead, deal, won, lost },
      fields: ok,
      lost_reasons: reasons,
      won_reasons: wonReasons,
      won_reason_required: wonRequired,
      reabertura: retomaComoNovo ? "novo_negocio" : "mesmo_registro",
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

      <div className="space-y-1">
        <Label className="text-xs">{t("Motivos de ganho (separados por vírgula)")}</Label>
        <Input value={wonReasonsText} onChange={(e) => setWonReasonsText(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          {t(
            "Sem motivos cadastrados o motivo de ganho é texto livre. Com a lista, só o que está nela é aceito.",
          )}
        </p>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={wonRequired}
            onChange={(e) => setWonRequired(e.target.checked)}
          />
          {t("Exigir motivo de ganho ao fechar como ganho")}
        </label>
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={retomaComoNovo}
            onChange={(e) => setRetomaComoNovo(e.target.checked)}
          />
          {t("Negócio encerrado que volta abre um negócio novo")}
        </label>
        <p className="text-xs text-muted-foreground">
          {t(
            "Desligado, arrastar um negócio perdido ou ganho para uma etapa aberta reabre o mesmo negócio. Ligado, o encerrado fica como está e o quadro oferece criar uma nova tentativa com o mesmo contato.",
          )}
        </p>
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
                  // SEM `.filter(Boolean)` aqui, de propósito. O item vazio do
                  // fim é o que a vírgula acabou de criar, e ele precisa
                  // sobreviver até a pessoa digitar a palavra seguinte.
                  // Descartá-lo no mesmo instante apaga o separador da tela —
                  // digitar "Dor," some com a vírgula — e a tecla seguinte cola
                  // na palavra anterior ("Dor" + "O" vira "DorO"). Com o item
                  // vazio preservado, o `join(", ")` reescreve "Dor, " e o
                  // cursor continua onde a pessoa parou. O vazio só é descartado
                  // no `handleSave`, quando deixa de ser útil. Pelo mesmo
                  // motivo só o INÍCIO é aparado (o espaço que o `join(", ")`
                  // põe): aparar o fim apagaria o espaço recém-digitado, e
                  // "Clareamento" + " " + "D" viraria "ClareamentoD".
                  const options = e.target.value
                    .split(",")
                    .map((s) => s.trimStart())
                    .map((label) => ({ value: label, label }));
                  const next = [...fields];
                  next[i] = { ...f, options };
                  setFields(next);
                }}
              />
            )}
            {/* ── QUANDO ESTE CAMPO OBRIGA (issue #1536) ────────────────────
                O `obrigatorio_em` nasceu no schema sem nenhuma tela: quem
                operava não conseguia ligar a régua principal do PR. As três
                marcas são as que `campoExigidoNoDestino` lê — etapas de
                entrada, `ao_ganhar` e `ao_perder` — e nada mais, para a tela
                não prometer gatilho que o servidor não pergunta. */}
            <div className="space-y-1 md:col-span-4">
              <p className="text-xs font-medium">{t("Exigir o preenchimento:")}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {etapas.map((e) => (
                  <label key={e.id} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      aria-label={`${t("Exigir em")} ${e.name} — ${f.label || i + 1}`}
                      checked={f.obrigatorio_em?.etapas?.includes(e.id) ?? false}
                      onChange={(ev) => {
                        const next = [...fields];
                        next[i] = {
                          ...f,
                          obrigatorio_em: comEtapa(f.obrigatorio_em, e.id, ev.target.checked),
                        };
                        setFields(next);
                      }}
                    />
                    {e.name}
                    {e.is_archived ? ` (${t("arquivada")})` : ""}
                  </label>
                ))}
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    aria-label={`${t("Ao ganhar")} — ${f.label || i + 1}`}
                    checked={f.obrigatorio_em?.ao_ganhar === true}
                    onChange={(ev) => {
                      const next = [...fields];
                      next[i] = {
                        ...f,
                        obrigatorio_em: comGatilho(f.obrigatorio_em, "ao_ganhar", ev.target.checked),
                      };
                      setFields(next);
                    }}
                  />
                  {t("Ao ganhar")}
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    aria-label={`${t("Ao perder")} — ${f.label || i + 1}`}
                    checked={f.obrigatorio_em?.ao_perder === true}
                    onChange={(ev) => {
                      const next = [...fields];
                      next[i] = {
                        ...f,
                        obrigatorio_em: comGatilho(f.obrigatorio_em, "ao_perder", ev.target.checked),
                      };
                      setFields(next);
                    }}
                  />
                  {t("Ao perder")}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Sem marca nenhuma este campo nunca é exigido — é o comportamento de sempre. Marcado, ele precisa estar preenchido para o negócio entrar na etapa escolhida ou ser fechado como ganho/perdido.",
                )}
              </p>
            </div>
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
