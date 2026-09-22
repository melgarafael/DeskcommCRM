"use client";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
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
import { Label } from "@/components/ui/label";
import { contactPatchSchema, type ContactPatch } from "@/lib/schemas/contacts";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import type { Contact } from "@/lib/types/contacts";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { formatarCnpj } from "@/lib/brasil/cnpj";

import { CnpjLookup } from "./CnpjLookup";
import { EnderecoFields, type ValoresEndereco } from "./EnderecoFields";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  cpf?: string;
  cnpj?: string;
  fantasia?: string;
  ie?: string;
  tagsRaw?: string;
}

interface Props {
  contact: Contact;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

function enderecoDe(c: Contact): ValoresEndereco {
  return {
    logradouro: c.logradouro ?? "",
    numero_end: c.numero_end ?? "",
    complemento: c.complemento ?? "",
    bairro: c.bairro ?? "",
    cidade: c.cidade ?? "",
    uf: c.uf ?? "",
    cep: c.cep ?? "",
  };
}

/** Edição com os mesmos cards PF/PJ da criação (0230). */
export function EditContactDialog({ contact, open, onOpenChange }: Props) {
  const t = useT();
  const update = useUpdateContact(contact.id);
  const [serverError, setServerError] = useState<string | null>(null);
  const [tipo, setTipo] = useState<"F" | "J">(contact.tipo_pessoa ?? (contact.cnpj ? "J" : "F"));
  const [endereco, setEndereco] = useState<ValoresEndereco>(() => enderecoDe(contact));

  const form = useForm<FormShape>({
    defaultValues: {
      name: contact.name ?? "",
      email: contact.email ?? "",
      phone_number: contact.phone_number ? phoneForDisplay(contact.phone_number) : "",
      cnpj: contact.cnpj ? formatarCnpj(contact.cnpj) : "",
      fantasia: contact.fantasia ?? "",
      ie: contact.ie ?? "",
      tagsRaw: contact.tags.join(", "),
    },
  });

  useEffect(() => {
    if (open) {
      setTipo(contact.tipo_pessoa ?? (contact.cnpj ? "J" : "F"));
      setEndereco(enderecoDe(contact));
      form.reset({
        name: contact.name ?? "",
        email: contact.email ?? "",
        phone_number: contact.phone_number ? phoneForDisplay(contact.phone_number) : "",
        cnpj: contact.cnpj ? formatarCnpj(contact.cnpj) : "",
        fantasia: contact.fantasia ?? "",
        ie: contact.ie ?? "",
        tagsRaw: contact.tags.join(", "),
      });
    }
  }, [open, contact, form]);

  async function onSubmit(values: FormShape) {
    setServerError(null);

    const payload: Record<string, unknown> = { tipo_pessoa: tipo };
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    if (tipo === "J") {
      payload.cnpj = values.cnpj?.trim() ? values.cnpj.trim() : null;
      payload.fantasia = values.fantasia?.trim() ? values.fantasia.trim() : null;
      payload.ie = values.ie?.trim() ? values.ie.trim() : null;
    }
    const e = endereco;
    payload.logradouro = e.logradouro.trim() || null;
    payload.numero_end = e.numero_end.trim() || null;
    payload.complemento = e.complemento.trim() || null;
    payload.bairro = e.bairro.trim() || null;
    payload.cidade = e.cidade.trim() || null;
    payload.uf = e.uf.trim() || null;
    payload.cep = e.cep.trim() || null;
    payload.tags = (values.tagsRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

    const parsed = contactPatchSchema.safeParse(payload);
    if (!parsed.success) {
      setServerError(parsed.error.issues[0]?.message ?? t("Dados inválidos"));
      return;
    }
    try {
      await update.mutateAsync(parsed.data as ContactPatch);
      toast.success(t("Cliente atualizado"));
      onOpenChange(false);
    } catch {
      // hook handles toast
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Editar cliente")}</DialogTitle>
          <DialogDescription>{t("Atualize os dados deste cliente.")}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2" role="tablist" aria-label={t("Tipo de pessoa")}>
          <Button
            type="button"
            size="sm"
            variant={tipo === "J" ? "default" : "outline"}
            onClick={() => setTipo("J")}
            role="tab"
            aria-selected={tipo === "J"}
          >
            {t("Pessoa jurídica")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={tipo === "F" ? "default" : "outline"}
            onClick={() => setTipo("F")}
            role="tab"
            aria-selected={tipo === "F"}
          >
            {t("Pessoa física")}
          </Button>
        </div>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {tipo === "J" && (
            <fieldset className="space-y-3 rounded-2xl border p-3">
              <legend className="px-1 text-sm font-medium">{t("Empresa")}</legend>
              <CnpjLookup
                id="ec-cnpj"
                valor={form.watch("cnpj") ?? ""}
                aoMudar={(v) => form.setValue("cnpj", v)}
                aoPreencher={(d) => {
                  form.setValue("cnpj", d.cnpj);
                  if (d.name) form.setValue("name", d.name);
                  if (d.email) form.setValue("email", d.email);
                  if (d.phone_number) form.setValue("phone_number", d.phone_number);
                  if (d.fantasia) form.setValue("fantasia", d.fantasia);
                  setEndereco({
                    logradouro: d.logradouro ?? "",
                    numero_end: d.numero_end ?? "",
                    complemento: "",
                    bairro: d.bairro ?? "",
                    cidade: d.cidade ?? "",
                    uf: d.uf ?? "",
                    cep: d.cep ?? "",
                  });
                }}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="ec-fantasia">{t("Nome fantasia")}</Label>
                  <Input id="ec-fantasia" {...form.register("fantasia")} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ec-ie">{t("Inscrição estadual")}</Label>
                  <Input id="ec-ie" {...form.register("ie")} />
                </div>
              </div>
            </fieldset>
          )}
          <div className="space-y-2">
            <Label htmlFor="ec-name">{tipo === "J" ? t("Razão social") : t("Nome completo")}</Label>
            <Input id="ec-name" {...form.register("name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-email">Email</Label>
            <Input id="ec-email" type="email" {...form.register("email")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-phone">{t("Telefone (E.164)")}</Label>
            <Input id="ec-phone" {...form.register("phone_number")} />
          </div>
          <EnderecoFields
            idPrefixo="ec"
            valores={endereco}
            aoMudar={(campo, valor) => setEndereco((a) => ({ ...a, [campo]: valor }))}
          />
          <div className="space-y-2">
            <Label htmlFor="ec-tags">Tags</Label>
            <Input id="ec-tags" {...form.register("tagsRaw")} />
          </div>
          {serverError && <p className="text-sm text-error-fg">{serverError}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={update.isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
