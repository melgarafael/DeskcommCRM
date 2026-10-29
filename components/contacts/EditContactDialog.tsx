"use client";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { roleAtLeast } from "@/lib/auth/types";
import { PAIS_PADRAO, perfilDoPais } from "@/lib/legal/perfil-do-pais";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import { camposQueMudaram, mensagemDaRecusa, recusasDePadrao } from "@/lib/leads/padrao-do-campo";
import {
  contactPatchSchemaDoPais,
  CONTACT_TIPOS,
  type ContactPatch,
  type ContactType,
} from "@/lib/schemas/contacts";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { EtiquetasDoContato } from "@/components/contacts/EtiquetasDoContato";
import { useDefinirCorDaEtiqueta } from "@/hooks/tags/useDefinirCorDaEtiqueta";
import type { Contact } from "@/lib/types/contacts";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  /** `AAAA-MM-DD` — a MESMA forma de `contactPatchSchema` e da coluna do banco. */
  birthdate?: string;
  /**
   * Issue 3005: o papel do contato. O `Select` abaixo grava aqui; o valor sai
   * no PATCH como `contact_type` — é o único caminho de escrita do tipo pela ficha.
   */
  contact_type?: ContactType;
  /** As etiquetas do contato — o seletor com autocompletar grava esta lista. */
  tags?: string[];
  custom_fields?: Record<string, unknown>;
}

/** O rótulo de cada tipo, na língua da tela — a chave é o valor da coluna. */
const ROTULO_DO_TIPO: Record<ContactType, string> = {
  cliente: "Cliente",
  fornecedor: "Fornecedor",
};

interface Props {
  contact: Contact;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Definições vindas de `crm_pipelines.settings.fields[]`. Vazio = a seção some. */
  customFieldDefs?: CustomFieldDef[];
  /** Etiquetas já usadas na organização (`useContactTagVocabulary`). */
  vocabulario?: readonly string[] | null;
  /** `pipelines.settings.canonical_tags` do funil padrão. */
  canonicalTags?: readonly string[] | null;
}

