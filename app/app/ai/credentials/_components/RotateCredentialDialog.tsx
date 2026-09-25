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
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import {
  credentialsListQueryKey,
  type CredentialRow,
} from "@/hooks/ai/useCredentials";
import { ehProvedorDeDecisao, PROVEDORES_COM_CHAVE } from "@/lib/ai/pontos/provedores";
import { descreverErroDeValidacao } from "@/lib/ai/credenciais/erro-de-validacao";
import { useT } from "@/hooks/i18n/useT";

/**
 * A chave da tela NUNCA volta do servidor — só os últimos 4 dígitos. Por isso
 * aqui a chave nova é opcional: em branco significa "mantenha a atual", que é o
 * que permite renomear sem girar. Deixar o campo vazio não pode virar uma chave
 * vazia no banco; quem trata isso é o corpo enviado, montado campo a campo.
 */
const formSchema = z.object({
  label: z.string().trim().min(1, "Obrigatório").max(80),
  api_key: z.string().trim().max(2048).optional(),
});

type FormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  credential: CredentialRow;
}

export function RotateCredentialDialog({ open, onOpenChange, credential }: Props) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const [label, setLabel] = useState(credential.label);
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const provedor =
    PROVEDORES_COM_CHAVE.find((p) => p.id === credential.provider) ?? PROVEDORES_COM_CHAVE[0];

  const chaveMudou = apiKey.trim() !== "";
  const rotuloMudou = label.trim() !== credential.label;
  const mudou = chaveMudou || rotuloMudou;

  const reset = () => {
    setLabel(credential.label);
    setApiKey("");
    setErrors({});
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    const chave = apiKey.trim();
    // A chave só é obrigatória a partir de 8 caracteres QUANDO existe uma nova;
    // em branco é "manter a atual", e é isso que impede renomear de girar a chave.
    if (chave !== "" && chave.length < 8) {
      setErrors({ api_key: t("Chave muito curta") });
      return;
    }

    const parsed = formSchema.safeParse({ label, api_key: chave || undefined });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        label: flat.label?.[0] ? t(flat.label[0]) : undefined,
        api_key: flat.api_key?.[0] ? t(flat.api_key[0]) : undefined,
      });
      return;
    }

    if (!mudou) return;

    setSubmitting(true);
    const validandoToast = chaveMudou ? toast.loading(t("Chave salva. Validando…")) : null;
    try {
      const body: { label?: string; api_key?: string } = {};
      if (rotuloMudou) body.label = label.trim();
      if (chaveMudou) body.api_key = chave;

      await apiClient.patch(`/api/v1/ai/credentials/${credential.id}`, body);
      if (validandoToast) toast.dismiss(validandoToast);
      toast.success(
        chaveMudou
          ? t("Chave trocada. A validação segue em segundo plano.")
          : t("Credencial atualizada."),
      );
      reset();
      onOpenChange(false);

      await qc.invalidateQueries({ queryKey: credentialsListQueryKey });

      if (chaveMudou) {
        // O teste da chave nova roda depois da resposta. A lista só se relê
        // sozinha enquanto a linha está "validando", e isso sai de
        // `created_at`, que a troca não mexe: para ela, uma chave antiga
        // trocada já está "sem validação". Uma releitura só, aos 3 s, perdia o
        // teste que demorasse mais (o teto é 5 s por chamada, em
        // lib/ai/provider-validators.ts) e o card — com o "Usada em" do Jev —
        // só voltava recarregando a página. Relê até o veredito, por 10 s.
        void (async () => {
          for (const espera of [3000, 3000, 4000]) {
            await new Promise((pronto) => setTimeout(pronto, espera));
            await qc.invalidateQueries({ queryKey: credentialsListQueryKey });
            const fresh = qc.getQueryData<CredentialRow[]>(credentialsListQueryKey);
            const atual = fresh?.find((c) => c.id === credential.id);
            if (atual?.validation_error) {
              const erro = descreverErroDeValidacao(atual.validation_error, credential.provider);
              toast.error(
                erro.generico
                  ? `${t("Falha na validação")} (${atual.validation_error}).`
                  : t(erro.frase),
              );
              return;
            }
            if (atual?.validated_at) {
              if (atual.models_available != null) {
                toast.success(
                  `${t("Validada")} — ${atual.models_available.length} ${t("modelos disponíveis.")}`,
                );
              }
              return;
            }
          }
        })();
      }

      await refreshCredentialsView();
      router.refresh();
    } catch (err) {
      if (validandoToast) toast.dismiss(validandoToast);
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
          <DialogTitle>{t("Editar credencial")}</DialogTitle>
          <DialogDescription>
            {/* A chave do Jev não tem agente ligado nela: quem a usa é ele. */}
            {ehProvedorDeDecisao(credential.provider)
              ? t(
                  "Trocar a chave aqui mantém o Jev ligado: na próxima mensagem ele já usa a chave nova. Deixe a chave em branco para mudar só o nome.",
                )
              : t(
                  "Trocar a chave aqui mantém os agentes ligados nela: no próximo atendimento eles já usam a chave nova. Deixe a chave em branco para mudar só o nome.",
                )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cred-edit-label">{t("Nome")}</Label>
            <Input
              id="cred-edit-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("Ex: Produção")}
              maxLength={80}
              required
            />
            {errors.label && <p className="text-xs text-destructive">{errors.label}</p>}
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="cred-edit-key">{t("Nova chave (opcional)")}</Label>
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
              id="cred-edit-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provedor.prefixoDaChave}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {t("Em branco mantém a chave atual")} (…{credential.api_key_last4 ?? "????"}).
            </p>
            {errors.api_key && <p className="text-xs text-destructive">{errors.api_key}</p>}
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
            <Button type="submit" disabled={submitting || !mudou}>
              {submitting ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
