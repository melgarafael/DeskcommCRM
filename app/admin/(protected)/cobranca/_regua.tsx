"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

const MINIMO = 5;
const MAXIMO = 30;

/** A Régua (spec §7g, D-5): a tolerância, e a linha do tempo que a empresa vai viver com ela. */
export function ReguaDaCobranca({ tolerancia }: { tolerancia: number }) {
  const t = useT();
  const router = useRouter();
  const [dias, setDias] = useState(String(tolerancia));
  const [ocupado, setOcupado] = useState(false);
  const n = Number(dias);
  const valido = Number.isInteger(n) && n >= MINIMO && n <= MAXIMO;
  const efetivo = valido ? n : tolerancia;

  async function salvar() {
    setOcupado(true);
    try {
      await apiClient.patch("/api/v1/admin/cobranca/regua", { tolerancia_dias: n });
      toast.success(t("Régua salva."));
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card className="max-w-2xl space-y-4 p-6">
      <div className="space-y-1">
        <Label htmlFor="tolerancia">{t("Dias de tolerância")}</Label>
        <Input id="tolerancia" type="number" min={MINIMO} max={MAXIMO} value={dias} onChange={(e) => setDias(e.target.value)} className="w-28" />
        <p className="text-xs text-muted-foreground">{t("De 5 a 30 dias. Abaixo de 5, quem paga boleto na sexta seria suspenso antes de o pagamento compensar.")}</p>
      </div>
      <ol className="space-y-1 text-sm">
        <li>{t("Dia 0: aviso de pagamento não identificado, com o link para pagar.")}</li>
        <li>{t("Dia {n}: aviso final, com a data da suspensão.").replace("{n}", String(efetivo - 2))}</li>
        <li>{t("Dia {n} (e pelo menos 48 horas depois do aviso final): a empresa é suspensa.").replace("{n}", String(efetivo))}</li>
        <li>{t("Pagou: volta a funcionar sozinha, na hora, sem disparar o que ficou parado.")}</li>
      </ol>
      <Button disabled={ocupado || !valido} onClick={() => void salvar()}>
        {t("Salvar régua")}
      </Button>
    </Card>
  );
}
