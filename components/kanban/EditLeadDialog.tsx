"use client";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
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
import { Textarea } from "@/components/ui/textarea";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import type { Lead } from "@/lib/types/leads";
import { updateLeadSchema, type UpdateLeadInput } from "@/lib/schemas/leads";
import { MOEDA_PADRAO, formatCents, parseReaisToCents, simboloDaMoeda } from "@/lib/money";
import { useVendasDoNegocio } from "@/hooks/vendas/useVendasRegistradas";
import { ContactTagsEditor } from "@/components/inbox/ContactTagsEditor";
import { useContact } from "@/hooks/contacts/useContact";
import { useContactList } from "@/hooks/contacts/useContactList";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { lerRecorrenciaDoFormulario } from "@/lib/leads/valor-recorrente";
import { EcoDoValor } from "./EcoDoValor";

/**
 * As etiquetas do negócio SAÍRAM deste formulário (#2979): quem as edita é o
 * `ContactTagsEditor`, que grava na hora em `crm_leads.tags`. Manter um
 * `tagsRaw` aqui seria pior do que redundância — "Salvar" reenviaria a lista
 * carregada na abertura do diálogo e DESFARIA em silêncio a etiqueta que a
 * pessoa acabou de criar no editor.
 */
interface FormShape {
  title: string;
  description: string;
  valueReais: string;
  /** Mensalidade e duração do contrato (fatia 1 da #3602), em texto. */
  valorRecorrenteReais: string;
  recorrenciaMeses: string;
  expected_close_date: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lead: Lead;
  pipelineId: string;
}

