"use client";

/**
 * "Registrar venda" — valor, data, tags e observação.
 *
 * Abre do botão "+" do card do funil e da seção "Vendas" do negócio (no funil e
 * no Inbox). A venda conta no painel de vendas em qualquer etapa do card, e o
 * mesmo negócio aceita várias (recompra). A data vem preenchida com HOJE, no
 * calendário do aparelho, e pode ser trocada para registrar uma venda antiga.
 *
 * As tags são digitadas separadas por vírgula e normalizadas pelo servidor (a
 * mesma régua das tags do contato): o que a prévia mostra é o que o filtro do
 * painel vai casar.
 */
import { useState } from "react";
import { toast } from "sonner";

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
import { useT } from "@/hooks/i18n/useT";
import { useRegistrarVenda } from "@/hooks/vendas/useVendasRegistradas";
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import { parseReaisToCents } from "@/lib/money";

/** "Atacado, recompra ,  VIP" → as tags como o servidor vai gravar. */
export function tagsDoTexto(texto: string): string[] {
  return normalizarTags(texto.split(","));
}

/** Hoje no calendário do aparelho, em AAAA-MM-DD. */
export function hojeNoAparelho(agora: Date = new Date()): string {
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  /** O nome do negócio, só para o título dizer de quem é a venda. */
  titulo?: string | null;
  moeda?: string;
  /** Depois de gravar — para quem mostra o valor fora do TanStack Query (o Inbox). */
  aoRegistrar?: () => void;
}

export function RegistrarVendaDialog({ open, onOpenChange, leadId, titulo, moeda = "BRL", aoRegistrar }: Props) {
  const t = useT();
  const registrar = useRegistrarVenda();
  const [valor, setValor] = useState("");
  // Hoje, lido quando a JANELA nasce: quem a usa monta este componente só
  // depois do clique (nunca na primeira renderização da página), então não há
  // HTML do servidor para discordar.
  const [data, setData] = useState(() => hojeNoAparelho());
  const [tags, setTags] = useState("");
  const [observacao, setObservacao] = useState("");

  // Reaberta sem desmontar: começa de novo, com a data de hoje.
  function aoMudarAberto(proximo: boolean) {
    if (proximo) {
      setValor("");
      setData(hojeNoAparelho());
      setTags("");
      setObservacao("");
    }
    onOpenChange(proximo);
  }

  const valorCents = parseReaisToCents(valor, moeda);
  const valido = valorCents !== null && valorCents > 0 && data !== "";

  async function salvar() {
    if (!valido || registrar.isPending) return;
    try {
      await registrar.mutateAsync({
        lead_id: leadId,
        valor_cents: valorCents,
        data,
        tags: tagsDoTexto(tags),
        ...(observacao.trim() ? { observacao: observacao.trim() } : {}),
      });
      toast.success(t("Venda registrada."));
      aoRegistrar?.();
      onOpenChange(false);
    } catch {
      // o erro já virou toast em `useRegistrarVenda`
    }
  }

  const previa = tagsDoTexto(tags);

  return (
    <Dialog open={open} onOpenChange={aoMudarAberto}>
      <DialogContent data-testid="registrar-venda">
        <DialogHeader>
          <DialogTitle>{t("Registrar venda")}</DialogTitle>
          <DialogDescription>
            {titulo ? `${titulo} — ` : ""}
            {t("A venda entra no painel de vendas na hora, em qualquer etapa do card.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="valor-da-venda">{t("Valor")}</Label>
            <Input
              id="valor-da-venda"
              inputMode="decimal"
              placeholder="180,00"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="data-da-venda">{t("Data da venda")}</Label>
            <Input id="data-da-venda" type="date" value={data} onChange={(e) => setData(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tags-da-venda">{t("Tags (separe por vírgula)")}</Label>
            <Input
              id="tags-da-venda"
              placeholder={t("atacado, recompra")}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
            {previa.length > 0 && (
              <div className="flex flex-wrap gap-1" data-testid="previa-das-tags">
                {previa.map((tag) => (
                  <span key={tag} className="rounded-full bg-surface-elevated px-2 py-0.5 text-xs">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="observacao-da-venda">{t("Observação (opcional)")}</Label>
            <Input
              id="observacao-da-venda"
              maxLength={500}
              placeholder={t("O que foi vendido")}
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={registrar.isPending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={salvar} disabled={!valido || registrar.isPending} data-testid="salvar-venda">
            {registrar.isPending ? t("Salvando...") : t("Registrar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
