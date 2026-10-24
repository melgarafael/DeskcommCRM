"use client";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import type { Lead } from "@/lib/types/leads";
import { updateLeadSchema, type UpdateLeadInput } from "@/lib/schemas/leads";
import { MOEDA_PADRAO, parseReaisToCents, simboloDaMoeda } from "@/lib/money";
import { soChavesAlteradas } from "@/lib/leads/custom-fields-so-diff";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { ContactTagsEditor } from "@/components/inbox/ContactTagsEditor";
import { EcoDoValor } from "./EcoDoValor";

/**
 * As etiquetas do negócio SAÍRAM deste formulário (#2979): quem as edita é o
 * `ContactTagsEditor`, que grava na hora em `crm_leads.tags`. Manter um
 * `tagsRaw` aqui seria pior do que redundância — "Salvar" reenviaria a lista
 * carregada na abertura do dossiê e DESFARIA em silêncio a etiqueta que a
 * pessoa acabou de criar no editor.
 */
interface FormShape {
  title: string;
  description: string;
  valueReais: string;
  expected_close_date: string;
}

interface Props {
  lead: Lead;
  pipelineId: string;
  fieldDefs?: CustomFieldDef[];
  /** Quando o salvamento dá certo. O dossiê NÃO fecha aqui — ver abaixo. */
  onSaved?: () => void;
  /** O dossiê não tem "cancelar"; o diálogo tem. */
  onCancel?: () => void;
}

function centsToReais(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

/**
 * Os campos do lead — extraídos do `EditLeadDialog` para o dossiê usar os
 * MESMOS, em vez de uma cópia que diverge no mês.
 *
 * `onSaved` existe para o dossiê NÃO FECHAR ao salvar: quem edita precisa ver a
 * atividade que acabou de gerar entrar na timeline. Fechar esconderia o
 * registro justamente de quem o produziu — a funcionalidade que prova "sua ação
 * fica registrada" provaria isso para todo mundo menos para o autor.
 */
export function LeadFieldsForm({ lead, pipelineId, fieldDefs = [], onSaved, onCancel }: Props) {
  const t = useT();
  const org = useActiveOrg();
  // A moeda do negócio JÁ GRAVADO vence: trocar a moeda da empresa não
  // reescreve o que nasceu antes, e o cartão e o dossiê mostram a persistida.
  const moedaDoValor = lead.currency ?? org?.currency ?? MOEDA_PADRAO;
  const edit = useEditLead(pipelineId);
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(lead.custom_fields ?? {});
  // A RÉGUA do diff (issue #2132): o valor carregado ao abrir. Só o que a
  // pessoa mudar daqui vai viajar — devolver o objeto inteiro sobrescrevia o
  // que outra pessoa (ou o MCP `crm_update_lead`) mudou com a ficha aberta.
  const [camposCarregados, setCamposCarregados] = useState<Record<string, unknown>>(
    lead.custom_fields ?? {},
  );

  const form = useForm<FormShape>({
    defaultValues: {
      title: lead.title,
      description: lead.description ?? "",
      valueReais: centsToReais(lead.value_cents),
      expected_close_date: lead.expected_close_date ?? "",
    },
  });

  useEffect(() => {
    form.reset({
      title: lead.title,
      description: lead.description ?? "",
      valueReais: centsToReais(lead.value_cents),
      expected_close_date: lead.expected_close_date ?? "",
    });
    setCustomFields(lead.custom_fields ?? {});
    setCamposCarregados(lead.custom_fields ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id]);

  async function onSubmit(values: FormShape) {
    const reais = values.valueReais.trim();
    let valueCents: number | null = null;
    if (reais.length > 0) {
      // A MESMA moeda que o rótulo do campo mostra ao lado («Valor ($)»): é ela
      // que decide se a vírgula é decimal ou separador de milhar (#3331).
      valueCents = parseReaisToCents(reais, moedaDoValor);
      if (valueCents === null) {
        form.setError("valueReais", { message: t("Valor inválido") });
        return;
      }
    }

    const patch: Record<string, unknown> = {
      title: values.title.trim(),
      description: values.description.trim() ? values.description.trim() : null,
      value_cents: valueCents,
      expected_close_date: values.expected_close_date || null,
      // Só o que a pessoa alterou (issue #2132) — o merge continua do servidor.
      ...(fieldDefs.length > 0
        ? { custom_fields: soChavesAlteradas(camposCarregados, customFields) }
        : {}),
    };

    const parsed = updateLeadSchema.safeParse(patch);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? t("Dados inválidos"));
      return;
    }

    try {
      await edit.mutateAsync({
        leadId: lead.id,
        patch: parsed.data as UpdateLeadInput,
      });
      // O que acabou de gravar vira a nova régua: o segundo salvamento não
      // reenvia o primeiro, e uma limpeza alheia no intervalo não é atropelada.
      setCamposCarregados({ ...customFields });
      toast.success(t("Lead atualizado"));
      onSaved?.();
    } catch {
      // toast already shown
    }
  }


  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="title">{t("Título")}</Label>
          <Input
            id="title"
            {...form.register("title", { required: true, minLength: 2 })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">{t("Descrição")}</Label>
          <Textarea id="description" rows={3} {...form.register("description")} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            {/* O rótulo segue a moeda do NEGÓCIO (a organização é a reserva):
                  `R$` em duro mentia para quem opera em euro. */}
            <Label htmlFor="valueReais">{t("Valor")} ({simboloDaMoeda(moedaDoValor)})</Label>
            <Input
              id="valueReais"
              inputMode="decimal"
              placeholder="0,00"
              {...form.register("valueReais")}
            />
            <EcoDoValor control={form.control} moeda={moedaDoValor} />
            {form.formState.errors.valueReais && (
              <p className="text-xs text-error-fg">
                {t(form.formState.errors.valueReais.message ?? "")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="expected_close_date">{t("Fechamento previsto")}</Label>
            <Input
              id="expected_close_date"
              type="date"
              {...form.register("expected_close_date")}
            />
          </div>
        </div>

        <div className="space-y-2">
          {/* A etiqueta do NEGÓCIO (#2979): o MESMO editor do Inbox, gravando
              na OUTRA caixa — `crm_leads.tags` por `PATCH /api/v1/leads/{id}`,
              nunca o perfil do contato. Ele grava na hora; por isso o dossiê
              não carrega mais o campo de texto livre que substituía a lista. */}
          <p className="text-sm font-medium">{t("Tags do negócio")}</p>
          <ContactTagsEditor
            entityType="lead"
            entityId={lead.id}
            pipelineId={pipelineId}
            orgId={org?.orgId ?? ""}
            tags={lead.tags ?? []}
          />
        </div>

        {fieldDefs.length > 0 && (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-sm font-medium">{t("Campos do funil")}</p>
            <CustomFieldsEditor
              fields={fieldDefs}
              value={customFields}
              onChange={setCustomFields}
              mode="lead"
              leadId={lead.id}
            />
          </div>
        )}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={edit.isPending}>
            {t("Cancelar")}
          </Button>
        )}
        <Button type="submit" disabled={edit.isPending}>
          {edit.isPending ? t("Salvando…") : t("Salvar")}
        </Button>
      </div>
    </form>
  );
}
