"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { WebhookFormField } from "@/lib/webhooks/formulario";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  fields: WebhookFormField[];
  onChange: (fields: WebhookFormField[]) => void;
}

function novaChave(fields: WebhookFormField[]): string {
  let indice = fields.length + 1;
  let chave = `pergunta_${indice}`;
  while (fields.some((field) => field.key === chave)) {
    indice += 1;
    chave = `pergunta_${indice}`;
  }
  return chave;
}

export function WebhookFormFieldsEditor({ fields, onChange }: Props) {
  const t = useT();
  const atualizar = (index: number, patch: Partial<WebhookFormField>) => {
    onChange(fields.map((field, i) => (i === index ? { ...field, ...patch } : field)));
  };

  return (
    <div className="space-y-3">
      {fields.map((field, index) => (
        <div key={`${field.key}-${index}`} className="space-y-3 rounded-sm border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium text-text">
              {t("Pergunta")} {index + 1}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(fields.filter((_, i) => i !== index))}
            >
              {t("Remover")}
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`webhook-field-label-${index}`}>{t("Pergunta exibida")}</Label>
              <Input
                id={`webhook-field-label-${index}`}
                value={field.label}
                maxLength={120}
                onChange={(event) => atualizar(index, { label: event.target.value })}
                placeholder={t("Qual serviço você procura?")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`webhook-field-key-${index}`}>{t("Chave enviada ao CRM")}</Label>
              <Input
                id={`webhook-field-key-${index}`}
                value={field.key}
                maxLength={40}
                onChange={(event) => atualizar(index, { key: event.target.value })}
                placeholder="servico_procurado"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="min-w-48 flex-1 space-y-1">
              <Label>{t("Tipo de resposta")}</Label>
              <Select
                value={field.type}
                onValueChange={(value) =>
                  atualizar(index, {
                    type: value as WebhookFormField["type"],
                    options: value === "select" ? field.options?.length ? field.options : ["Opção 1"] : undefined,
                  })
                }
              >
                <SelectTrigger aria-label={t("Tipo de resposta")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">{t("Texto curto")}</SelectItem>
                  <SelectItem value="textarea">{t("Texto longo")}</SelectItem>
                  <SelectItem value="number">{t("Número")}</SelectItem>
                  <SelectItem value="currency">{t("Moeda (BRL)")}</SelectItem>
                  <SelectItem value="select">{t("Lista de opções")}</SelectItem>
                  <SelectItem value="checkbox">{t("Caixa de seleção")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 pt-5 text-sm">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(event) => atualizar(index, { required: event.target.checked })}
              />
              {t("Resposta obrigatória")}
            </label>
          </div>
          {field.type === "select" ? (
            <div className="space-y-1">
              <Label htmlFor={`webhook-field-options-${index}`}>{t("Opções, uma por linha")}</Label>
              <Textarea
                id={`webhook-field-options-${index}`}
                rows={3}
                value={(field.options ?? []).join("\n")}
                onChange={(event) =>
                  atualizar(index, {
                    // Preserva o texto cru durante a digitação: aparar cada
                    // tecla apagava o espaço final e removia linhas vazias,
                    // tornando difícil escrever opções com mais de uma palavra.
                    options: event.target.value.split("\n"),
                  })
                }
                placeholder={`${t("Sites")}\n${t("Tráfego pago")}`}
              />
            </div>
          ) : null}
        </div>
      ))}
      {fields.length < 20 ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            onChange([
              ...fields,
              { key: novaChave(fields), label: "", type: "text", required: false },
            ])
          }
        >
          + {t("Adicionar pergunta")}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{t("O limite é de 20 perguntas extras por formulário.")}</p>
      )}
    </div>
  );
}
