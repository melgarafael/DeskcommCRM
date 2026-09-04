"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter as useNextRouter } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ArrowRight, CaretLeft, Info, Plus, Trash } from "@/lib/ui/icons";
import { randomId } from "@/lib/random-id";
import { usePermission } from "@/hooks/auth/AuthProvider";
import {
  useRouter as useRouterData,
  useUpdateRouter,
  useDeleteRouter,
  useSaveMembers,
  useTestRouter,
  type RouterDetailState,
  type RouterMemberInput,
} from "@/hooks/ai/useRouters";
import type { ClassifierModelOption } from "@/lib/ai/classifier-models";
import type { ChannelSessionLite } from "../../agents/[id]/_components/AgentForm";
import { useT } from "@/hooks/i18n/useT";

interface AgentLite {
  id: string;
  name: string;
}

interface Props {
  routerId: string;
  initialState: RouterDetailState;
  agents: AgentLite[];
  channelSessions: ChannelSessionLite[];
  /** Só os modelos que esta organização consegue usar — ver lib/ai/classifier-models. */
  classifierModels: ClassifierModelOption[];
}

interface DraftMember extends RouterMemberInput {
  key: string;
}

const NONE = "__none__";
/** "deixa o sistema escolher" — grava null nos dois campos e volta ao padrão. */
const AUTO = "__auto__";

/**
 * A chave do seletor carrega provedor E modelo (`provider::model_id`) porque os
 * dois precisam ser gravados juntos: `resolveOrgLlmConfig` decide o provedor pela
 * config da ORGANIZAÇÃO, então um id de modelo salvo sozinho viaja para o
 * provedor errado e a classificação falha em toda mensagem.
 */
function classifierKeyFrom(config: Record<string, unknown> | null | undefined): string {
  const cfg = config ?? {};
  const model = cfg["classifier_model"];
  const provider = cfg["classifier_provider"];
  if (typeof model !== "string" || model.trim() === "") return AUTO;
  if (typeof provider !== "string" || provider.trim() === "") return AUTO;
  return `${provider}::${model}`;
}

