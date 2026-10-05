"use client";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateLead } from "@/hooks/kanban/useCreateLead";
import type { RespostaCriacaoDeLead } from "@/hooks/kanban/useCreateLead";
import type { Stage } from "@/lib/kanban/types";
import {
  AVISO_NEGOCIO_ABERTO_EXISTENTE,
  negocioAbertoNoQuadro,
  type NegocioAbertoExistente,
} from "@/lib/leads/negocio-aberto-duplicado";
import type { Lead } from "@/lib/types/leads";
import { createLeadSchema, type CreateLeadInput } from "@/lib/schemas/leads";
import { MOEDA_PADRAO, parseReaisToCents, simboloDaMoeda } from "@/lib/money";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { Contact } from "@/lib/types/contacts";
import { EcoDoValor } from "./EcoDoValor";
import { SeletorDeContato } from "./SeletorDeContato";

interface FormShape {
  title: string;
  description: string;
  stage_id: string;
  valueReais: string;
  tagsRaw: string;
  expected_close_date: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pipelineId: string;
  stages: Stage[];
  /** Vincula o lead criado a este contato de origem (ex.: painel do Inbox). */
  contactId?: string | null;
  /** Depois do INSERT — o inbox relê o resumo para o lead novo aparecer no formulário. */
  onCreated?: () => void;
  /**
   * Negócios do funil, para a pergunta de duplicidade ANTES de criar (#1751).
   *
   * É o quadro que a página de funil já tem em mãos — sem rede, sem atraso no
   * clique. Quem abre pelo Inbox recebe só o `contactId` e não tem esta lista:
   * ali a conferência prévia não acontece, e quem avisa é a `meta.avisos` da
   * resposta (o fallback aqui embaixo). Mesmo funil é filtrado DUAS vezes —
   * aqui e em `negocioAbertoNoQuadro` — porque a duplicidade é mesmo contato +
   * mesmo funil + aberto, e depender de quem chama é como a regra se perde.
   */
  leads?: Lead[];
}

function defaultStageId(stages: Stage[]): string {
  const open = stages.find((s) => !s.is_won && !s.is_lost && !s.is_archived);
  return open?.id ?? stages[0]?.id ?? "";
}

