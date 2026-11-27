"use client";

/**
 * O cadastro da meta mensal (issue #3025, fatia 1; meta em VALOR na #4796).
 *
 * ─── O que a pessoa escolhe aqui ───────────────────────────────────────────
 * O MÊS, o INDICADOR (quantidade de vendas ganhas ou valor vendido) e de QUEM
 * é a meta (a empresa inteira, um funil ou um vendedor). Funil e vendedor
 * moram no MESMO seletor de propósito: a meta é de um ou de outro, nunca dos
 * dois (`crm_metas_dono_ou_funil`), e um seletor só não deixa montar a
 * combinação que o banco recusaria (#4796). O valor é digitado na moeda da
 * organização e convertido para CENTAVOS ao salvar: é a unidade de
 * `crm_leads.value_cents`, a mesma que a rota soma.
 *
 * ─── O default não muda o número de quem já usa ────────────────────────────
 * O indicador começa em "quantidade", que é o que a meta antiga — gravada antes
 * deste campo existir — significa. Quem nunca abriu esta tela continua vendo
 * exatamente o mesmo percentual de antes.
 *
 * ─── Só quem ESTÁ na equipe pode ter meta ─────────────────────────────────
 * O seletor oferece só quem tem o vínculo vivo (`revoked_at` nulo), a mesma
 * régua da action (#4986): oferecer um revogado era convidar a pessoa a salvar
 * para ser recusada.
 *
 * ─── Cada recusa vira uma frase que diz O QUE FAZER ────────────────────────
 * "forbidden_role" mandaria um atendente tentar de novo para falhar igual,
 * então ela diz quem pode.
 */
import { useEffect, useRef, useState, useTransition } from "react";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useTeamMembers } from "@/hooks/team/useTeamMembers";
import { apiClient } from "@/lib/api/client";
import { janelaDoMes } from "@/lib/metas/periodo";
import { simboloDaMoeda } from "@/lib/money";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira os campos: o mês e o alvo precisam estar preenchidos.",
  vendedor_fora_da_equipe: "Essa pessoa não faz mais parte da equipe. Escolha outra pessoa ou a empresa.",
  funil_invalido: "Esse funil não está mais disponível. Recarregue a página e escolha outro.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só quem administra a empresa pode definir a meta.",
  erro_ao_gravar: "Não consegui gravar a meta agora. Tente de novo em instantes.",
};

const EMPRESA = "__empresa__";
/** Prefixo do valor do seletor quando o dono da meta é um FUNIL (o vendedor é o id puro). */
const FUNIL = "funil:";

export type IndicadorDaMeta = "vendas_ganhas" | "valor_vendido";

