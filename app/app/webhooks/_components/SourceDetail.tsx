"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { copyToClipboard } from "@/lib/clipboard";
import { Copy, Trash, CaretDown, PencilSimple, Check, X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import {
  useDeleteWebhookSource,
  useUpdateWebhookSource,
  useWebhookSourceEvents,
  type WebhookSourceRow,
} from "@/hooks/webhooks/useWebhookSources";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { HEADER_ASSINATURA_DE_ENTRADA } from "@/lib/webhooks/assinatura";
import {
  gerarHtmlDoFormulario,
  webhookFormFieldsSchema,
  type WebhookFormField,
} from "@/lib/webhooks/formulario";
import { useT } from "@/hooks/i18n/useT";
import { WebhookFormFieldsEditor } from "./WebhookFormFieldsEditor";

interface Props {
  source: WebhookSourceRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function publicUrl(pathToken: string): string {
  // window.location.origin > env: NEXT_PUBLIC_APP_URL é inlined no build e num
  // Docker self-host fica congelada no placeholder do Dockerfile — a origem da
  // página é o único valor confiável em runtime.
  const base =
    typeof window !== "undefined"
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_APP_URL ?? "");
  return `${base}/api/v1/webhooks/in/${pathToken}`;
}

function formSnippet(url: string, fields: readonly WebhookFormField[], t: (texto: string) => string): string {
  return gerarHtmlDoFormulario(url, fields, {
    nome: t("Seu nome"),
    telefone: t("Seu WhatsApp"),
    email: t("Seu e-mail"),
    enviar: t("Quero receber contato"),
    selecione: t("Selecione uma opção"),
  });
}

/**
 * O snippet acompanha a assinatura: com ela ligada, um `curl` sem o cabeçalho
 * leva 401, e esta seção existe justamente para ensinar a integrar. Copiar daqui
 * um exemplo que a própria fonte recusa é a pior primeira impressão possível.
 */
function curlSnippet(url: string, comAssinatura: boolean, t: (texto: string) => string): string {
  const assinatura = comAssinatura
    ? `\\\n  -H '${HEADER_ASSINATURA_DE_ENTRADA}: ${t("<HMAC-SHA256 do corpo, em hex, com o seu segredo>")}' `
    : "";
  return `curl -X POST ${url} \\\n  -H 'Content-Type: application/json' ${assinatura}\\\n  -d '{"nome":"...","telefone":"..."}'`;
}

async function copy(text: string, label: string, t: (texto: string) => string): Promise<void> {
  const ok = await copyToClipboard(text);
  if (ok) toast.success(label);
  else toast.error(t("Não foi possível copiar — selecione e copie manualmente."));
}

function relativeReceivedAt(iso: string, locale: Locale): string {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: locale });
}

/**
 * 32 bytes em hex (64 caracteres), pelo CSPRNG do navegador.
 *
 * `crypto.getRandomValues` e não `Math.random`: o valor é um segredo de
 * autenticação, e `Math.random` é previsível por construção. Não é
 * `crypto.randomUUID` pelo mesmo motivo de `lib/random-id.ts` — ele não existe
 * fora de secure context, e um self-host em `http://IP` é exatamente onde esta
 * tela roda.
 */
function gerarSecretHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function SourceDetail({ source, open, onOpenChange }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const update = useUpdateWebhookSource();
  const del = useDeleteWebhookSource();
  const { data: eventsRes, refetch: refetchEvents } = useWebhookSourceEvents(
    open ? source.id : null,
  );
  const [autorizacaoIA, setAutorizacaoIA] = React.useState<{ id: string; ativa: boolean } | null>(null);
  const autorizaIA = autorizacaoIA?.id === source.id ? autorizacaoIA.ativa : source.authorize_ai_on_capture;
  const [testing, setTesting] = React.useState(false);
  const [testOk, setTestOk] = React.useState(false);
  const [formFields, setFormFields] = React.useState<WebhookFormField[]>(source.form_fields ?? []);
  const [savedFormFields, setSavedFormFields] = React.useState<WebhookFormField[]>(source.form_fields ?? []);
  const sourceIdDosCampos = React.useRef(source.id);
  const sourceIdDoNome = React.useRef(source.id);
  const [nomeFonteSalvo, setNomeFonteSalvo] = React.useState(source.name);
  const [nomeFonteRascunho, setNomeFonteRascunho] = React.useState(source.name);
  const [editandoNome, setEditandoNome] = React.useState(false);
  const podeGerirWebhooks = usePermission("webhooks.manage");
  /**
   * `source` é um SNAPSHOT: `SourcesTab` guarda o objeto da lista num estado e
   * o passa por prop, então invalidar a query não reescreve esta prop enquanto
   * o painel está aberto. A resposta do PATCH é o dado mais fresco que esta
   * tela alcança — e os dois estados abaixo carregam o id da fonte junto para
   * não pintarem o estado de uma fonte no painel de outra.
   */
  const [assinatura, setAssinatura] = React.useState<{ id: string; ativa: boolean } | null>(null);
  /**
   * O plaintext vive AQUI e em nenhum outro lugar: some ao fechar o painel.
   *
   * O "nenhum outro lugar" só é verdade porque a mutação zera o `gcTime`
   * (`hooks/webhooks/useWebhookSources.ts`) — sem isso o TanStack guardaria as
   * `variables`, o segredo entre elas, no cache global por mais cinco minutos.
   */
  const [revelado, setRevelado] = React.useState<{ id: string; valor: string } | null>(null);

  const url = publicUrl(source.path_token);
  const events = eventsRes?.data ?? [];
  const temAssinatura = assinatura?.id === source.id ? assinatura.ativa : source.has_secret;
  const secretRevelado = revelado?.id === source.id ? revelado.valor : null;
  const formFieldsDirty = JSON.stringify(formFields) !== JSON.stringify(savedFormFields);

  const aplicarSecret = (secret: string | null, aviso: string) =>
    update.mutate(
      { id: source.id, secret },
      {
        onSuccess: (res) => {
          setAssinatura({ id: source.id, ativa: res.data.has_secret });
          // Nunca o valor no toast: ele sobrevive à troca de tela e ao print.
          setRevelado(secret === null ? null : { id: source.id, valor: secret });
          toast.success(aviso);
        },
      },
    );
  React.useEffect(() => {
    if (sourceIdDosCampos.current === source.id) return;
    sourceIdDosCampos.current = source.id;
    const fields = source.form_fields ?? [];
    setFormFields(fields);
    setSavedFormFields(fields);
  }, [source.id, source.form_fields]);

  React.useEffect(() => {
    if (sourceIdDoNome.current === source.id) return;
    sourceIdDoNome.current = source.id;
    setNomeFonteSalvo(source.name);
    setNomeFonteRascunho(source.name);
    setEditandoNome(false);
  }, [source.id, source.name]);

  const salvarNomeFonte = async () => {
    const nome = nomeFonteRascunho.trim();
    if (!nome) {
      toast.error(t("Informe um nome para a fonte."));
      return;
    }
    try {
      const res = await update.mutateAsync({ id: source.id, name: nome });
      setNomeFonteSalvo(res.data.name);
      setNomeFonteRascunho(res.data.name);
      setEditandoNome(false);
      toast.success(t("Nome da fonte atualizado."));
    } catch {
      /* erro já mostrado pelo showApiError */
    }
  };

  const salvarCamposDoFormulario = async () => {
    const normalizados = formFields.map((field) => ({
      ...field,
      ...(field.type === "select"
        ? { options: (field.options ?? []).map((option) => option.trim()).filter(Boolean) }
        : {}),
    }));
    const parsed = webhookFormFieldsSchema.safeParse(normalizados);
    if (!parsed.success) {
      toast.error(t(parsed.error.issues[0]?.message ?? "Revise os campos do formulário."));
      return;
    }
    try {
      const res = await update.mutateAsync({ id: source.id, form_fields: parsed.data });
      const fields = res.data.form_fields ?? parsed.data;
      setFormFields(fields);
      setSavedFormFields(fields);
      toast.success(t("Perguntas do formulário salvas."));
    } catch {
      /* erro já mostrado pelo showApiError */
    }
  };

  const sendTestLead = async () => {
    setTesting(true);
    setTestOk(false);
    try {
      // URL relativa de propósito: o teste bate no host que está servindo a
      // página, mesmo que NEXT_PUBLIC_APP_URL (usada na URL exibida p/ forms
      // externos) esteja desalinhada num self-host atrás de proxy.
      const res = await fetch(`/api/v1/webhooks/in/${source.path_token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: "Lead de Teste",
          telefone: "11999990000",
          utm_source: "teste",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(
          t(
            body?.error?.message ??
              "Não funcionou. Confira se a fonte está ativa e se o funil/estágio ainda existem.",
          ),
        );
        return;
      }
      toast.success(t("Funcionou! Um lead de teste entrou no seu funil."));
      setTestOk(true);
      void refetchEvents();
    } catch {
      toast.error(t("Não conseguimos falar com o endereço. Confira sua internet e tente de novo."));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(aberto) => {
        // Fechou, o plaintext morre — não há segunda chance de ver, e é assim
        // que se promete que ele não fica pendurado na tela.
        if (!aberto) setRevelado(null);
        onOpenChange(aberto);
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <div className="flex items-center gap-2">
            {editandoNome ? (
              <>
                <SheetTitle className="sr-only">{nomeFonteSalvo}</SheetTitle>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Input
                    aria-label={t("Nome da fonte")}
                    autoFocus
                    value={nomeFonteRascunho}
                    maxLength={120}
                    onChange={(event) => setNomeFonteRascunho(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void salvarNomeFonte();
                      }
                      if (event.key === "Escape") {
                        setNomeFonteRascunho(nomeFonteSalvo);
                        setEditandoNome(false);
                      }
                    }}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    aria-label={t("Salvar nome")}
                    disabled={update.isPending || !nomeFonteRascunho.trim()}
                    onClick={() => void salvarNomeFonte()}
                  >
                    <Check />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t("Cancelar edição do nome")}
                    disabled={update.isPending}
                    onClick={() => {
                      setNomeFonteRascunho(nomeFonteSalvo);
                      setEditandoNome(false);
                    }}
                  >
                    <X />
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                <SheetTitle>{nomeFonteSalvo}</SheetTitle>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t("Editar nome da fonte")}
                  disabled={!podeGerirWebhooks || update.isPending}
                  onClick={() => {
                    setNomeFonteRascunho(nomeFonteSalvo);
                    setEditandoNome(true);
                  }}
                >
                  <PencilSimple />
                </Button>
              </div>
            )}
            <Badge variant={source.is_active ? "success" : "neutral"}>
              {source.is_active ? t("Ativa") : t("Pausada")}
            </Badge>
          </div>
          <SheetDescription>
            {t("Cada envio para o endereço abaixo vira um lead no seu funil, automaticamente.")}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          <section className="space-y-2">
            <p className="text-sm font-medium text-text">{t("Endereço da fonte")}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-sm border border-border bg-muted px-3 py-2 text-xs">
                {url}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={() => copy(url, t("Endereço copiado."), t)}
              >
                <Copy />
              </Button>
            </div>
          </section>

          <section className="space-y-2 rounded-sm border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="authorize-ai-on-capture" className="block text-sm font-medium text-text">
                {t("Autorizar IA para leads deste formulário")}
              </label>
              <Switch id="authorize-ai-on-capture" checked={Boolean(autorizaIA)}
                disabled={!podeGerirWebhooks || update.isPending || (!temAssinatura && !autorizaIA)}
                onCheckedChange={(ativa) => update.mutate(
                  { id: source.id, authorize_ai_on_capture: ativa },
                  { onSuccess: (res) => setAutorizacaoIA({ id: source.id, ativa: res.data.authorize_ai_on_capture }) },
                )} />
            </div>
            <p className="text-sm text-muted-foreground">
              {t("Autoriza somente novos envios completos com consentimento explícito para atendimento automatizado. Não retoma contatos bloqueados ou em atendimento humano. O agente e o canal precisam estar configurados para atender.")}
            </p>
            {!temAssinatura && <p className="text-sm text-muted-foreground">
              {t("Configure a assinatura da fonte antes de autorizar IA. Para remover a assinatura, desligue primeiro a autorização de IA.")}
            </p>}
            <p className="text-sm text-muted-foreground">
              {t("O integrador deve enviar external_id, ai_service_consent: true, submission_status: completed e ai_service_consent_version com a versão do aviso aceito. Aceitar apenas a política de privacidade não autoriza a IA. Sem external_id, o envio não concede nem renova a autorização; reenviar com o mesmo external_id não libera de novo. Uma recusa (false) num envio completo e válido revoga, mesmo sem external_id.")}
            </p>
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium text-text">{t("Personalizar perguntas do formulário")}</p>
            <p className="text-xs text-muted-foreground">
              {t("As respostas extras ficam nos campos personalizados do lead e no histórico desta captação. O checkbox envia sim ou não; a lista permite escolher uma opção.")}
            </p>
            <WebhookFormFieldsEditor fields={formFields} onChange={setFormFields} />
            <Button
              type="button"
              variant="secondary"
              disabled={!formFieldsDirty || update.isPending}
              onClick={() => void salvarCamposDoFormulario()}
            >
              {update.isPending ? t("Salvando…") : t("Salvar perguntas")}
            </Button>
          </section>
          <section className="space-y-2">
            <p className="text-sm font-medium text-text">
              {t("Formulário pronto para colar no seu site")}
            </p>
            <Textarea readOnly rows={Math.min(24, 8 + formFields.length * 3)} value={formSnippet(url, formFields, t)} className="font-mono text-xs" />
            <Button
              type="button"
              variant="secondary"
              onClick={() => copy(formSnippet(url, formFields, t), t("Formulário copiado."), t)}
            >
              <Copy /> {t("Copiar formulário")}
            </Button>
          </section>

          <section className="space-y-2 rounded-sm border border-border">
            <details className="group p-3">
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-text">
                {t("Como conectar no seu caso")}
                <CaretDown className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-3 space-y-4 text-sm text-muted-foreground">
                <div>
                  <p className="font-medium text-text">Elementor Pro</p>
                  <p>
                    {t(
                      'Em "Ações após o envio", adicione "Webhook" e cole o endereço acima em "URL do Webhook".',
                    )}
                  </p>
                </div>
                <div>
                  <p className="font-medium text-text">JetFormBuilder</p>
                  <p>
                    {t('Adicione a ação "Call Webhook" ao formulário e cole o endereço acima.')}
                  </p>
                </div>
                <div>
                  <p className="font-medium text-text">WordPress</p>
                  <p>
                    {t(
                      'Cole o endereço acima no campo "Action" (ou "URL de envio") do seu formulário.',
                    )}
                  </p>
                </div>
                <div>
                  <p className="font-medium text-text">Zapier / n8n</p>
                  <p>{t('Use a ação "Webhooks" → POST, apontando para o endereço acima.')}</p>
                </div>
                <div>
                  <p className="font-medium text-text">{t("Formulário próprio")}</p>
                  <p>{t("Use o HTML pronto logo acima — já aponta para o endereço certo.")}</p>
                </div>
              </div>
            </details>
          </section>

          <details className="rounded-sm border border-border p-3">
            <summary className="cursor-pointer list-none text-sm font-medium text-text">
              {t("Para desenvolvedores")}
            </summary>
            <pre className="mt-3 overflow-x-auto rounded-sm bg-muted p-3 text-xs">
              <code>{curlSnippet(url, temAssinatura, t)}</code>
            </pre>
          </details>

          <section className="space-y-3">
            <Button type="button" onClick={sendTestLead} disabled={testing || temAssinatura}>
              {testing ? t("Enviando…") : t("Enviar lead de teste")}
            </Button>
            {temAssinatura ? (
              // O navegador não tem o secret — e não deve ter. Um teste daqui
              // levaria 401 e leria como "a fonte está quebrada".
              <p className="text-xs text-muted-foreground">
                {t("Com assinatura ativa, teste a partir do sistema que envia os dados.")}
              </p>
            ) : null}
            {testOk ? (
              <p className="text-sm">
                <Link href="/app/kanban" className="text-accent underline underline-offset-4">
                  {t("Ver no Kanban")}
                </Link>
              </p>
            ) : null}
          </section>

          <section className="space-y-3 rounded-sm border border-border p-3">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-text">{t("Assinatura (HMAC)")}</p>
              {/* "Ligada", e não "Ativa": o cabeçalho do painel já tem uma badge
                  "Ativa/Pausada" para a FONTE, e duas badges com a mesma palavra
                  no mesmo painel falam de duas coisas diferentes. */}
              <Badge variant={temAssinatura ? "success" : "neutral"}>
                {temAssinatura ? t("Ligada") : t("Desligada")}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                "Sem assinatura, quem descobrir o endereço consegue criar leads. Com ela, quem envia assina o corpo cru da requisição com HMAC-SHA256 e manda o resultado em hexadecimal — hex puro, sem prefixo — neste cabeçalho:",
              )}{" "}
              {/* O nome sai da constante, e não de uma string aqui: ele é
                  contrato de fio (lib/webhooks/assinatura.ts), e a mesma
                  constante é a que a rota de entrada confere. */}
              <code className="rounded-sm bg-muted px-1 py-0.5">
                {HEADER_ASSINATURA_DE_ENTRADA}
              </code>
            </p>

            {secretRevelado ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {/* `break-all`, não `truncate`: é a única vez que este valor
                      aparece, e um "…" no fim esconde metade de um segredo que
                      não volta. Quem copia à mão precisa vê-lo inteiro. */}
                  <code className="flex-1 break-all rounded-sm border border-border bg-muted px-3 py-2 text-xs">
                    {secretRevelado}
                  </code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    onClick={() => copy(secretRevelado, t("Segredo copiado."), t)}
                  >
                    <Copy />
                  </Button>
                </div>
                <p className="text-xs text-error">
                  {t("Guarde agora. Ele não será mostrado de novo.")}
                </p>
              </div>
            ) : null}

            {podeGerirWebhooks ? (
              <div className="flex flex-wrap gap-2">
                {temAssinatura ? (
                  <>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" variant="secondary" disabled={update.isPending}>
                          {t("Trocar segredo")}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("Trocar o segredo desta fonte?")}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t(
                              "Integrações que usam o segredo atual vão parar de funcionar até serem atualizadas.",
                            )}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                          <AlertDialogAction
                            disabled={update.isPending}
                            onClick={() => aplicarSecret(gerarSecretHex(), t("Segredo trocado."))}
                          >
                            {t("Trocar")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>

                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" variant="secondary" disabled={update.isPending}>
                          {t("Remover segredo")}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {t("Remover a assinatura desta fonte?")}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {t(
                              "O endereço volta a aceitar envios sem assinatura — só o endereço secreto passa a protegê-lo.",
                            )}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                          <AlertDialogAction
                            disabled={update.isPending}
                            onClick={() => aplicarSecret(null, t("Assinatura removida."))}
                          >
                            {t("Remover")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </>
                ) : (
                  <Button
                    type="button"
                    disabled={update.isPending}
                    onClick={() => aplicarSecret(gerarSecretHex(), t("Assinatura ligada."))}
                  >
                    {t("Gerar segredo")}
                  </Button>
                )}
              </div>
            ) : null}
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium text-text">{t("Últimos recebimentos")}</p>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("Ainda não chegou nada por aqui.")}
              </p>
            ) : (
              <ul className="space-y-1">
                {events.map((ev) => (
                  <li key={ev.id} className="flex items-center gap-2 text-sm">
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        ev.valid_signature === false ? "bg-error" : "bg-success",
                      )}
                    />
                    <span className="text-muted-foreground">
                      {relativeReceivedAt(ev.created_at, localeDaData)}
                    </span>
                    {ev.valid_signature === false ? (
                      <span className="text-xs text-error">{t("assinatura inválida")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex items-center justify-between rounded-sm border border-border p-3">
            <div>
              <p className="text-sm font-medium text-text">{t("Fonte ativa")}</p>
              <p className="text-xs text-muted-foreground">
                {t("Pausada, ela para de aceitar novos envios.")}
              </p>
            </div>
            <Switch
              checked={source.is_active}
              disabled={update.isPending}
              onCheckedChange={(checked) =>
                update.mutate(
                  { id: source.id, is_active: checked },
                  {
                    onSuccess: () =>
                      toast.success(checked ? t("Fonte ativada.") : t("Fonte pausada.")),
                  },
                )
              }
            />
          </section>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="destructive">
                <Trash /> {t("Excluir fonte")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("Excluir esta fonte?")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    "O endereço para de funcionar imediatamente. Leads já recebidos continuam no seu funil — só a captação futura é interrompida. Essa ação não pode ser desfeita.",
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={async () => {
                    await del.mutateAsync(source.id);
                    toast.success(t("Fonte excluída."));
                    onOpenChange(false);
                  }}
                >
                  {t("Excluir")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </SheetContent>
    </Sheet>
  );
}
