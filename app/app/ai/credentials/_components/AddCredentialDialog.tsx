"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";

import { refreshCredentialsView } from "../_actions";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { credentialsListQueryKey, type CredentialRow } from "@/hooks/ai/useCredentials";
import { IDS_COM_CHAVE, PROVEDORES_COM_CHAVE, type ProvedorComChave } from "@/lib/ai/pontos/provedores";
import { descreverErroDeValidacao } from "@/lib/ai/credenciais/erro-de-validacao";
import { useT } from "@/hooks/i18n/useT";

const formSchema = z.object({
  // Derivado das listas (`lib/ai/pontos/provedores.ts`), como a rota.
  provider: z.enum(IDS_COM_CHAVE),
  // Opcional: o leigo cola só a chave. Em branco, o nome vira o do provedor
  // (ver `onSubmit`) — o banco exige um, e a pessoa não precisa inventá-lo.
  label: z.string().trim().max(80),
  api_key: z.string().trim().min(8, "Chave muito curta").max(2048),
  /** Só o provedor personalizado (#1642) tem — vira campo quando ele é escolhido. */
  base_url: z.string().trim().max(500),
});

type FormValues = z.infer<typeof formSchema>;

interface CreateResponse {
  data: CredentialRow;
}

interface TestResponse {
  ok: boolean;
  models: string[];
  error: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** O cartão do Jev abre o diálogo já nele; a tela de Credenciais, na Anthropic. */
  providerInicial?: ProvedorComChave;
  /** Chamado depois de gravar, para quem abriu o diálogo fora de Credenciais reler o que mostra. */
  aoSalvar?: () => void;
}