/** A meta já gravada, como a página entrega para o formulário. */
export interface MetaGravada {
  /** 'YYYY-MM' da meta; ausente = o mês que a página abriu (`mes`). */
  periodo?: string;
  indicador: IndicadorDaMeta;
  vendedor_id: string | null;
  /** Funil da meta (#4796); ausente nas metas de empresa e de vendedor. */
  pipeline_id?: string | null;
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
  funis = [],
}: {
  mes: string;
  /** `null` = a página não conseguiu ler: o formulário lê sozinho, em vez de mostrar "sem meta". */
  metas: readonly MetaGravada[] | null;
  /** Moeda da organização (ISO-4217): a unidade do alvo em valor, a mesma de `value_cents`. */
  moeda: string;
  /** Os funis em uso (não arquivados) da organização, que podem ter meta própria. */
  funis?: ReadonlyArray<{ id: string; name: string }>;
}) {
  const t = useT();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const equipe = useTeamMembers();

  const [periodo, setPeriodo] = useState(mes);
  // As metas gravadas do mês que está NA TELA. A página entrega as do mês em que
  // abriu; trocar o mês lê as daquele mês (#4796) — antes, o alvo deste mês
  // aparecia no campo do outro, e salvar gravava esse número lá.
  // As do mês em que a página abriu vêm por prop só na PRIMEIRA pintura; daí em
  // diante todo mês — inclusive esse — vem da última leitura, e trocar de mês
  // ou salvar descarta a leitura (`null` = ainda não chegou: o campo e o salvar
  // ficam travados).
  const [lidas, setLidas] = useState<{ periodo: string; metas: readonly MetaGravada[] } | null>(() =>
    metas ? { periodo: mes, metas } : null,
  );
  const [falhaAoLer, setFalhaAoLer] = useState<string | null>(null);
  const metasDoPeriodo: readonly MetaGravada[] | null = lidas?.periodo === periodo ? lidas.metas : null;
  // A leitura mais recente, para o efeito do campo consultar sem depender dela:
  // o campo só se repõe quando muda a COMBINAÇÃO (mês, indicador, dono) ou
  // quando a leitura do mês chega — nunca porque um salvar anterior voltou.
  const metasAtuais = useRef(metasDoPeriodo);
  useEffect(() => {
    metasAtuais.current = metasDoPeriodo;
  }, [metasDoPeriodo]);
  const mesLido = metasDoPeriodo !== null;
  const erroAoLer = falhaAoLer === periodo && metasDoPeriodo === null;
  const lendo = metasDoPeriodo === null && !erroAoLer;
  // Cada "Tentar de novo" é uma leitura nova do mesmo mês.
  const [tentativa, setTentativa] = useState(0);

  /**
   * Trocar o mês descarta o que se leu de OUTRO mês: voltar a ele relê, em vez
   * de reaproveitar um número que outra pessoa pode ter corrigido nesse meio
   * tempo — salvar em cima dele desfaria a correção.
   */
  function trocarMes(novo: string) {
    setPeriodo(novo);
    setLidas(null);
    setFalhaAoLer(null);
  }
  const [indicador, setIndicador] = useState<IndicadorDaMeta>("vendas_ganhas");
  const [vendedor, setVendedor] = useState<string>(EMPRESA);
  const [alvo, setAlvo] = useState("");
  // Quem o servidor recusou como fora da equipe: some do seletor na hora, sem
  // esperar a lista da equipe voltar (#4986). Vale só enquanto a lista na tela é
  // a MESMA da recusa — quando a lista recarregada chega, ela é quem manda (se a
  // pessoa voltou a ter acesso, ela volta a aparecer).
  const [recusa, setRecusa] = useState<{ ids: ReadonlySet<string>; lista: unknown }>(() => ({
    ids: new Set(),
    lista: undefined,
  }));
  const recusados: ReadonlySet<string> = recusa.lista === equipe.data ? recusa.ids : new Set();

  const pipelineId = vendedor.startsWith(FUNIL) ? vendedor.slice(FUNIL.length) : null;
  const vendedorId = vendedor === EMPRESA || pipelineId !== null ? null : vendedor;
  const naEquipe = (equipe.data?.data ?? []).filter(
    (membro) => !membro.revoked_at && !recusados.has(membro.user_id),
  );
  // A pessoa escolhida saiu da equipe com a tela aberta (lista recarregada ou
  // recusa do servidor): salvar fica travado até escolher outra pessoa ou a
  // empresa — nunca manda o id de quem já não está, nem troca o dono sozinho.
  const vendedorSaiu =
    vendedorId !== null &&
    (recusados.has(vendedorId) ||
      (equipe.data !== undefined && !naEquipe.some((membro) => membro.user_id === vendedorId)));
  const simbolo = simboloOuCodigo(moeda);

  // Ao trocar mês, indicador ou dono, o campo mostra o que JÁ está gravado para
  // aquela combinação — em vez de obrigar a pessoa a lembrar o número antigo.
  useEffect(() => {
    if (metasDoPeriodo !== null || falhaAoLer === periodo || !/^\d{4}-\d{2}$/.test(periodo)) return;
    let vivo = true;
    // A MESMA leitura do Desempenho (`/api/v1/metrics/metas`, mês pelo texto da
    // janela): uma régua só para "as metas deste mês".
    const janela = janelaDoMes(periodo);
    apiClient
      .get<{ data: { metas?: ReadonlyArray<Record<string, unknown>> } }>(
        `/api/v1/metrics/metas?from=${encodeURIComponent(janela.from)}&to=${encodeURIComponent(janela.to)}`,
      )
      .then((r) => {
        if (!vivo) return;
        const doMes = (r.data?.metas ?? [])
          .filter((m) => m.indicador === "vendas_ganhas" || m.indicador === "valor_vendido")
          .map((m) => ({
            periodo,
            indicador: m.indicador as IndicadorDaMeta,
            vendedor_id: (m.vendedor_id as string | null | undefined) ?? null,
            pipeline_id: (m.pipeline_id as string | null | undefined) ?? null,
            alvo: Number(m.alvo),
          }));
        setLidas({ periodo, metas: doMes });
      })
      .catch(() => {
        if (vivo) setFalhaAoLer(periodo);
      });
    return () => {
      vivo = false;
    };
  }, [periodo, metasDoPeriodo, falhaAoLer, tentativa]);

  useEffect(() => {
    // Enquanto o mês novo não chega, o campo não carrega o número de outro mês.
    const existente = (metasAtuais.current ?? []).find(
      (m) =>
        (m.periodo ?? periodo) === periodo &&
        m.indicador === indicador &&
        (m.vendedor_id ?? null) === vendedorId &&
        (m.pipeline_id ?? null) === pipelineId,
    );
    if (!existente) {
      setAlvo("");
      return;
    }
    setAlvo(
      indicador === "valor_vendido" ? (existente.alvo / 100).toFixed(2) : String(existente.alvo),
    );
  }, [periodo, indicador, vendedorId, pipelineId, mesLido]);

  const numero = indicador === "valor_vendido" ? Number(alvo.replace(",", ".")) : Number(alvo);
  const alvoEmUnidade = Math.round(numero * (indicador === "valor_vendido" ? 100 : 1));
  const podeSalvar =
    /^\d{4}-\d{2}$/.test(periodo) &&
    alvo.trim() !== "" &&
    Number.isFinite(alvoEmUnidade) &&
    alvoEmUnidade > 0 &&
    !vendedorSaiu &&
    // Sem ler o mês, salvar poderia corrigir uma meta que a tela não mostrou.
    metasDoPeriodo !== null;

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    if (vendedorSaiu) {
      toast.error(t("Essa pessoa não faz mais parte da equipe. Escolha outra pessoa ou a empresa."));
      return;
    }
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
        pipeline_id: pipelineId,
        alvo: alvoEmUnidade,
      });
      if (resultado.ok) {
        toast.success(t("Meta salva."));
        // A meta salva entra na leitura do mês SEM reler e sem mexer no campo:
        // a resposta de um salvar anterior não pode trocar o que a pessoa já
        // digita em outra combinação ou em outro mês.
        const salva: MetaGravada = {
          periodo,
          indicador,
          vendedor_id: vendedorId,
          pipeline_id: pipelineId,
          alvo: alvoEmUnidade,
        };
        setLidas((atual) =>
          atual && atual.periodo === periodo
            ? {
                periodo,
                metas: [
                  ...atual.metas.filter(
                    (m) =>
                      !(
                        m.indicador === salva.indicador &&
                        (m.vendedor_id ?? null) === salva.vendedor_id &&
                        (m.pipeline_id ?? null) === salva.pipeline_id
                      ),
                  ),
                  salva,
                ],
              }
            : atual,
        );
        router.refresh();
        return;
      }
      if (resultado.error === "vendedor_fora_da_equipe" && vendedorId) {
        const lista = equipe.data;
        setRecusa((atual) => ({
          ids: new Set(atual.lista === lista ? atual.ids : []).add(vendedorId),
          lista,
        }));
        void equipe.refetch();
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
            onChange={(e) => trocarMes(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("A meta vale para o mês escolhido, do dia 1º ao último.")}
          </p>
          {erroAoLer ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
              <span>{t("Não consegui ler as metas deste mês.")}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setFalhaAoLer(null);
                  setTentativa((n) => n + 1);
                }}
              >
                {t("Tentar de novo")}
              </Button>
            </div>
          ) : null}
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
              {funis.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>{t("Funis")}</SelectLabel>
                  {funis.map((funil) => (
                    // O nome do funil é dado do operador: não passa por `t()`.
                    <SelectItem key={funil.id} value={`${FUNIL}${funil.id}`}>
                      {`${t("Funil")} · ${funil.name}`}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {naEquipe.map((membro) => (
                <SelectItem key={membro.user_id} value={membro.user_id}>
                  {rotuloDoMembro(
                    { full_name: membro.full_name, email: membro.email, user_id: membro.user_id },
                    t,
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {vendedorSaiu ? (
            <p role="alert" className="text-xs text-destructive">
              {t("Essa pessoa não faz mais parte da equipe. Escolha outra pessoa ou a empresa.")}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t(
              "A meta do vendedor soma só os negócios que ele fechou como ganho; a do funil, só os ganhos daquele funil; a da empresa soma os da empresa inteira.",
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
            // Enquanto o mês não foi lido, o que a pessoa digitasse seria
            // trocado pelo número gravado quando a leitura chegasse.
            disabled={metasDoPeriodo === null}
          />
          <p className="text-xs text-muted-foreground">
            {lendo
              ? t("Lendo as metas deste mês…")
              : erroAoLer
                ? null
                : alvo.length === 0
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
