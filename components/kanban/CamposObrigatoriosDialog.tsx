"use client";
import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { parseReaisToCents } from "@/lib/money";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileUploadCustomField } from "@/components/kanban/FileUploadCustomField";
import type { RecusaDeCampos } from "@/hooks/kanban/useMoveCard";

/**
 * O DIAGNÓGICO EM FORMULÁRIO — o outro lado do 422 `required_fields_missing`
 * (issue #1536).
 *
 * ─── Por que diálogo e não toast ───────────────────────────────────────────
 *
 * O quadro pedia para mover o card; o servidor recusou dizendo QUAIS campos
 * faltam (`details.faltando`, chave + rótulo + tipo). Um toast jogaria essa
 * lista fora: a pessoa veria "deu errado" sem caminho, fecharia o card e
 * perderia a posição que arrastou. Este diálogo é o mesmo formato da janela de
 * perder (`LoseLeadDialog`), com uma diferença de contrato: ele NÃO grava nada
 * sozinho — ele devolve os valores para o `useMoveCard` reenviar o MESMO move
 * com `custom_fields` junto, e a etapa e os campos saem numa escrita só.
 *
 * ─── O que ele não faz ─────────────────────────────────────────────────────
 *
 * Não valida vocabulário (o servidor é quem sabe a lista do funil), não
 * grava antes de mover (a janela entre dois writes é o defeito da #917) e não
 * adivinha o tipo: o que vem em `tipo` é o que o funil declarou, e tipo
 * desconhecido vira texto — erro de leitura não pode virar input ilegível.
 */
interface CamposObrigatoriosDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A recusa que abriu este diálogo — argumentos originais + o que falta. */
  recusa: RecusaDeCampos | null;
  /** Envia o move de novo, com os valores coletados na MESMA escrita. */
  onConfirmar: (valores: { customFields: Record<string, unknown>; wonReason?: string }) => void;
  /** Enquanto o reenvio não responde, o botão fica travado. */
  isPending?: boolean;
}

/** `won_reason` NÃO é campo do funil: sai como parâmetro próprio do move. */
const CHAVE_DO_MOTIVO_DE_GANHO = "won_reason";

function inputHtmlParaTipo(tipo: string | undefined): string {
  switch (tipo) {
    case "date":
      return "date";
    case "number":
      return "number";
    case "currency":
      return "text";
    case "email":
      return "email";
    case "phone":
      return "tel";
    case "url":
      return "url";
    default:
      return "text";
  }
}

