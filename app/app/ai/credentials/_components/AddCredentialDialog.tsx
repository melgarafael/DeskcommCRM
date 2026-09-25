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
});

type FormValues = z.infer<typeof formSchema>;

interface CreateResponse {
  data: CredentialRow;
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
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const provedor = PROVEDORES_COM_CHAVE.find((p) => p.id === provider) ?? PROVEDORES_COM_CHAVE[0];

  const reset = () => {
    setProvider(providerInicial);
    setLabel("");
    setApiKey("");
    setErrors({});
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    const parsed = formSchema.safeParse({ provider, label, api_key: apiKey });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        provider: flat.provider?.[0] ? t(flat.provider[0]) : undefined,
        label: flat.label?.[0] ? t(flat.label[0]) : undefined,
        api_key: flat.api_key?.[0] ? t(flat.api_key[0]) : undefined,
      });
      return;
    }

    setSubmitting(true);
    const validatingToast = toast.loading(t("Credencial salva. Validando…"));
    try {
      const res = await apiClient.post<CreateResponse>("/api/v1/ai/credentials", {
        ...parsed.data,
        label: parsed.data.label || provedor.rotulo,
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
              <a
                className="text-xs underline underline-offset-4"
                href={provedor.ondePegarAChave}
                target="_blank"
                rel="noreferrer"
              >
                {t("Onde pegar a chave")}
              </a>
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