function centsToReais(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

/** Duração em meses como texto (`null` = sem prazo, que é o campo vazio). */
function mesesComoTexto(meses: number | null | undefined): string {
  return meses === null || meses === undefined ? "" : String(meses);
}

export function EditLeadDialog({ open, onOpenChange, lead, pipelineId }: Props) {
  const t = useT();
  const org = useActiveOrg();
  // A moeda do negócio JÁ GRAVADO vence: trocar a moeda da empresa não
  // reescreve o que nasceu antes, e o cartão e o dossiê mostram a persistida.
  const moedaDoValor = lead.currency ?? org?.currency ?? MOEDA_PADRAO;
  const edit = useEditLead(pipelineId);
  /**
   * O CONTATO DO NEGÓCIO JÁ CRIADO (fatia S3 da #852). O `contact_id` sempre
   * esteve no `updateLeadSchema`, mas nenhuma tela mandava: negócio que nasceu
   * pelo funil — sem contato — continuava oco para sempre. Aqui a escolha é
   * entre os contatos que JÁ EXISTEM (a busca de `GET /api/v1/contacts`); este
   * fluxo não cria contato, para não duplicar a régua de telefone do cadastro.
   */
  const [contactId, setContactId] = useState<string | null>(lead.contact_id ?? null);
  // Com venda registrada, o Valor é derivado da soma das vendas pelo banco
  // (migration 9450); o diálogo mostra a soma em leitura e não reenvia `value_cents`.
  const { data: vendas } = useVendasDoNegocio(lead.id);
  const vendasDoNegocio = Array.isArray(vendas) ? vendas : [];
  const valorPelasVendas = vendasDoNegocio.length > 0 || lead.valor_pelas_vendas === true;
  const somaDasVendas =
    vendasDoNegocio.length > 0
      ? vendasDoNegocio.reduce(
          (soma, v) => soma + (v.currency.toUpperCase() === moedaDoValor.toUpperCase() ? v.valor_cents : 0),
          0,
        )
      : (lead.value_cents ?? 0);

  const form = useForm<FormShape>({
    defaultValues: {
      title: lead.title,
      description: lead.description ?? "",
      valueReais: centsToReais(lead.value_cents),
      valorRecorrenteReais: centsToReais(lead.recurring_value_cents),
      recorrenciaMeses: mesesComoTexto(lead.recurring_months),
      expected_close_date: lead.expected_close_date ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        title: lead.title,
        description: lead.description ?? "",
        valueReais: centsToReais(lead.value_cents),
        valorRecorrenteReais: centsToReais(lead.recurring_value_cents),
        recorrenciaMeses: mesesComoTexto(lead.recurring_months),
        expected_close_date: lead.expected_close_date ?? "",
      });
      // A escolha também volta ao que está GRAVADO: abrir outro negócio no
      // mesmo diálogo não pode herdar o contato do anterior.
      setContactId(lead.contact_id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lead.id]);

  async function onSubmit(values: FormShape) {
    let valueCents: number | null = null;
    if (!valorPelasVendas) {
      const reais = values.valueReais.trim();
      if (reais.length > 0) {
        // A MESMA moeda que o rótulo do campo mostra ao lado («Valor ($)»): é ela
        // que decide se a vírgula é decimal ou separador de milhar (#3331).
        valueCents = parseReaisToCents(reais, moedaDoValor);
        if (valueCents === null) {
          form.setError("valueReais", { message: t("Valor inválido") });
          return;
        }
      }
    }

    // O RECORRENTE vai SEMPRE neste formulário, como o valor único: o diálogo
    // manda o formulário inteiro, e é isso que faz apagar o campo LIMPAR a
    // mensalidade (o `null` explícito é o "não tem mais"). A leitura é a régua
    // compartilhada com a criação e com o dossiê.
    // Apagar a mensalidade de um negócio que a TINHA leva a duração junto: é a
    // regra 1 do trio, a mesma do servidor (`recorrenciaParaGravar`). Duração
    // digitada num negócio que nunca teve mensalidade segue sendo recusa.
    const apagouAMensalidade =
      lead.recurring_value_cents != null && values.valorRecorrenteReais.trim() === "";
    const leitura = lerRecorrenciaDoFormulario(
      values.valorRecorrenteReais,
      apagouAMensalidade ? "" : values.recorrenciaMeses,
      moedaDoValor,
    );
    if (!leitura.ok) {
      form.setError(leitura.campo === "valor" ? "valorRecorrenteReais" : "recorrenciaMeses", {
        message:
          leitura.motivo === "valor_invalido"
            ? t("Valor inválido")
            : leitura.motivo === "duracao_invalida"
              ? t("Duração inválida")
              : t("Informe a mensalidade para usar a duração"),
      });
      return;
    }

    const patch: Record<string, unknown> = {
      title: values.title.trim(),
      description: values.description.trim() ? values.description.trim() : null,
      // Com venda registrada, o valor é do banco (a soma): o diálogo não o reescreve.
      ...(valorPelasVendas ? {} : { value_cents: valueCents }),
      ...leitura.trio,
      expected_close_date: values.expected_close_date || null,
    };
    // Só quando MUDOU: reenviar o contato de sempre faria o PATCH parecer uma
    // troca a cada salvamento.
    if (contactId !== (lead.contact_id ?? null)) patch.contact_id = contactId;

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
      toast.success(t("Negócio atualizado"));
      onOpenChange(false);
    } catch {
      // toast already shown
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Editar negócio")}</DialogTitle>
          <DialogDescription>
            {t("Atualize os campos. Mover de etapa ou marcar ganho/perdido tem opções próprias.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">{t("Título")}</Label>
            <Input
              id="title"
              {...form.register("title", { required: true, minLength: 2 })}
            />
          </div>

          {/* O CONTATO acima dos outros campos: é ele que decide se a IA e o
              WhatsApp têm para quem falar; o resto é o valor do negócio. */}
          <ContatoDoNegocioEscolhido contactId={contactId} onEscolher={setContactId} />

          <div className="space-y-2">
            <Label htmlFor="description">{t("Descrição")}</Label>
            <Textarea id="description" rows={3} {...form.register("description")} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              {/* O rótulo segue a moeda do NEGÓCIO (a organização é a reserva):
                  `R$` em duro mentia para quem opera em euro. */}
              <Label htmlFor="valueReais">{t("Valor")} ({simboloDaMoeda(moedaDoValor)})</Label>
              {valorPelasVendas ? (
                <>
                  <Input
                    id="valueReais"
                    readOnly
                    aria-readonly
                    data-testid="valor-pelas-vendas"
                    value={formatCents(somaDasVendas, moedaDoValor)}
                    className="bg-surface-elevated"
                  />
                  <p className="text-xs text-text-muted" data-testid="valor-pelas-vendas-legenda">
                    {vendasDoNegocio.length > 0
                      ? `${t("Soma de")} ${vendasDoNegocio.length} ${t("venda(s) registrada(s)")}`
                      : t("Soma das vendas registradas")}
                  </p>
                </>
              ) : (
                <>
                  <Input
                    id="valueReais"
                    inputMode="decimal"
                    placeholder="0,00"
                    {...form.register("valueReais")}
                  />
                  <EcoDoValor control={form.control} moeda={moedaDoValor} />
                  {form.formState.errors.valueReais && (
                    <p className="text-xs text-error-fg">
                      {form.formState.errors.valueReais.message}
                    </p>
                  )}
                </>
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

          {/* A MENSALIDADE (fatia 1 da #3602): o negócio de setup + mensalidade
              aparece com os dois valores no card, e este é o lugar de mudá-los.
              Apagar o valor recorrente limpa periodicidade e duração junto. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="valorRecorrenteReais">
                {t("Valor recorrente (mensal)")} ({simboloDaMoeda(moedaDoValor)})
              </Label>
              <Input
                id="valorRecorrenteReais"
                inputMode="decimal"
                placeholder="0,00"
                {...form.register("valorRecorrenteReais")}
              />
              <EcoDoValor
                control={form.control}
                moeda={moedaDoValor}
                campo="valorRecorrenteReais"
              />
              {form.formState.errors.valorRecorrenteReais && (
                <p className="text-xs text-error-fg">
                  {form.formState.errors.valorRecorrenteReais.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="recorrenciaMeses">{t("Duração (meses)")}</Label>
              <Input
                id="recorrenciaMeses"
                inputMode="numeric"
                placeholder={t("sem prazo")}
                {...form.register("recorrenciaMeses")}
              />
              {form.formState.errors.recorrenciaMeses && (
                <p className="text-xs text-error-fg">
                  {form.formState.errors.recorrenciaMeses.message}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {/* A etiqueta do NEGÓCIO (#2979): o MESMO editor do Inbox, gravando
                na OUTRA caixa — `crm_leads.tags` por `PATCH /api/v1/leads/{id}`,
                nunca o perfil do contato (`lib/types/leads.ts`). Ele grava na
                hora, como no Inbox; por isso este formulário não carrega mais
                o campo de texto livre que substituía a lista inteira. */}
            <p className="text-sm font-medium">{t("Tags do negócio")}</p>
            <ContactTagsEditor
              entityType="lead"
              entityId={lead.id}
              pipelineId={pipelineId}
              orgId={org?.orgId ?? ""}
              tags={lead.tags ?? []}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={edit.isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={edit.isPending}>
              {edit.isPending ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * O CONTATO DO NEGÓCIO, ESCOLHIDO ENTRE OS QUE JÁ EXISTEM (fatia S3 da #852).
 *
 * ─── Por que aqui, e não no cadastro ────────────────────────────────────────
 *
 * Quem cria pelo funil não passa pela tela de Contatos: o negócio nasce sem
 * ninguém, e o dossiê só sabia DIZER que faltava contato. O `contact_id` do
 * `updateLeadSchema` sempre aceitou o vínculo — faltava uma tela que o mandasse.
 *
 * ─── Por que este fluxo NÃO CRIA contato ────────────────────────────────────
 *
 * Criar aqui exigiria repetir a régua do telefone (normalização canônica,
 * E.164, duplicidade por organização) num segundo lugar — e a segunda cópia de
 * uma regra é a que diverge. Quem precisa de contato novo cria em Contatos, ou
 * usa o "Novo Lead" do Inbox, que já passa pelo mesmo cadastro. Aqui só se
 * ESCOLHE: a busca é a mesma rota da lista (`GET /api/v1/contacts?search=`), que
 * já casa variações de telefone.
 *
 * A busca só é MONTADA quando a pessoa pede: `useContactList` não tem
 * `enabled`, e um campo de busca sempre aberto custaria uma requisição de
 * contatos em todo "Editar lead" do quadro.
 */
function ContatoDoNegocioEscolhido({
  contactId,
  onEscolher,
}: {
  contactId: string | null;
  onEscolher: (id: string | null) => void;
}) {
  const t = useT();
  const [escolhendo, setEscolhendo] = useState(false);
  // `useContact` segura a chamada sem id (`enabled: !!id`): negócio oco não faz
  // requisição nenhuma só para dizer que está oco.
  const { data } = useContact(contactId ?? "");
  const vinculado = data?.data;

  return (
    <div className="space-y-2" data-testid="contato-do-negocio-no-formulario">
      <p className="text-sm font-medium">{t("Contato do negócio")}</p>
      {escolhendo ? (
        <BuscaDeContato
          onEscolher={(id) => {
            onEscolher(id);
            setEscolhendo(false);
          }}
          onFechar={() => setEscolhendo(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-sm text-text-muted">
            {contactId
              ? vinculado
                ? nomeDoContato(vinculado)
                : t("Carregando…")
              : t("Este negócio não tem contato vinculado.")}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => setEscolhendo(true)}
          >
            {contactId ? t("Trocar contato") : t("Escolher contato")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A busca em si — montada só enquanto a escolha está aberta. */
function BuscaDeContato({
  onEscolher,
  onFechar,
}: {
  onEscolher: (id: string) => void;
  onFechar: () => void;
}) {
  const t = useT();
  const [busca, setBusca] = useState("");
  const termo = busca.trim();
  const { data, isLoading } = useContactList({ search: termo || undefined, limit: 5 });
  const contatos = data?.pages[0]?.data ?? [];

  return (
    <div
      className="space-y-2 rounded-md border border-border p-2"
      data-testid="busca-de-contato-do-negocio"
    >
      <Label htmlFor="busca-de-contato" className="text-xs">
        {t("Buscar contato")}
      </Label>
      <Input
        id="busca-de-contato"
        value={busca}
        placeholder={t("Nome ou telefone")}
        onChange={(e) => setBusca(e.target.value)}
      />
      {isLoading && <p className="text-[11px] text-text-muted">{t("Carregando…")}</p>}
      {!isLoading && contatos.length === 0 && (
        <p className="text-[11px] text-text-muted">{t("Nenhum contato encontrado.")}</p>
      )}
      <ul className="space-y-1">
        {contatos.map((contato) => (
          <li key={contato.id} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 truncate">{nomeDoContato(contato)}</span>
            {contato.phone_number && (
              <span className="shrink-0 text-text-muted">{contato.phone_number}</span>
            )}
            {/* `type="button"`: dentro de `<form>`, o padrão é submit — o mesmo
                defeito que o "+" do editor de etiquetas teve (teste da #3021). */}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[11px]"
              onClick={() => onEscolher(contato.id)}
            >
              {t("Usar")}
            </Button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[11px] text-text-muted"
        onClick={onFechar}
      >
        {t("Cancelar")}
      </Button>
    </div>
  );
}
