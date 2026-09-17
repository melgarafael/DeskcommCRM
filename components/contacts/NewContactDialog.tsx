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
import type { Contact } from "@/lib/types/contacts";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  cpf?: string;
  tagsRaw?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /**
   * Nome já digitado por quem chamou, para não redigitar. Quem abre com um termo
   * de busca em mãos passa aqui; o resto continua abrindo vazio.
   *
   * É `defaultValue` do formulário, então só vale na montagem — quem precisa
   * trocar o termo com o diálogo já montado remonta com `key`.
   */
  nomeInicial?: string;
  /**
   * Recebe o contato recém-criado. Existe para quem abriu o diálogo NO MEIO de
   * outro fluxo (marcar um horário, por exemplo) poder seguir com ele já
   * selecionado, em vez de mandar a pessoa procurar de novo o que acabou de criar.
   */
  onCriado?: (contato: Contact) => void;
}

export function NewContactDialog({ open, onOpenChange, nomeInicial, onCriado }: Props) {
  const t = useT();
  const create = useCreateContact();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<FormShape>({
    defaultValues: { name: nomeInicial ?? "", email: "", phone_number: "", cpf: "", tagsRaw: "" },
  });

  async function onSubmit(values: FormShape) {
    setServerError(null);
    const tags = (values.tagsRaw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const payload: Record<string, unknown> = { source: "manual" };
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    if (values.cpf?.trim()) payload.cpf = values.cpf.trim();
    if (tags.length) payload.tags = tags;

    const parsed = contactCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setServerError(first?.message ?? t("Dados inválidos"));
      return;
    }

    try {
      const resposta = await create.mutateAsync(parsed.data as ContactCreate);
      toast.success(t("Contato criado"));
      form.reset();
      onOpenChange(false);
      // `.data` é o envelope do `ok()`, e dentro dele mora `{ contact, action }`.
      // Entregar `resposta.data` aqui devolveria esse envelope como se fosse o
      // contato: o `id` sairia `undefined` e a marcação ficaria sem ninguém, em
      // silêncio. Quem garante que este caminho não volta a errar é o tipo do
      // hook, ligado ao retorno da rota.
      if (resposta?.data?.contact) onCriado?.(resposta.data.contact);
    } catch {
      // error toast already handled by hook
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Novo contato")}</DialogTitle>
          <DialogDescription>
            {t("Preencha pelo menos um identificador (email ou telefone).")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t("Nome")}</Label>
            <Input id="name" {...form.register("name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t("Email")}</Label>
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
          <div className="space-y-2">
            <Label htmlFor="cpf">{t("CPF (opcional)")}</Label>
            <Input id="cpf" placeholder="00000000000" {...form.register("cpf")} />
          </div>
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
              {create.isPending ? t("Criando…") : t("Criar contato")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
