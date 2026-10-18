"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { PIX_KEYS_QUERY, type PixKey } from "@/hooks/inbox/usePixKeys";
import type { PixKeyType } from "@/lib/schemas/pix";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canShare: boolean;
  pixKey?: PixKey | null;
}

const TIPOS: { value: PixKeyType; label: string }[] = [
  { value: "cpf", label: "CPF" },
  { value: "cnpj", label: "CNPJ" },
  { value: "email", label: "E-mail" },
  { value: "random", label: "Chave aleatória" },
  { value: "phone", label: "Celular" },
];

export function PixKeyFormDialog({ open, onOpenChange, canShare, pixKey }: Props) {
  const t = useT();
  const isEdit = !!pixKey;
  const [name, setName] = React.useState("");
  const [keyType, setKeyType] = React.useState<PixKeyType>("cpf");
  const [keyValue, setKeyValue] = React.useState("");
  /** true = Todos (compartilhado); false = Somente eu. */
  const [shared, setShared] = React.useState(true);

  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async (input: {
      name: string;
      key_type: PixKeyType;
      key_value: string;
      shared: boolean;
    }) => apiClient.post<{ data: PixKey }>("/api/v1/pix-keys", input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: PIX_KEYS_QUERY }),
  });
  const update = useMutation({
    mutationFn: async ({
      id,
      ...input
    }: {
      id: string;
      name: string;
      key_type: PixKeyType;
      key_value: string;
    }) => apiClient.patch<{ data: PixKey }>(`/api/v1/pix-keys/${id}`, input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: PIX_KEYS_QUERY }),
  });
  const pending = create.isPending || update.isPending;

  React.useEffect(() => {
    if (!open) return;
    setName(pixKey?.name ?? "");
    setKeyType(pixKey?.key_type ?? "cpf");
    setKeyValue(pixKey?.key_value ?? "");
    setShared(pixKey ? pixKey.owner_user_id === null : canShare);
  }, [open, pixKey, canShare]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (isEdit) {
        await update.mutateAsync({
          id: pixKey.id,
          name,
          key_type: keyType,
          key_value: keyValue,
        });
        toast.success(t("Chave Pix atualizada."));
      } else {
        await create.mutateAsync({
          name,
          key_type: keyType,
          key_value: keyValue,
          shared: canShare ? shared : false,
        });
        toast.success(t("Chave Pix criada."));
      }
      onOpenChange(false);
    } catch {
      /* showApiError */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? t("Editar chave Pix") : t("Nova Chave Pix")}</DialogTitle>
          <DialogDescription>
            {t("Nome do recebedor exibido no card Pix enviado ao contato.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pix-name">{t("Nome da chave Pix")} *</Label>
            <Input
              id="pix-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("Nome do recebedor")}
              minLength={1}
              maxLength={80}
              required
            />
            <p className="text-xs text-muted-foreground">
              {t("Por padrão use o nome da tenância ou do recebedor real.")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pix-type">{t("Tipo da chave")} *</Label>
            <select
              id="pix-type"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={keyType}
              onChange={(e) => setKeyType(e.target.value as PixKeyType)}
              required
            >
              {TIPOS.map((op) => (
                <option key={op.value} value={op.value}>
                  {t(op.label)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pix-value">{t("Chave Pix")} *</Label>
            <Input
              id="pix-value"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              placeholder={
                keyType === "cpf"
                  ? "00000000000"
                  : keyType === "email"
                    ? "email@exemplo.com"
                    : keyType === "phone"
                      ? "+5511999999999"
                      : ""
              }
              required
            />
          </div>
          {canShare && !isEdit && (
            <div className="space-y-2">
              <Label>{t("Quem pode utilizar")} *</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={cn(
                    "flex-1 rounded-md border px-3 py-2 text-sm",
                    shared
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background hover:bg-muted",
                  )}
                  onClick={() => setShared(true)}
                >
                  {t("Todos")}
                </button>
                <button
                  type="button"
                  className={cn(
                    "flex-1 rounded-md border px-3 py-2 text-sm",
                    !shared
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background hover:bg-muted",
                  )}
                  onClick={() => setShared(false)}
                >
                  {t("Somente eu")}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                {shared
                  ? t("Disponível para todos os usuários")
                  : t("Disponível apenas para você")}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={pending}>
              {t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