export function NewLeadDialog({
  open,
  onOpenChange,
  pipelineId,
  stages,
  contactId,
  leads,
  onCreated,
}: Props) {
  const t = useT();
  const org = useActiveOrg();
  // Negócio NOVO nasce na moeda da organização (createLeadHandler).
  const moedaDoValor = org?.currency ?? MOEDA_PADRAO;
  const create = useCreateLead(pipelineId);
  const initialStage = useMemo(() => defaultStageId(stages), [stages]);
  // Quem abre o diálogo já sabendo o contato (Inbox) não escolhe de novo.
  const [contato, setContato] = useState<Contact | null>(null);
  // ─── O AVISO DE NEGÓCIO ABERTO DUPLICADO (issue #1751) ─────────────────────
  //
  // Guarda TAMBÉM os valores do formulário: quem chega aqui já preencheu tudo,
  // e confirmar tem de criar sem pedir para digitar de novo. `null` = não há
  // nada pendente. Declarado ANTES do bloco de reset abaixo, que o limpa —
  // use-before-declaration em render é ReferenceError, não linter.
  const [aviso, setAviso] = useState<{
    existente: NegocioAbertoExistente;
    valores: FormShape;
  } | null>(null);

  // O contato é o único campo deste diálogo que cria VÍNCULO, e o componente
  // NÃO desmonta ao fechar: o funil o mantém montado enquanto há dados
  // (`app/app/pipelines/[id]/_client.tsx`). Sem esquecê-lo, quem escolheu um
  // contato, desistiu e fechou reabre com ele ainda selecionado — e o próximo
  // negócio nasce ligado a quem o operador desistiu de usar, sem nada na tela
  // dizendo. A limpeza é feita no RENDER, comparando com o valor anterior, e
  // não em `onOpenChange`: o botão "Cancelar" chama o `onOpenChange` do PAI
  // direto, então um wrapper aqui não cobriria esse caminho. É o padrão que o
  // React documenta para ajustar estado quando uma prop muda — sem efeito, e
  // portanto sem o aviso de `react-hooks/set-state-in-effect`.
  const [estavaAberto, setEstavaAberto] = useState(open);
  if (open !== estavaAberto) {
    setEstavaAberto(open);
    // O aviso morre junto com o diálogo: reabrir para um contato novo não pode
    // reapresentar a pendência de quem desistiu no meio.
    if (!open) {
      setContato(null);
      setAviso(null);
    }
  }

  const form = useForm<FormShape>({
    defaultValues: {
      title: "",
      description: "",
      stage_id: initialStage,
      valueReais: "",
      tagsRaw: "",
      expected_close_date: "",
    },
  });

  // Reset stage_id default if stages change while dialog mounted.
  useEffect(() => {
    if (!form.getValues("stage_id") && initialStage) {
      form.setValue("stage_id", initialStage);
    }
  }, [initialStage, form]);

  /**
   * O submit normal. ANTES de qualquer chamada de rede vem a pergunta de
   * duplicidade (#1751) — se já houver um negócio aberto deste contato NESTE
   * funil, o diálogo para aqui com o link na mão e nada é criado. Quem decide
   * se o segundo nasce é a pessoa, não o banco: a 0256 proíbe o bloqueio.
   */
  async function onSubmit(values: FormShape) {
    const idDoContato = contactId ?? contato?.id ?? null;
    const existente = negocioAbertoNoQuadro(leads ?? [], {
      pipelineId,
      contactId: idDoContato,
    });
    if (existente) {
      setAviso({ existente, valores: values });
      return;
    }
    await gravar(values, false);
  }

  /** Quem confirmou o aviso: cria sem perguntar de novo (a pergunta já foi). */
  async function confirmarAviso() {
    if (!aviso) return;
    const { valores } = aviso;
    setAviso(null);
    await gravar(valores, true);
  }

  /**
   * A criação de fato. `avisoJaMostrado` é quem sabe se a pessoa JÁ viu a
   * duplicidade — é a única forma de não dizer a mesma coisa duas vezes.
   */
  async function gravar(values: FormShape, avisoJaMostrado: boolean) {
    const tags = values.tagsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const reais = values.valueReais.trim();
    let valueCents: number | null = null;
    if (reais.length > 0) {
      valueCents = parseReaisToCents(reais);
      if (valueCents === null) {
        form.setError("valueReais", { message: t("Valor inválido") });
        return;
      }
    }

    const payload: Record<string, unknown> = {
      pipeline_id: pipelineId,
      stage_id: values.stage_id,
      title: values.title.trim(),
      // A moeda NÃO vai daqui. O browser não sabe a moeda da organização, e
      // mandar "BRL" fazia toda instalação em peso ou dólar cadastrar lead em
      // real. Omitir é o conserto: quem decide é o servidor, que lê a
      // organização (`moedaDaOrganizacao`, em `createLeadHandler`).
      source: "manual",
      tags,
    };
    const idDoContato = contactId ?? contato?.id ?? null;
    if (idDoContato) payload.contact_id = idDoContato;
    if (values.description.trim()) payload.description = values.description.trim();
    if (valueCents !== null) payload.value_cents = valueCents;
    if (values.expected_close_date) payload.expected_close_date = values.expected_close_date;

    const parsed = createLeadSchema.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? t("Dados inválidos"));
      return;
    }

    try {
      const resposta = await create.mutateAsync(parsed.data as CreateLeadInput);
      // ─── O AVISO QUE CHEGA JUNTO COM A RESPOSTA (#1751) ────────────────────
      //
      // É o caminho em que NÃO dá para perguntar antes: o diálogo aberto pelo
      // Inbox recebe só o `contactId`, sem a lista de negócios do funil. A API
      // avisa sem recusar (a 0256 proíbe o bloqueio), e a tela traduz esse
      // `meta.avisos` no mesmo link do aviso prévio — nunca em silêncio.
      //
      // `avisoJaMostrado` evita a segunda chamada de quem já confirmou o aviso
      // no diálogo: a mesma duplicidade contada duas vezes ensina a ignorar.
      const meta = (resposta as RespostaCriacaoDeLead | null | undefined)?.meta;
      const avisos = meta?.avisos ?? [];
      if (!avisoJaMostrado && avisos.includes(AVISO_NEGOCIO_ABERTO_EXISTENTE)) {
        const existente = meta?.negocio_aberto_existente;
        toast.warning(t("Este contato já tem um negócio aberto neste funil."), {
          description: existente ? (
            <a
              href={`/app/pipelines/${pipelineId}?lead=${existente.id}`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {existente.title}
            </a>
          ) : undefined,
        });
      }
      toast.success(t("Lead criado"));
      onCreated?.();
      form.reset({
        title: "",
        description: "",
        stage_id: initialStage,
        valueReais: "",
        tagsRaw: "",
        expected_close_date: "",
      });
      setContato(null);
      setAviso(null);
      onOpenChange(false);
    } catch {
      // toast already shown
    }
  }

  const stageId = form.watch("stage_id");
  // Negócio sem pessoa não tem para quem o WhatsApp falar nem com quem a
  // automação casar. Dizer isso na hora vale mais que travar: quem abre o card
  // no meio da ligação e completa depois continua conseguindo, e a importação e
  // as automações seguem criando sem contato de propósito.
  const faltaContato = !contactId && !contato;

  function escolherContato(escolhido: Contact | null) {
    setContato(escolhido);
    if (escolhido && !form.getValues("title").trim()) {
      form.setValue("title", rotuloDoContato(escolhido, t));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Novo Lead")}</DialogTitle>
          <DialogDescription>
            {t("Crie um lead manualmente neste pipeline.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {!contactId && (
            <>
              <SeletorDeContato escolhido={contato} onEscolher={escolherContato} />
              {faltaContato && (
                <p className="text-xs text-muted-foreground">
                  {t("Sem contato, este lead não recebe WhatsApp nem entra nas automações.")}
                </p>
              )}
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="title">{t("Título")}</Label>
            <Input
              id="title"
              placeholder={t("Ex: Pedido Maria — combo presente")}
              {...form.register("title", { required: true, minLength: 2 })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">{t("Descrição")}</Label>
            <Textarea
              id="description"
              rows={3}
              placeholder={t("Contexto, observações, links…")}
              {...form.register("description")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("Etapa")}</Label>
            <Select
              value={stageId}
              onValueChange={(v) => form.setValue("stage_id", v)}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("Selecione a etapa")} />
              </SelectTrigger>
              <SelectContent>
                {stages
                  .filter((s) => !s.is_archived)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              {/* Negócio novo: o rótulo segue a moeda da organização, que é onde ele
                  vai nascer. `R$` em duro mentia para quem opera em euro. */}
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
                  {form.formState.errors.valueReais.message}
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
            <Label htmlFor="tagsRaw">{t("Tags (separadas por vírgula)")}</Label>
            <Input
              id="tagsRaw"
              placeholder="vip, recompra"
              {...form.register("tagsRaw")}
            />
          </div>

          {/* O AVISO SEM BLOQUEIO (#1751): aparece quando já existe negócio
              aberto deste contato NESTE funil. Ele não recusa nada — só para o
              clique e pergunta, com o link para quem já está no quadro. Recusar
              ("Não criar") fecha a pendência sem TOCAR na rede: nada é criado. */}
          {aviso && (
            <div
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-100 p-3 text-sm text-amber-950"
            >
              <p className="font-medium">
                {t("Este contato já tem um negócio aberto neste funil.")}
              </p>
              <p className="mt-1">{t("Abrir mesmo assim?")}</p>
              {/* O link é o próprio título do negócio — dado do banco, não
                  texto de interface: traduzir seria mentir sobre o que a pessoa
                  vai abrir. */}
              <a
                href={`/app/pipelines/${pipelineId}?lead=${aviso.existente.id}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block underline"
              >
                {aviso.existente.title}
              </a>
              <div className="mt-3 flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setAviso(null)}>
                  {t("Não criar")}
                </Button>
                <Button type="button" onClick={() => void confirmarAviso()}>
                  {t("Criar mesmo assim")}
                </Button>
              </div>
            </div>
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
            <Button type="submit" disabled={create.isPending || !stageId}>
              {create.isPending ? t("Criando…") : t("Criar lead")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