export function AddCredentialDialog({ open, onOpenChange, providerInicial = "anthropic", aoSalvar }: Props) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<ProvedorComChave>(providerInicial);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  /** O endereço da API compatível com a OpenAI — só o provedor personalizado tem. */
  const [baseUrl, setBaseUrl] = useState("");
  /** O resultado do teste de conectividade que roda ANTES de salvar. */
  const [conexao, setConexao] = useState<{ ok: boolean; modelos: number; erro: string | null } | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const provedor = PROVEDORES_COM_CHAVE.find((p) => p.id === provider) ?? PROVEDORES_COM_CHAVE[0];

  const reset = () => {
    setProvider(providerInicial);
    setLabel("");
    setApiKey("");
    setBaseUrl("");
    setConexao(null);
    setErrors({});
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    if (provider === "custom" && !/^https?:\/\/\S+$/.test(baseUrl.trim())) {
      setErrors({
        base_url: t("Informe o endereço (base URL) começando com http:// ou https://."),
      });
      return;
    }

    const parsed = formSchema.safeParse({ provider, label, api_key: apiKey, base_url: baseUrl });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        provider: flat.provider?.[0] ? t(flat.provider[0]) : undefined,
        label: flat.label?.[0] ? t(flat.label[0]) : undefined,
        api_key: flat.api_key?.[0] ? t(flat.api_key[0]) : undefined,
      });
      return;
    }

    // O provedor personalizado é o único em que o ENDEREÇO é escolha do
    // operador, então há algo a provar antes de gravar: sem a rede falando,
    // salvar seria prometer uma integração que ninguém viu funcionar. Os
    // nativos passam por aqui sem nada — o deles é intrínseco e já é provado
    // pela validação em segundo plano.
    if (provider === "custom") {
      setConexao(null);
      const testando = toast.loading(t("Testando a conexão com o provedor…"));
      try {
        const teste = await apiClient.post<{ data: TestResponse }>("/api/v1/ai/credentials/test", {
          base_url: baseUrl.trim(),
          api_key: apiKey,
        });
        toast.dismiss(testando);
        if (!teste.data.ok) {
          // A tela fica ABERTA com a frase do código, e nada é gravado: o
          // conserto é o campo que está ali, em cima do erro.
          setConexao({ ok: false, modelos: 0, erro: teste.data.error });
          toast.error(t("Não consegui falar com este endereço. Confira a base URL e a chave."));
          return;
        }
        setConexao({ ok: true, modelos: teste.data.models.length, erro: null });
        toast.success(t("Conexão confirmada com o provedor."));
      } catch (err) {
        toast.dismiss(testando);
        showApiError(err);
        return;
      }
    }

    setSubmitting(true);
    const validatingToast = toast.loading(t("Credencial salva. Validando…"));
    try {
      const { base_url, ...semEndereco } = parsed.data;
      const res = await apiClient.post<CreateResponse>("/api/v1/ai/credentials", {
        ...semEndereco,
        label: parsed.data.label || provedor.rotulo,
        // Só quando é do provedor personalizado: os nativos continuam mandando
        // exatamente o corpo de antes.
        ...(base_url.trim() !== "" ? { base_url: base_url.trim() } : {}),
      });
      toast.dismiss(validatingToast);
      toast.success(t("Credencial salva. Validação em segundo plano."));
      reset();
      onOpenChange(false);
      aoSalvar?.();

      // Poll uma vez após ~3s para refletir validated_at no card.
      setTimeout(async () => {
        await qc.invalidateQueries({ queryKey: credentialsListQueryKey });
        const fresh = qc.getQueryData<CredentialRow[]>(credentialsListQueryKey);
        const justCreated = fresh?.find((c) => c.id === res.data.id);
        if (justCreated?.models_available != null) {
          toast.success(
            `${t("Validada")} — ${justCreated.models_available.length} ${t("modelos disponíveis.")}`,
          );
        } else if (justCreated?.validation_error) {
          const erro = descreverErroDeValidacao(justCreated.validation_error, justCreated.provider);
          toast.error(
            erro.generico
              ? `${t("Falha na validação")} (${justCreated.validation_error}).`
              : t(erro.frase),
          );
        }
      }, 3000);

      await qc.invalidateQueries({ queryKey: credentialsListQueryKey });
      await refreshCredentialsView();
      router.refresh();
    } catch (err) {
      toast.dismiss(validatingToast);
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const onOpenChangeWrapped = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChangeWrapped}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Adicionar credencial")}</DialogTitle>
          <DialogDescription>
            {t("A chave é guardada cifrada. Depois de salva, só os quatro últimos caracteres aparecem na tela.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cred-provider">{t("Provedor")}</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as ProvedorComChave)}>
              <SelectTrigger id="cred-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVEDORES_COM_CHAVE.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.rotulo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(provedor.quandoUsar)}</p>
            {errors.provider && (
              <p className="text-xs text-destructive">{errors.provider}</p>
            )}
          </div>

          {provider === "custom" && (
            <div className="space-y-2">
              <Label htmlFor="cred-base-url">{t("Endereço (base URL)")}</Label>
              <Input
                id="cred-base-url"
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setConexao(null);
                }}
                placeholder={t("Obrigatório — ex.: https://seu-gateway.example/v1")}
                autoComplete="off"
                required
              />
              {errors.base_url && <p className="text-xs text-destructive">{errors.base_url}</p>}
              {conexao && !conexao.ok && (
                <p className="text-xs text-destructive">
                  {conexao.erro === null
                    ? ""
                    : (() => {
                        const descrito = descreverErroDeValidacao(conexao.erro, provider);
                        return descrito.generico
                          ? `${t("Falha na validação")} (${conexao.erro}).`
                          : t(descrito.frase);
                      })()}
                </p>
              )}
              {conexao?.ok && (
                <p className="text-xs text-muted-foreground">
                  {`${t("Conexão OK")} — ${conexao.modelos} ${t("modelos disponíveis.")}`}
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="cred-label">{t("Nome")}</Label>
            <Input
              id="cred-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("Opcional — ex.: Chave da clínica")}
              maxLength={80}
            />
            {errors.label && <p className="text-xs text-destructive">{errors.label}</p>}
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="cred-key">{t("Chave")}</Label>
              {/* Provedor personalizado não tem portal de chave: quem emite é o
                  gateway do próprio operador. O link sumiria com um endereço que
                  não leva a lugar nenhum. */}
              {provider !== "custom" && (
                <a
                  className="text-xs underline underline-offset-4"
                  href={provedor.ondePegarAChave}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("Onde pegar a chave")}
                </a>
              )}
            </div>
            <Input
              id="cred-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provedor.prefixoDaChave}
              autoComplete="off"
              required
            />
            {errors.api_key && (
              <p className="text-xs text-destructive">{errors.api_key}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChangeWrapped(false)}
              disabled={submitting}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("Salvando…") : t("Salvar e validar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
