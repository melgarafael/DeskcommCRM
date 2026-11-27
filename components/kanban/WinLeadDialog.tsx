"use client";
import { useState } from "react";
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
import { useWinLead } from "@/hooks/kanban/useUpdateLead";

/**
 * "MARCAR COMO GANHO" PEDE O MOTIVO (issue #5181) — quando há o que perguntar.
 *
 * ─── Por que esta caixa existe ────────────────────────────────────────────
 *
 * O menu do card fechava o negócio com `mutate({ leadId })`: nenhuma pergunta.
 * Com `settings.won_reasons` cadastrado, a pessoa nem sabia que havia lista;
 * digitava nada, e o servidor — que já era dono da régua — recusava depois com
 * `required_fields_missing` (motivo faltando) ou `won_reason_invalid` (motivo
 * fora da lista), na altura em que ela já tinha clicado. E mais: com a lista
 * cadastrada, o ganho por este caminho NUNCA acertava o vocabulário do funil,
 * porque o corpo ia sem `won_reason`.
 *
 * ─── O que ele NÃO decide ─────────────────────────────────────────────────
 *
 * Não torna nada obrigatório: quem decide isso é `settings.won_reason_required`
 * no funil, e a caixa só se abre quando ele está ligado ou quando o funil tem
 * lista (`useRegraDoMotivoDeGanho`). Funil sem lista e sem obrigatoriedade
 * continua fechando em um clique, sem janela nenhuma — o caminho "nada mudou".
 *
 * Não valida vocabulário: a lista que ele mostra É a do funil, mas quem aceita
 * ou recusa o valor é o servidor. A recusa dele (`won_reason_invalid`) volta
 * como mensagem DENTRO da caixa, ao lado da lista que a pessoa precisa reler —
 * nunca como toast genérico, que some justamente quando ela precisa da lista.
 */
interface WinLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
  /** O negócio na confirmação — o card pode ter título igual ao do vizinho. */
  leadLabel?: string;
  /** `settings.won_reasons`: vazio é TEXTO LIVRE, o comportamento do servidor. */
  motivos: string[];
  /** `settings.won_reason_required`: só com ele a caixa não aceita ficar vazia. */
  exigido: boolean;
  /** Depois de gravar — para quem mora fora do quadro recarregar o que mostra. */
  onGanho?: () => void;
}

/** O mesmo teto do schema do motivo (`won_reason: z.string().max(500)`). */
const MAX_LEN = 500;

export function WinLeadDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
  leadLabel,
  motivos,
  exigido,
  onGanho,
}: WinLeadDialogProps) {
  const t = useT();
  const [motivoDaLista, setMotivoDaLista] = useState("");
  const [textoLivre, setTextoLivre] = useState("");
  const [recusa, setRecusa] = useState<string | null>(null);

  const temLista = motivos.length > 0;
  // Com lista, o que vale é a escolha; sem lista, o texto digitado. O `trim` é
  // o mesmo do servidor (`recusaDeMotivoDoGanho` apara antes de comparar).
  const motivo = temLista ? motivoDaLista : textoLivre.trim();

  const mutation = useWinLead(pipelineId, {
    // A recusa é da CAIXA, não do toast: o texto é o mesmo da rota, para a
    // pessoa não achar que são dois problemas (`lib/leads/campos-exigidos.ts`).
    onMotivoRecusado: () =>
      setRecusa(
        t("Este motivo de ganho não está na lista do funil. Escolha um dos motivos cadastrados."),
      ),
  });

  const emVoo = mutation.isPending;
  const podeConfirmar = motivo.length > 0 && motivo.length <= MAX_LEN && !emVoo;

  const fecharCom = (wonReason?: string) => {
    mutation.mutate(
      { leadId, ...(wonReason ? { wonReason } : {}) },
      {
        onSuccess: () => {
          setRecusa(null);
          setMotivoDaLista("");
          setTextoLivre("");
          onOpenChange(false);
          onGanho?.();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Marcar como ganho")}</DialogTitle>
          <DialogDescription>
            {leadLabel && <span className="mb-1 block font-medium">{leadLabel}</span>}
            {temLista
              ? t("Escolha o motivo do ganho deste funil.")
              : t("Informe o motivo do ganho. Essa informação ajuda a entender o que traz resultado.")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Label>{t("Motivo do ganho")}</Label>
          {temLista ? (
            <div className="grid grid-cols-1 gap-1.5" role="radiogroup" aria-label={t("Motivo do ganho")}>
              {motivos.map((opcao) => (
                <label
                  key={opcao}
                  className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
                >
                  <input
                    type="radio"
                    name="won-reason"
                    value={opcao}
                    checked={motivoDaLista === opcao}
                    onChange={(e) => {
                      setMotivoDaLista(e.target.value);
                      setRecusa(null);
                    }}
                  />
                  {/* O rótulo é o texto do funil: dado, não interface — não se traduz. */}
                  <span>{opcao}</span>
                </label>
              ))}
            </div>
          ) : (
            <Input
              aria-label={t("Motivo do ganho")}
              value={textoLivre}
              maxLength={MAX_LEN}
              onChange={(e) => {
                setTextoLivre(e.target.value);
                setRecusa(null);
              }}
            />
          )}

          {exigido && (
            <p className="text-xs text-muted-foreground">
              {t("Este funil exige o motivo do ganho para fechar o negócio.")}
            </p>
          )}

          {recusa && (
            <p role="alert" className="text-xs text-destructive">
              {recusa}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={emVoo}>
            {t("Cancelar")}
          </Button>
          {/*
            O "sem motivo" só existe onde ele é legítimo: com
            `won_reason_required` desligado. É ele que mantém o caminho de antes
            para quem tem lista cadastrada mas não quer tornar a escolha
            obrigatória — a caixa aparece, e sair sem escolher continua possível.
          */}
          {!exigido && (
            <Button variant="ghost" onClick={() => fecharCom()} disabled={emVoo}>
              {t("Fechar sem motivo")}
            </Button>
          )}
          <Button onClick={() => fecharCom(motivo)} disabled={!podeConfirmar}>
            {emVoo ? t("Salvando…") : t("Confirmar ganho")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