export function RouterEditorClient({
  routerId,
  initialState,
  agents,
  channelSessions,
  classifierModels,
}: Props) {
  const t = useT();
  const nextRouter = useNextRouter();
  const canManage = usePermission("ai.routers.manage");
  const canTest = usePermission("ai.routers.view");
  const { data } = useRouterData(routerId, initialState);
  const router = data?.router ?? initialState.router;
  const members = data?.members ?? initialState.members;

  const channel = channelSessions.find((c) => c.id === router.channel_session_id);

  const [name, setName] = React.useState(router.name);
  const [isActive, setIsActive] = React.useState(router.is_active);
  const [fallbackAgentId, setFallbackAgentId] = React.useState(router.fallback_agent_id ?? "");
  // Uma chave só para os dois campos: escolher modelo sem levar o provedor junto
  // manda o id para o provedor da ORG, e a classificação falha sempre.
  const [classifier, setClassifier] = React.useState(() => classifierKeyFrom(router.config));
  const [draftMembers, setDraftMembers] = React.useState<DraftMember[]>(() =>
    members.map((m) => ({ ...m, key: m.id })),
  );
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [testMessage, setTestMessage] = React.useState("");

  const updateRouter = useUpdateRouter(routerId);
  const deleteRouter = useDeleteRouter();
  const saveMembers = useSaveMembers(routerId);
  const testRouter = useTestRouter(routerId);

  const baseline = React.useMemo(
    () => ({
      name: router.name,
      isActive: router.is_active,
      fallbackAgentId: router.fallback_agent_id ?? "",
      classifier: classifierKeyFrom(router.config),
      members: members.map(({ agent_id, intent_name, intent_description, examples }) => ({
        agent_id,
        intent_name,
        intent_description,
        examples,
      })),
    }),
    [router, members],
  );

  const currentMembers = draftMembers.map(({ agent_id, intent_name, intent_description, examples }) => ({
    agent_id,
    intent_name,
    intent_description,
    examples,
  }));

  const dirty =
    name !== baseline.name ||
    isActive !== baseline.isActive ||
    fallbackAgentId !== baseline.fallbackAgentId ||
    classifier !== baseline.classifier ||
    JSON.stringify(currentMembers) !== JSON.stringify(baseline.members);

  const memberErrors = draftMembers.map((m) => {
    if (!m.agent_id) return t("Escolha o agente que atende esta intenção.");
    if (m.intent_name.trim().length === 0) return t("Dê um nome curto para a intenção.");
    if (m.intent_description.trim().length === 0)
      return t("Descreva quando a IA deve escolher esta intenção.");
    return null;
  });
  const duplicateNames = new Set(
    draftMembers
      .map((m) => m.intent_name.trim().toLowerCase())
      .filter((n, i, arr) => n.length > 0 && arr.indexOf(n) !== i),
  );
  const isValid =
    name.trim().length > 0 &&
    memberErrors.every((e) => e === null) &&
    draftMembers.every((m) => !duplicateNames.has(m.intent_name.trim().toLowerCase()));

  const saving = updateRouter.isPending || saveMembers.isPending;

  function patchMember(key: string, patch: Partial<DraftMember>) {
    setDraftMembers((prev) => prev.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  }

  function addMember() {
    setDraftMembers((prev) => [
      ...prev,
      {
        key: randomId(),
        agent_id: "",
        intent_name: "",
        intent_description: "",
        examples: [],
      },
    ]);
  }

  function removeMember(key: string) {
    setDraftMembers((prev) => prev.filter((m) => m.key !== key));
  }

  async function handleSave() {
    if (!isValid) {
      toast.error(t("Resolva os campos destacados antes de salvar."));
      return;
    }
    try {
      if (
        name !== baseline.name ||
        isActive !== baseline.isActive ||
        fallbackAgentId !== baseline.fallbackAgentId ||
        classifier !== baseline.classifier
      ) {
        const [provider, modelId] = classifier.split("::");
        await updateRouter.mutateAsync({
          name,
          is_active: isActive,
          fallback_agent_id: fallbackAgentId || null,
          // O PATCH mescla `config` com a existente, então mandar só estes dois
          // campos preserva sticky/min_confidence.
          config:
            classifier === AUTO
              ? { classifier_model: null, classifier_provider: null }
              : { classifier_model: modelId, classifier_provider: provider },
        });
      }
      if (JSON.stringify(currentMembers) !== JSON.stringify(baseline.members)) {
        await saveMembers.mutateAsync(currentMembers);
      }
      toast.success(t("Roteador salvo."));
    } catch (err) {
      showApiError(err);
    }
  }

  function handleDelete() {
    deleteRouter.mutate(routerId, {
      onSuccess: () => {
        toast.success(t("Roteador removido."));
        nextRouter.push("/app/ai/routers");
      },
      onError: showApiError,
    });
  }

  function handleTest() {
    if (!testMessage.trim()) return;
    testRouter.mutate(testMessage, { onError: showApiError });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Link
            href="/app/ai/routers"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <CaretLeft size={14} aria-hidden /> {t("Roteadores")}
          </Link>
          <Badge variant={router.is_active ? "success" : "neutral"} className="text-xs">
            {router.is_active ? t("ativo") : t("inativo")}
          </Badge>
        </div>
        {canManage && (
          <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(true)} className="text-destructive">
            <Trash /> {t("Excluir roteador")}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-medium">{t("Identificação")}</h3>
            <div className="space-y-1">
              <Label htmlFor="router-name">{t("Nome")}</Label>
              <Input
                id="router-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!canManage}
                maxLength={120}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("Número de WhatsApp")}</Label>
              <p className="rounded-md border border-border/60 px-3 py-2 text-sm text-muted-foreground">
                {channel
                  ? `${channel.display_name}${channel.phone_number ? ` · ${channel.phone_number}` : ""}`
                  : t("Número removido")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  "O número não pode ser trocado depois de criado — crie outro roteador para um número diferente.",
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="router-active"
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={!canManage}
              />
              <Label htmlFor="router-active">
                {isActive
                  ? t("Ativo — está roteando as conversas deste número")
                  : t("Inativo — não roteia nada")}
              </Label>
            </div>
          </Card>

          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-medium">{t("Modelo que identifica a intenção")}</h3>
            <div className="space-y-1">
              <Label htmlFor="router-classifier">{t("Modelo do classificador")}</Label>
              <Select
                value={classifier}
                onValueChange={setClassifier}
                disabled={!canManage || classifierModels.length === 0}
              >
                <SelectTrigger id="router-classifier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>{t("Automático — usa o provedor da organização")}</SelectItem>
                  {classifierModels.map((m) => (
                    <SelectItem key={`${m.provider}::${m.model_id}`} value={`${m.provider}::${m.model_id}`}>
                      {m.display_name} · {m.provider}
                      {m.origem === "plataforma" ? ` (${t("chave desta instalação")})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {classifierModels.length === 0
                  ? t(
                      "Nenhuma chave de IA utilizável nesta organização — cadastre uma em Agentes IA › Credenciais para poder escolher o modelo.",
                    )
                  : t(
                      "Só aparecem modelos de provedores com chave cadastrada aqui. Se a conta do provedor estiver sem crédito, a identificação falha e tudo cai no fallback.",
                    )}
              </p>
            </div>
          </Card>

          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-medium">{t("Se nenhuma intenção casar")}</h3>
            <div className="space-y-1">
              <Label htmlFor="router-fallback">{t("Agente de fallback")}</Label>
              <Select
                value={fallbackAgentId || NONE}
                onValueChange={(v) => setFallbackAgentId(v === NONE ? "" : v)}
                disabled={!canManage}
              >
                <SelectTrigger id="router-fallback">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("Nenhum — responde com o atendimento padrão")}</SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Quando a IA não tem certeza do que o cliente quer, ela chama este agente em vez de travar a conversa.",
                )}
              </p>
            </div>
          </Card>

          <TestPanel
            isActive={router.is_active}
            canTest={canTest}
            message={testMessage}
            onMessageChange={setTestMessage}
            onTest={handleTest}
            result={testRouter.data}
            pending={testRouter.isPending}
          />
        </div>

        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-medium">{t("Intenções")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Cada intenção descreve uma situação e diz qual agente deve assumir a conversa quando o cliente quer aquilo.",
                  )}
                </p>
              </div>
              {canManage && (
                <Button variant="outline" size="sm" onClick={addMember} className="shrink-0">
                  <Plus /> {t("Intenção")}
                </Button>
              )}
            </div>

            {draftMembers.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                {t(
                  "Nenhuma intenção ainda. Sem intenções, toda conversa cai direto no agente de fallback (ou fica sem resposta automática, se você não escolher um).",
                )}
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {draftMembers.map((m, i) => (
                  <li key={m.key} className="rounded-md border border-border/60 p-3">
                    <IntentRow
                      member={m}
                      agents={agents}
                      disabled={!canManage}
                      error={memberErrors[i] ?? null}
                      duplicate={duplicateNames.has(m.intent_name.trim().toLowerCase())}
                      onChange={(patch) => patchMember(m.key, patch)}
                      onRemove={() => removeMember(m.key)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {canManage && (
            <div className="flex sm:justify-end">
              <Button onClick={handleSave} disabled={!dirty || !isValid || saving} className="w-full sm:w-auto">
                {saving ? t("Salvando…") : t("Salvar")}
              </Button>
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Excluir")} &ldquo;{router.name}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "O número volta a ser atendido pelos gatilhos normais dos agentes (sem roteamento por intenção). As intenções deste roteador são apagadas junto. Não é possível desfazer.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t("Excluir")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function IntentRow({
  member,
  agents,
  disabled,
  error,
  duplicate,
  onChange,
  onRemove,
}: {
  member: DraftMember;
  agents: AgentLite[];
  disabled: boolean;
  error: string | null;
  duplicate: boolean;
  onChange: (patch: Partial<DraftMember>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex-1 space-y-1">
          <Label>{t("Nome da intenção")}</Label>
          <Input
            value={member.intent_name}
            onChange={(e) => onChange({ intent_name: e.target.value })}
            placeholder={t("Ex.: quer comprar")}
            disabled={disabled}
            maxLength={120}
            aria-invalid={duplicate}
          />
        </div>
        <div className="flex-1 space-y-1">
          <Label>{t("Agente que atende")}</Label>
          <Select value={member.agent_id || undefined} onValueChange={(v) => onChange({ agent_id: v })} disabled={disabled}>
            <SelectTrigger>
              <SelectValue placeholder={t("Selecione o agente")} />
            </SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!disabled && (
          <Button
            variant="ghost"
            size="icon"
            className="mt-5 shrink-0"
            onClick={onRemove}
            aria-label={t("Remover intenção")}
          >
            <Trash />
          </Button>
        )}
      </div>
      <div className="space-y-1">
        <Label>{t("Quando escolher esta intenção")}</Label>
        <Textarea
          value={member.intent_description}
          onChange={(e) => onChange({ intent_description: e.target.value })}
          placeholder={t(
            "Escreva como explicaria para um atendente novo: em que situação o cliente cai aqui.",
          )}
          disabled={disabled}
          rows={2}
          maxLength={2000}
        />
      </div>
      <ExamplesInput
        value={member.examples}
        onChange={(examples) => onChange({ examples })}
        disabled={disabled}
      />
      {duplicate ? (
        <p className="text-xs text-destructive">{t("Já existe outra intenção com este nome.")}</p>
      ) : error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

function ExamplesInput({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [draft, setDraft] = React.useState("");

  function add(ex: string) {
    const trimmed = ex.trim();
    if (!trimmed || value.includes(trimmed) || value.length >= 10) return;
    onChange([...value, trimmed]);
    setDraft("");
  }

  function remove(ex: string) {
    onChange(value.filter((x) => x !== ex));
  }

  return (
    <div className="space-y-1">
      <Label>{t("Frases de exemplo (opcional)")}</Label>
      <div className="flex flex-wrap gap-1 rounded-md border border-border/60 p-2">
        {value.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => !disabled && remove(ex)}
            className="group flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs hover:bg-destructive/15"
            disabled={disabled}
            aria-label={`${t("Remover exemplo")} ${ex}`}
          >
            {ex}
            <span className="text-muted-foreground group-hover:text-destructive">×</span>
          </button>
        ))}
        {value.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("Sem frases de exemplo.")}</span>
        ) : null}
      </div>
      {!disabled && (
        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(draft);
              }
            }}
            placeholder={t("Ex.: quanto custa? (Enter)")}
            disabled={value.length >= 10}
            maxLength={200}
          />
          <button
            type="button"
            className="rounded-md border border-border/60 px-3 text-xs hover:bg-muted"
            onClick={() => add(draft)}
            disabled={draft.trim() === ""}
          >
            {t("Adicionar")}
          </button>
        </div>
      )}
    </div>
  );
}

function TestPanel({
  isActive,
  canTest,
  message,
  onMessageChange,
  onTest,
  result,
  pending,
}: {
  isActive: boolean;
  canTest: boolean;
  message: string;
  onMessageChange: (v: string) => void;
  onTest: () => void;
  result:
    | {
        intent_name: string | null;
        confidence: number;
        min_confidence: number;
        agent_id: string | null;
        agent_name: string | null;
      }
    | undefined;
  pending: boolean;
}) {
  const t = useT();
  const belowThreshold = result?.intent_name != null && result.confidence < result.min_confidence;
  return (
    <Card className="space-y-3 p-4">
      <CardHeader className="p-0">
        <CardTitle className="text-sm">{t("Testar classificação")}</CardTitle>
        <CardDescription>
          {t(
            "Escreva uma frase como um cliente escreveria e veja qual intenção e qual agente o roteador escolheria — sem afetar nenhuma conversa real.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        {!isActive && (
          <div className="flex items-start gap-2 rounded-md bg-accent-soft p-3 text-xs text-text-muted">
            <Info className="mt-0.5 shrink-0" aria-hidden />
            <p>{t("Ative o roteador para poder testar a classificação.")}</p>
          </div>
        )}
        <Textarea
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder={t("Ex.: oi, quero saber o preço do plano premium")}
          rows={2}
          maxLength={4000}
          disabled={!canTest || !isActive}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={onTest}
          disabled={!canTest || !isActive || pending || !message.trim()}
        >
          {pending ? t("Testando…") : t("Testar classificação")}
          {!pending && <ArrowRight />}
        </Button>
        {result && (
          <div className="rounded-md border border-border/60 p-3 text-sm">
            <p>
              {t("Intenção")}: <span className="font-medium">{result.intent_name ?? t("nenhuma casou")}</span>
              {result.intent_name && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {t("confiança")} {(result.confidence * 100).toFixed(0)}%
                </span>
              )}
            </p>
            {belowThreshold && (
              <p className="text-xs text-amber-600">
                {t("Confiança")} {(result.confidence * 100).toFixed(0)}% — {t("abaixo do mínimo de")}{" "}
                {(result.min_confidence * 100).toFixed(0)}%, {t("cairia no atendimento padrão em produção.")}
              </p>
            )}
            <p>
              {t("Agente que atenderia")}:{" "}
              <span className="font-medium">{result.agent_name ?? t("nenhum (sem fallback)")}</span>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
