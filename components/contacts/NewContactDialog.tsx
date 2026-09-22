"use client";
import { useState } from "react";
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
import { contactCreateSchema, type ContactCreate } from "@/lib/schemas/contacts";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";

import { CnpjLookup } from "./CnpjLookup";
import { ENDERECO_VAZIO, EnderecoFields, type ValoresEndereco } from "./EnderecoFields";

interface FormShape {
  name?: string;
  display_name?: string;
  email?: string;
  phone_number?: string;
  cpf?: string;
  cnpj?: string;
  fantasia?: string;
  ie?: string;
  tagsRaw?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/**
 * Novo cliente com CARDS PF/PJ: o toggle troca o bloco fiscal (CPF x
 * CNPJ + busca na Receita + fantasia + IE) e o endereço é sempre o mesmo
 * bloco — igual à ficha do Mercos, onde endereço nunca falta.
 */
export function NewContactDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const create = useCreateContact();
  const [serverError, setServerError] = useState<string | null>(null);
  const [tipo, setTipo] = useState<"F" | "J">("J");
  const [endereco, setEndereco] = useState<ValoresEndereco>(ENDERECO_VAZIO);

  const form = useForm<FormShape>({
    defaultValues: { name: "", display_name: "", email: "", phone_number: "", cpf: "", cnpj: "", fantasia: "", ie: "", tagsRaw: "" },
  });

  async function onSubmit(values: FormShape) {
    setServerError(null);
    const tags = (values.tagsRaw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const payload: Record<string, unknown> = { source: "manual", tipo_pessoa: tipo };
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.display_name?.trim()) payload.display_name = values.display_name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    if (tipo === "F") {
      if (values.cpf?.trim()) payload.cpf = values.cpf.trim();
    } else {
      if (values.cnpj?.trim()) payload.cnpj = values.cnpj.trim();
      if (values.fantasia?.trim()) payload.fantasia = values.fantasia.trim();
      if (values.ie?.trim()) payload.ie = values.ie.trim();
    }
    const e = endereco;
    if (e.logradouro.trim()) payload.logradouro = e.logradouro.trim();
    if (e.numero_end.trim()) payload.numero_end = e.numero_end.trim();
    if (e.complemento.trim()) payload.complemento = e.complemento.trim();
    if (e.bairro.trim()) payload.bairro = e.bairro.trim();
    if (e.cidade.trim()) payload.cidade = e.cidade.trim();
    if (e.uf.trim()) payload.uf = e.uf.trim();
    if (e.cep.trim()) payload.cep = e.cep.trim();
    if (tags.length) payload.tags = tags;

    const parsed = contactCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setServerError(first?.message ?? t("Dados inválidos"));
      return;
    }

    try {
      await create.mutateAsync(parsed.data as ContactCreate);
      toast.success(t("Cliente criado"));
      form.reset();
      setEndereco(ENDERECO_VAZIO);
      onOpenChange(false);
    } catch {
      // error toast already handled by hook
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Novo cliente")}</DialogTitle>
          <DialogDescription>
            {t("Preencha pelo menos um identificador (email ou telefone).")}
          </DialogDescription>
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
          {tipo === "J" ? (
            <fieldset className="space-y-3 rounded-2xl border p-3">
              <legend className="px-1 text-sm font-medium">{t("Empresa")}</legend>
              <CnpjLookup
                id="cnpj"
                valor={form.watch("cnpj") ?? ""}
                aoMudar={(v) => form.setValue("cnpj", v)}
                aoPreencher={(d) => {
                  form.setValue("cnpj", d.cnpj);
                  form.setValue("name", d.name);
                  if (d.display_name) form.setValue("display_name", d.display_name);
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
              <div className="space-y-2">
                <Label htmlFor="name">{t("Razão social")}</Label>
                <Input id="name" {...form.register("name")} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="fantasia">{t("Nome fantasia")}</Label>
                  <Input id="fantasia" {...form.register("fantasia")} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ie">{t("Inscrição estadual")}</Label>
                  <Input id="ie" placeholder="ISENTO" {...form.register("ie")} />
                </div>
              </div>
            </fieldset>
          ) : (
            <fieldset className="space-y-3 rounded-2xl border p-3">
              <legend className="px-1 text-sm font-medium">{t("Pessoa")}</legend>
              <div className="space-y-2">
                <Label htmlFor="name">{t("Nome completo")}</Label>
                <Input id="name" {...form.register("name")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cpf">{t("CPF")}</Label>
                <Input id="cpf" placeholder="00000000000" inputMode="numeric" {...form.register("cpf")} />
              </div>
            </fieldset>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" {...form.register("email")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone_number">{t("Telefone (E.164)")}</Label>
            <Input
              id="phone_number"
              placeholder="+5511999998888"
              {...form.register("phone_number")}
            />
          </div>
          <EnderecoFields
            idPrefixo="novo"
            valores={endereco}
            aoMudar={(campo, valor) => setEndereco((a) => ({ ...a, [campo]: valor }))}
          />
          <div className="space-y-2">
            <Label htmlFor="tagsRaw">{t("Tags (separadas por vírgula)")}</Label>
            <Input id="tagsRaw" placeholder="vip, recompra" {...form.register("tagsRaw")} />
          </div>
          {serverError && (
            <p className="text-sm text-error-fg">{serverError}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t("Criando…") : t("Criar cliente")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
