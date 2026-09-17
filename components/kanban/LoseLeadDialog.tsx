"use client";
import { useMemo, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useLoseLead } from "@/hooks/kanban/useUpdateLead";
import { useMotivosDePerdaDoFunil } from "@/hooks/kanban/useMotivosDePerdaDoFunil";
import { CANONICAL_LOST_REASONS } from "@/lib/schemas/leads";
import type { CanonicalLostReason } from "@/lib/schemas/leads";
import { OUTRO, motivoDePerdaAceito, opcoesDeMotivoDePerda } from "@/lib/leads/motivos-de-perda-do-funil";

const REASON_LABELS: Record<(typeof CANONICAL_LOST_REASONS)[number], string> = {
  requested_by_customer: "Cliente solicitou cancelamento",
  price: "Preço",
  no_response: "Sem resposta do cliente",
  product_unavailable: "Produto indisponível",
  cancelled_by_store: "Cancelado pela loja",
  cancelled_by_customer: "Cancelado pelo cliente",
  payment_failed: "Falha no pagamento",
  other: "Outro motivo",
};

interface LoseLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
}

const MAX_LEN = 500;

export function LoseLeadDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
}: LoseLeadDialogProps) {
  const t = useT();
  const [reasonCode, setReasonCode] = useState<string>("");
  const [otherText, setOtherText] = useState("");
  const mutation = useLoseLead(pipelineId);

  // O funil deste card manda na lista: o que ele tem cadastrado substitui o
  // padrão do produto — ver lib/leads/motivos-de-perda-do-funil.ts.
  const cadastrados = useMotivosDePerdaDoFunil(pipelineId);
  const opcoes = useMemo(() => opcoesDeMotivoDePerda(cadastrados), [cadastrados]);
  const funilConfigurado = cadastrados.length > 0;

  const textoOutro = otherText.trim();
  // "OUTRO" VAZIO VALE `other` NOS DOIS CASOS — com funil configurado ou sem.
  //
  // ⚠️ `other` É CANÔNICO. `fn_validate_lost_reason_required` aceita
  // `v_canonical ∪ settings.lost_reasons`, e `v_canonical` traz `'other'`
  // (supabase/baseline.sql, `fn_validate_lost_reason_required`) — o servidor
  // aceita este valor em QUALQUER funil, configurado ou não. Exigir o detalhe
  // aqui quando o funil tem motivos cadastrados fazia de "Outro" um beco sem
  // saída: os únicos textos que passavam eram os que já são rádio na tela ao
  // lado, ou um código canônico em inglês que ninguém digita. E cadastrar um
  // motivo novo é admin-only (`app/actions/settings/updatePipelineConfig.ts`),
  // então um `agent` com uma perda fora da lista não tinha ação correta
  // nenhuma: ou gravava um motivo errado, ou não fechava o negócio.
  //
  // O que CONTINUA recusado antes do clique é o texto digitado fora de
  // canônico ∪ cadastrado (`outroRecusado` abaixo) — esse o trigger nega mesmo,
  // com 22023, e é ele que a issue #918 pede para barrar na tela.
  const outroRecusado =
    reasonCode === OUTRO &&
    funilConfigurado &&
    textoOutro.length > 0 &&
    !motivoDePerdaAceito(textoOutro, cadastrados);

  const finalReason = reasonCode === OUTRO ? textoOutro || OUTRO : reasonCode;
  const disabled =
    !reasonCode ||
    finalReason.length === 0 ||
    finalReason.length > MAX_LEN ||
    outroRecusado ||
    mutation.isPending;

  const handleSubmit = async () => {
    if (disabled) return;
    try {
      await mutation.mutateAsync({ leadId, lostReason: finalReason });
      setReasonCode("");
      setOtherText("");
      onOpenChange(false);
    } catch {
      // error already toasted
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Marcar como perdido")}</DialogTitle>
          <DialogDescription>
            {t("Informe o motivo. Essa informação ajuda a melhorar o funil.")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Label>{t("Motivo")}</Label>
          <div className="grid grid-cols-1 gap-1.5">
            {opcoes.map((opcao) => (
              <label
                key={opcao.valor}
                className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
              >
                <input
                  type="radio"
                  name="lost-reason"
                  value={opcao.valor}
                  checked={reasonCode === opcao.valor}
                  onChange={(e) => setReasonCode(e.target.value)}
                />
                <span>{opcao.doFunil ? opcao.valor : t(REASON_LABELS[opcao.valor as CanonicalLostReason] ?? opcao.valor)}</span>
              </label>
            ))}
          </div>
          {reasonCode === OUTRO && (
            <div className="grid gap-1.5">
              <Label htmlFor="lost-reason-other">
                {t("Detalhe (opcional)")}
              </Label>
              <Textarea
                id="lost-reason-other"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder={t("Ex: Cliente desistiu por X motivo")}
                maxLength={MAX_LEN}
                rows={3}
              />
              <div className="text-right text-[11px] text-muted-foreground tabular-nums">
                {otherText.length}/{MAX_LEN}
              </div>
              {outroRecusado && (
                <p role="alert" className="text-xs text-destructive">
                  {/*
                    A MESMA frase do servidor, e não uma irmã: `lib/leads/motivo-da-perda.ts`
                    (#935) já devolve este texto quando o motivo chega fora da lista pela
                    API. Duas frases quase idênticas para a MESMA recusa fazem o operador
                    achar que são dois problemas.
                  */}
                  {t(
                    "Esse motivo de perda não está na lista deste funil — escolha um dos motivos configurados.",
                  )}
                </p>
              )}
              {/*
                SEM condição de erro, e só com funil configurado: é lá que o
                texto livre é recusado, e quem quiser o motivo COM AS PRÓPRIAS
                PALAVRAS precisa cadastrá-lo. Deixar o detalhe em branco continua
                valendo — grava "Outro" —, e é por isso que esta frase é uma
                dica e não um aviso de erro. Sem funil configurado não aparece,
                porque lá o texto livre já passa e a frase seria ruído.
              */}
              {funilConfigurado && (
                <p className="text-xs text-muted-foreground">
                  {t("Para usar um motivo que não está aqui, cadastre em Configurações › Funis.")}
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t("Cancelar")}
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {mutation.isPending ? t("Salvando...") : t("Confirmar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