export function CamposObrigatoriosDialog({
  open,
  onOpenChange,
  recusa,
  onConfirmar,
  isPending = false,
}: CamposObrigatoriosDialogProps) {
  const t = useT();
  const [valores, setValores] = useState<Record<string, unknown>>({});

  // Troca de recusa zera o formulário: um diálogo reaproveitado com os valores
  // do card anterior pediria ao operador para confirmar dados que não são dele.
  useEffect(() => {
    if (open) setValores({});
  }, [open, recusa]);

  if (!recusa) return null;

  const campos = recusa.faltando;

  const valido = campos.every((campo) => {
    if (campo.tipo === "boolean") return true;
    if (campo.tipo === "file") {
      const v = valores[campo.chave];
      if (!v) return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "string") {
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) && parsed.length > 0;
        } catch {
          return false;
        }
      }
      return false;
    }
    const valor = String(valores[campo.chave] ?? "").trim();
    if (valor.length === 0) return false;
    if (campo.tipo === "number" && Number.isNaN(Number(valor))) return false;
    if (campo.tipo === "currency" && parseReaisToCents(valor.replace(/^R\$\s*/i, "")) === null) return false;
    if (campo.tipo === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor)) return false;
    if (campo.tipo === "url") {
      try {
        new URL(valor);
      } catch {
        return false;
      }
    }
    return true;
  });

  const confirmar = () => {
    if (!valido || isPending) return;
    const customFields: Record<string, unknown> = {};
    let wonReason: string | undefined;
    for (const campo of campos) {
      const bruto = valores[campo.chave];
      if (campo.tipo === "boolean") {
        customFields[campo.chave] = bruto === "true" || bruto === true;
        continue;
      }
      if (campo.tipo === "file") {
        if (Array.isArray(bruto)) {
          customFields[campo.chave] = bruto;
        } else if (typeof bruto === "string") {
          try {
            customFields[campo.chave] = JSON.parse(bruto);
          } catch {
            customFields[campo.chave] = [];
          }
        } else {
          customFields[campo.chave] = [];
        }
        continue;
      }
      const valor = String(bruto ?? "").trim();
      if (campo.tipo === "number") {
        customFields[campo.chave] = Number(valor);
        continue;
      }
      if (campo.tipo === "currency") {
        customFields[campo.chave] = (parseReaisToCents(valor.replace(/^R\$\s*/i, "")) ?? 0) / 100;
        continue;
      }
      if (campo.chave === CHAVE_DO_MOTIVO_DE_GANHO) {
        wonReason = valor;
        continue;
      }
      customFields[campo.chave] = valor;
    }
    onConfirmar({ customFields, ...(wonReason !== undefined ? { wonReason } : {}) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Campos obrigatórios")}</DialogTitle>
          <DialogDescription>
            {t(
              "Este funil exige alguns dados antes de mover o negócio. Preencha o que falta para continuar.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {campos.map((campo) => {
            const nome = campo.chave === "won_reason" ? t("Motivo do ganho") : campo.rotulo;
            const rotuloCampo = `${nome}${campo.tipo === "boolean" ? "" : " *"}`;
            if (campo.tipo === "boolean") {
              return (
                <div key={campo.chave} className="flex items-center gap-2">
                  <input
                    id={`campo-${campo.chave}`}
                    type="checkbox"
                    className="checkbox"
                    checked={(valores[campo.chave] ?? "") === "true"}
                    onChange={(e) =>
                      setValores((v) => ({
                        ...v,
                        [campo.chave]: e.target.checked ? "true" : "false",
                      }))
                    }
                  />
                  <Label htmlFor={`campo-${campo.chave}`} className="text-sm">
                    {rotuloCampo}
                  </Label>
                </div>
              );
            }
            if (campo.tipo === "file") {
              return (
                <div key={campo.chave} className="space-y-1">
                  <FileUploadCustomField
                    fieldKey={campo.chave}
                    label={nome}
                    required
                    leadId={recusa.args.leadId}
                    value={valores[campo.chave]}
                    onChange={(files) =>
                      setValores((v) => ({
                        ...v,
                        [campo.chave]: files,
                      }))
                    }
                  />
                </div>
              );
            }
            if (campo.tipo === "select" && campo.opcoes && campo.opcoes.length > 0) {
              return (
                <div key={campo.chave} className="space-y-1">
                  <Label className="text-xs">{rotuloCampo}</Label>
                  <Select
                    value={String(valores[campo.chave] ?? "")}
                    onValueChange={(valor) => setValores((v) => ({ ...v, [campo.chave]: valor }))}
                  >
                    <SelectTrigger aria-label={nome}>
                      <SelectValue placeholder={t("Selecione…")} />
                    </SelectTrigger>
                    <SelectContent>
                      {campo.opcoes.map((opcao) => (
                        <SelectItem key={opcao.value} value={opcao.value}>
                          {opcao.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            }
            if (campo.tipo === "textarea") {
              return (
                <div key={campo.chave} className="space-y-1">
                  <Label className="text-xs">{rotuloCampo}</Label>
                  <Textarea
                    aria-label={nome}
                    value={String(valores[campo.chave] ?? "")}
                    onChange={(e) => setValores((v) => ({ ...v, [campo.chave]: e.target.value }))}
                  />
                </div>
              );
            }
            return (
              <div key={campo.chave} className="space-y-1">
                <Label className="text-xs">{rotuloCampo}</Label>
                <Input
                  aria-label={nome}
                  type={inputHtmlParaTipo(campo.tipo)}
                  inputMode={campo.tipo === "currency" ? "decimal" : undefined}
                  placeholder={campo.tipo === "currency" ? "R$ 1.250,00" : undefined}
                  value={String(valores[campo.chave] ?? "")}
                  onChange={(e) => setValores((v) => ({ ...v, [campo.chave]: e.target.value }))}
                />
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={confirmar} disabled={!valido || isPending}>
            {isPending ? t("Salvando…") : t("Mover agora")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