export function EditContactDialog({
  contact,
  open,
  onOpenChange,
  customFieldDefs = [],
  vocabulario,
  canonicalTags,
}: Props) {
  const t = useT();
  const org = useActiveOrg();
  const perfil = perfilDoPais(org?.country);
  const update = useUpdateContact(contact.id);
  const { definirCor } = useDefinirCorDaEtiqueta();
  // A cor da etiqueta é VOCABULÁRIO, não da linha: quem a escreve passa por
  // `POST /api/v1/tags/vocabulario`, que exige manager + MFA. Para os outros
  // papéis a paleta nem chega ao campo — a régua é "a tela não oferece o que a
  // escrita recusa" (#2718), a MESMA do `SeletorDeCorDaEtiqueta`.
  const podeDefinirCor = roleAtLeast(org?.role, "manager");
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<FormShape>({
    defaultValues: {
      name: contact.name ?? "",
      email: contact.email ?? "",
      phone_number: contact.phone_number ? phoneForDisplay(contact.phone_number) : "",
      birthdate: contact.birthdate ?? "",
      // O tipo vem da COLUNA; ausente (cache antigo) cai no default do banco,
      // que é 'cliente' — a mesma leitura do selo do painel.
      contact_type: contact.contact_type ?? "cliente",
      tags: contact.tags,
      custom_fields: contact.custom_fields ?? {},
    },
  });

  const customFields = useWatch({ control: form.control, name: "custom_fields" });
  const tags = useWatch({ control: form.control, name: "tags" }) ?? [];
  // O valor do `Select` de tipo. `useWatch` (e não `form.watch`) para o
  // componente re-renderizar quando o tipo muda — o gatilho do Radix lê daqui.
  const tipoDeContato = useWatch({ control: form.control, name: "contact_type" }) ?? "cliente";
  // A etiqueta que o texto AINDA digitado no campo de etiquetas viraria — o
  // campo avisa pelo `onPendente`, e o `Salvar` inclui isto no payload. Sem
  // isso, quem digita e salva sem Enter perde o texto em silêncio (defeito
  // medido na tela do PR #2831).
  const [etiquetaPendente, setEtiquetaPendente] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      form.reset({
        name: contact.name ?? "",
        email: contact.email ?? "",
        phone_number: contact.phone_number ? phoneForDisplay(contact.phone_number) : "",
        birthdate: contact.birthdate ?? "",
        contact_type: contact.contact_type ?? "cliente",
        tags: contact.tags,
        custom_fields: contact.custom_fields ?? {},
      });
    }
  }, [open, contact, form]);

  // Na ficha o diálogo fica MONTADO entre aberturas, e o pendente também:
  // fechar por qualquer caminho o descarta, senão o texto de uma edição
  // cancelada entra no próximo Salvar, e um chip removido volta sozinho.
  function mudarAbertura(v: boolean) {
    if (!v) setEtiquetaPendente(null);
    onOpenChange(v);
  }

  async function onSubmit(values: FormShape) {
    setServerError(null);

    // ── O PADRÃO (#2730) ──────────────────────────────────────────────────
    //
    // A MESMA régua do servidor, mais um portão aqui: o `CustomFieldsEditor`
    // já avisa conforme se digita, mas o submit é o último degrau antes do 422
    // da API — e a frase que aparece é a DO CAMPO (`mensagem_padrao`), não
    // "dados inválidos". Sem `padrao` a lista vem vazia: o campo livre segue
    // livre, byte a byte, e nada disto acontece.
    //
    // ⚠️ Julga o DIFF, não o mapa que o formulário carrega (#2814). O
    // `CustomFieldsEditor` devolve o `custom_fields` INTEIRO a cada tecla — o
    // campo escondido por `mostrar_quando` viaja junto com o valor que ele já
    // tinha — e o portão recusava a gravação por um campo que a pessoa nem
    // tocou: trocar só o nome devolvia o erro de `idades`. Mesma conta do
    // servidor (`camposQueMudaram` → `camposAlterados`), mesmo estado anterior
    // (o contato que o diálogo recebeu para abrir).
    const recusas = recusasDePadrao(
      customFieldDefs,
      camposQueMudaram(values.custom_fields, contact.custom_fields),
    );
    if (recusas.length > 0) {
      setServerError(mensagemDaRecusa(recusas[0]!, t));
      return;
    }

    // O texto que ficou NO CAMPO sem Enter não pode sumir ao salvar (defeito
    // medido na tela do PR #2831): quem digita "cliente diamante", ou uma
    // etiqueta que já existe, e clica em Salvar espera a etiqueta gravada. O
    // campo já resolveu o pendente pela MESMA régua do Enter — reusa a grafia
    // existente, ou cria a nova — e ela entra no payload aqui.
    // A MESMA normalização da API (lib/contacts/tag-normalizada): o que a ficha
    // grava é o que o filtro `?tag=` casa (issue #1224).
    const tags = normalizarTags([
      ...(values.tags ?? []),
      ...(etiquetaPendente ? [etiquetaPendente] : []),
    ]);

    const payload: Record<string, unknown> = {};
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    // Igual aos campos de cima: só manda quando há data. O `type="date"` devolve
    // `AAAA-MM-DD` (a forma que `contactPatchSchema` e a coluna `birthdate` já
    // exigem), então o diálogo não normaliza nada — o que se digita é o que se
    // grava, e a ficha recarregada mostra a MESMA string.
    if (values.birthdate?.trim()) payload.birthdate = values.birthdate.trim();
    // O TIPO (issue 3005): sempre no payload, porque é ele que o `Select`
    // acabou de mostrar — quem abriu a ficha como cliente e salvou continua
    // cliente; quem trocou para fornecedor grava fornecedor.
    payload.contact_type = values.contact_type ?? "cliente";
    payload.tags = tags;
    // Sempre no payload, mesmo vazio: o PATCH SUBSTITUI, e é assim que apagar um
    // campo pela tela chega ao banco.
    payload.custom_fields = values.custom_fields ?? {};

    // A MESMA régua do servidor (a rota usa `contactPatchSchemaDoPais`): a
    // tela não pode recusar, com exemplo brasileiro, o que lá passaria.
    const parsed = contactPatchSchemaDoPais(perfil).safeParse(payload);
    if (!parsed.success) {
      setServerError(parsed.error.issues[0]?.message ?? t("Dados inválidos"));
      return;
    }
    try {
      await update.mutateAsync(parsed.data as ContactPatch);
      toast.success(t("Contato atualizado"));
      mudarAbertura(false);
    } catch {
      // hook handles toast
    }
  }

  return (
    <Dialog open={open} onOpenChange={mudarAbertura}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Editar contato")}</DialogTitle>
          <DialogDescription>{t("Atualize os dados deste contato.")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ec-name">{t("Nome")}</Label>
            <Input id="ec-name" {...form.register("name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-email">Email</Label>
            <Input id="ec-email" type="email" {...form.register("email")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-phone">
              {perfil.codigo === PAIS_PADRAO
                ? t("Telefone (DDD + número)")
                : t("Telefone (E.164)")}
            </Label>
            <Input id="ec-phone" {...form.register("phone_number")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-birthdate">{t("Data de nascimento")}</Label>
            <Input id="ec-birthdate" type="date" {...form.register("birthdate")} />
          </div>
          {/*
            O TIPO DE CONTATO (issue 3005, fatia 1). Não é campo de formulário
            comum (`form.register`): o `Select` do Radix devolve o valor pelo
            `onValueChange`, e é ele que grava no form. Cliente é o padrão que o
            BANCO já aplica (migration 0763) — o seletor abre mostrando o que a
            coluna diz, e a troca para Fornecedor sai no PATCH.
          */}
          <div className="space-y-2">
            <Label htmlFor="ec-contact-type">{t("Tipo de contato")}</Label>
            <Select
              value={tipoDeContato}
              onValueChange={(proximo) =>
                form.setValue("contact_type", proximo as ContactType, { shouldDirty: true })
              }
              disabled={update.isPending}
            >
              <SelectTrigger id="ec-contact-type" aria-label={t("Tipo de contato")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTACT_TIPOS.map((tipo) => (
                  <SelectItem key={tipo} value={tipo}>
                    {t(ROTULO_DO_TIPO[tipo])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("Fornecedor conversa normalmente — o tipo muda o painel, não o envio.")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-tags">{t("Tags")}</Label>
            <EtiquetasDoContato
              inputId="ec-tags"
              value={tags}
              onPendente={setEtiquetaPendente}
              onChange={(next) => form.setValue("tags", next, { shouldDirty: true })}
              vocabulario={vocabulario}
              canonicalTags={canonicalTags}
              disabled={update.isPending}
              onDefinirCor={
                podeDefinirCor ? (tag, cor) => void definirCor(tag, cor) : undefined
              }
            />
          </div>
          {customFieldDefs.length > 0 && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div>
                <h3 className="text-sm font-medium">{t("Campos personalizados")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("Campos definidos no funil padrão da organização.")}
                </p>
              </div>
              <CustomFieldsEditor
                fields={customFieldDefs}
                mode="contact"
                value={customFields ?? {}}
                onChange={(next) => form.setValue("custom_fields", next, { shouldDirty: true })}
              />
            </div>
          )}
          {serverError && (
            <p role="alert" className="text-sm text-error-fg">
              {serverError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => mudarAbertura(false)}
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
