"use client";

/**
 * O cadastro da meta mensal (issue #3025, fatia 1; meta em VALOR na #4796).
 *
 * ─── O que a pessoa escolhe aqui ───────────────────────────────────────────
 * O MÊS, o INDICADOR (quantidade de vendas ganhas ou valor vendido) e de QUEM
 * é a meta (a empresa inteira ou um vendedor). O valor é digitado na moeda da
 * organização e convertido para CENTAVOS ao salvar: é a unidade de
 * `crm_leads.value_cents`, a mesma que a rota soma.
 *
 * ─── O default não muda o número de quem já usa ────────────────────────────
 * O indicador começa em "quantidade", que é o que a meta antiga — gravada antes
 * deste campo existir — significa. Quem nunca abriu esta tela continua vendo
 * exatamente o mesmo percentual de antes.
 *
 * ─── Cada recusa vira uma frase que diz O QUE FAZER ────────────────────────
 * "forbidden_role" mandaria um atendente tentar de novo para falhar igual,
 * então ela diz quem pode.
 */
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirMetaMensal } from "@/app/actions/settings/definirMetaMensal";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useTeamMembers } from "@/hooks/team/useTeamMembers";
import { simboloDaMoeda } from "@/lib/money";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira os campos: o mês e o alvo precisam estar preenchidos.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só quem administra a empresa pode definir a meta.",
  erro_ao_gravar: "Não consegui gravar a meta agora. Tente de novo em instantes.",
};

const EMPRESA = "__empresa__";

export type IndicadorDaMeta = "vendas_ganhas" | "valor_vendido";

/** A meta já gravada, como a página entrega para o formulário. */
export interface MetaGravada {
  indicador: IndicadorDaMeta;
  vendedor_id: string | null;
  /** Quantidade em vendas, ou valor em CENTAVOS. */
  alvo: number;
}

/** "R$", "€"… — código que o `Intl` recusa vira o próprio código, sem derrubar a tela. */
function simboloOuCodigo(moeda: string): string {
  try {
    return simboloDaMoeda(moeda);
  } catch {
    return moeda;
  }
}

export function FormularioDaMeta({
  mes,
  metas,
  moeda,
}: {
  mes: string;
  metas: readonly MetaGravada[];
  /** Moeda da organização (ISO-4217): a unidade do alvo em valor, a mesma de `value_cents`. */
  moeda: string;
}) {
  const t = useT();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const equipe = useTeamMembers();

  const [periodo, setPeriodo] = useState(mes);
  const [indicador, setIndicador] = useState<IndicadorDaMeta>("vendas_ganhas");
  const [vendedor, setVendedor] = useState<string>(EMPRESA);
  const [alvo, setAlvo] = useState("");

  const vendedorId = vendedor === EMPRESA ? null : vendedor;
  const simbolo = simboloOuCodigo(moeda);

  // Ao trocar mês, indicador ou dono, o campo mostra o que JÁ está gravado para
  // aquela combinação — em vez de obrigar a pessoa a lembrar o número antigo.
  useEffect(() => {
    const existente = metas.find(
      (m) => m.indicador === indicador && (m.vendedor_id ?? null) === vendedorId,
    );
    if (!existente) {
      setAlvo("");
      return;
    }
    setAlvo(
      indicador === "valor_vendido" ? (existente.alvo / 100).toFixed(2) : String(existente.alvo),
    );
  }, [periodo, indicador, vendedorId, metas]);

  const numero = indicador === "valor_vendido" ? Number(alvo.replace(",", ".")) : Number(alvo);
  const alvoEmUnidade = Math.round(numero * (indicador === "valor_vendido" ? 100 : 1));
  const podeSalvar =
    /^\d{4}-\d{2}$/.test(periodo) &&
    alvo.trim() !== "" &&
    Number.isFinite(alvoEmUnidade) &&
    alvoEmUnidade > 0;

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    if (!podeSalvar) {
      toast.error(
        indicador === "valor_vendido"
          ? t("Informe um mês e um valor maior que zero.")
          : t("Informe um mês e uma quantidade de vendas maior que zero."),
      );
      return;
    }
    startTransition(async () => {
      const resultado = await definirMetaMensal({
        periodo,
        indicador,
        vendedor_id: vendedorId,
        alvo: alvoEmUnidade,
      });
      if (resultado.ok) {
        toast.success(t("Meta salva."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar a meta agora."));
    });
  }

  return (
    <Card className="max-w-xl p-6">
      <form onSubmit={salvar} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="periodo">{t("Mês")}</Label>
          <Input
            id="periodo"
            type="month"
            value={periodo}
            onChange={(e) => setPeriodo(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("A meta vale para o mês escolhido, do dia 1º ao último.")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="indicador">{t("Indicador")}</Label>
          <Select
            value={indicador}
            onValueChange={(v) =>
              setIndicador(v === "valor_vendido" ? "valor_vendido" : "vendas_ganhas")
            }
          >
            <SelectTrigger id="indicador">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vendas_ganhas">{t("Quantidade de vendas ganhas")}</SelectItem>
              <SelectItem value="valor_vendido">{`${t("Valor vendido")} (${simbolo})`}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t(
              "Meta antiga, sem indicador, continua contando vendas ganhas — escolher valor aqui não muda as metas já cadastradas.",
            )}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="vendedor">{t("De quem é a meta")}</Label>
          <Select value={vendedor} onValueChange={setVendedor}>
            <SelectTrigger id="vendedor">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EMPRESA}>{t("Empresa (todos)")}</SelectItem>
              {(equipe.data?.data ?? []).map((membro) => (
                <SelectItem key={membro.user_id} value={membro.user_id}>
                  {rotuloDoMembro(
                    { full_name: membro.full_name, email: membro.email, user_id: membro.user_id },
                    t,
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t(
              "A meta do vendedor soma só os negócios que ele fechou como ganho; a da empresa soma os da empresa inteira.",
            )}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="alvo">
            {indicador === "valor_vendido"
              ? `${t("Valor no mês")} (${simbolo})`
              : t("Vendas ganhas no mês")}
          </Label>
          <Input
            id="alvo"
            type="number"
            inputMode="decimal"
            min={indicador === "valor_vendido" ? 0.01 : 1}
            step={indicador === "valor_vendido" ? 0.01 : 1}
            value={alvo}
            onChange={(e) => setAlvo(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {alvo.length === 0
              ? t("Ainda não há meta para este mês.")
              : t("Salvar de novo corrige a meta deste mês — nada é duplicado.")}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isPending || !podeSalvar}>
            {isPending ? t("Salvando…") : t("Salvar meta")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
