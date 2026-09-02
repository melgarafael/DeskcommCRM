"use client";
/**
 * O card de orçamento de IA — a peça que, até a 0159, mentia POR DEFAULT.
 *
 * ═══ O QUE ESTAVA ERRADO ═══
 *
 * 1. A frase "a IA pausa ao chegar no limite" era falsa para 100% das
 *    instalações: a tela editava `ai_budgets.monthly_limit_cents` e quem barrava
 *    a chamada lia `organizations.settings.llm.monthly_budget_cents` — outro
 *    campo, sem escritor de produto.
 * 2. O dropdown "Ação ao atingir 100%" oferecia "Pausar" e "Desabilitar" como se
 *    fossem futuros diferentes. Não eram: nada no produto os distinguia. Saiu.
 * 3. Os badges "Pausado"/"Desabilitado" liam `is_throttled`/`is_disabled`, que
 *    têm leitor e NENHUM escritor vivo — o card ficava em silêncio exatamente
 *    enquanto o gate recusava a chamada. Agora o estado vem de um
 *    `budget_exceeded` aberto, que é o único produtor real.
 * 4. "0 desativa o orçamento" era um sentinela: um número com dois significados
 *    (e o enforcement lia o oposto — teto 0 bloqueava TUDO). Saiu. "Não quero
 *    limite" é a primeira opção do radio.
 * 5. O valor era formatado em R$ e o número é centavo de DÓLAR
 *    (`lib/agent-engine/edge/llm/pricing.ts` calcula em USD). Quem lia "R$ 50"
 *    tinha um teto ~5x maior do que pensava. Não convertemos moeda (exigiria
 *    fonte de câmbio, dependência externa nova num produto self-host); o rótulo
 *    passa a dizer a unidade real.
 *
 * ═══ A REGRA DE COPY DESTA TELA ═══
 *
 * Cada opção diz o que ACONTECE, e a que para a IA diz também o custo — as
 * conversas vão para a fila humana. Dizer o custo no momento da decisão é o que
 * separa uma escolha de uma armadilha.
 */
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PISO_DE_TETO_CENTS } from "@/lib/agent-engine/edge/llm/orcamento";
import { useAiBudget, useUpdateBudget, type BudgetStatus } from "@/hooks/ai/useAiBudget";

interface Props {
  initialData?: BudgetStatus;
  isAdmin: boolean;
}

type Modo = BudgetStatus["enforcement_mode"];

/**
 * DÓLAR, e não real. `llm_calls.cost_cents` é centavo de USD — é o que o
 * provedor cobra. Formatar em BRL fazia o dono do negócio ler um teto ~5x maior
 * do que o que estava armando.
 */
const usd = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "USD" });

function fmtCents(cents: number): string {
  return usd.format((cents ?? 0) / 100);
}

function fmtData(iso: string): string {
  return new Date(iso).toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" });
}

/**
 * O mês CORRENTE, escrito por extenso.
 *
 * ⚠️ Não é `status.current_period_start`. Aquela coluna só é preenchida pelo
 * DEFAULT do INSERT (`date_trunc('month', now())::date`), e o único escritor que
 * a atualizaria era o `runBudgetReset` — que nunca teve agendador e foi apagado.
 * O gasto ao lado dela vem de `fn_gasto_de_ia_do_mes`, que soma o MÊS CORRENTE.
 * Numa organização cuja linha nasceu em março, o rótulo dizia "Período iniciado
 * em 2026-03-01" ao lado do gasto de agosto: o rótulo contradizia o número que
 * ele rotula. Derivar da mesma janela da régua é o conserto; ressuscitar um
 * escritor da coluna seria manter dado morto vivo.
 */
function mesCorrente(): string {
  const agora = new Date();
  const nome = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)).toLocaleDateString(
    "pt-PT",
    { month: "long", year: "numeric", timeZone: "UTC" },
  );
  return nome;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** A frase de estado. Uma por modo, e todas verdadeiras — essa é a regra. */
function frameDoEstado(status: BudgetStatus): string {
  const efetivoEm = status.enforcement_effective_at;
  if (status.enforcement_mode === "off") {
    return "Isto é só acompanhamento. A IA não vai parar sozinha por gasto.";
  }
  if (status.enforcement_mode === "avisar") {
    return `Avisamos ao passar de ${status.alarm_threshold_pct}% do limite. A IA não para.`;
  }
  if (efetivoEm && new Date(efetivoEm).getTime() > Date.now()) {
    return `A parada começa a valer em ${fmtData(efetivoEm)}. Até lá, só avisamos.`;
  }
  return (
    `A IA para de responder ao chegar em ${fmtCents(status.monthly_limit_cents)}. ` +
    "Quando isso acontecer, as conversas em andamento vão para a fila de atendimento " +
    "humano e voltam ao automático uma a uma, pelo cabeçalho de cada conversa."
  );
}

/**
 * O kill switch da INSTALAÇÃO. Sem esta faixa, quem escolhe "Parar a IA" numa
 * VPS com a chave afrouxada estaria mexendo num controle que o processo ignora —
 * que é o defeito que este trabalho inteiro existe para consertar.
 */
function avisoDaChave(status: BudgetStatus): string | null {
  if (status.enforcement_env === "off") {
    return (
      "A proteção de gasto está desligada nesta instalação (AI_BUDGET_ENFORCEMENT=off). " +
      "O que estiver escolhido aqui não vale enquanto quem cuida do servidor não religar."
    );
  }
  if (status.enforcement_env === "avisar") {
    return (
      "Nesta instalação a proteção só avisa (AI_BUDGET_ENFORCEMENT=avisar): mesmo com " +
      '"Parar a IA" escolhido, ela vai continuar respondendo.'
    );
  }
  return null;
}

/**
 * A RESSALVA DE MEDIÇÃO — o furo debaixo de tudo, dito onde a pessoa decide.
 *
 * O produto só sabe calcular o custo de três famílias de modelo
 * (`lib/agent-engine/edge/llm/pricing.ts`, casamento por prefixo). Fora delas o
 * custo é gravado como NULO e o gasto somado fica MENOR que o real — no limite,
 * zero. Um card que promete "Parar a IA ao chegar em US$ X" nessa instalação
 * promete uma parada que nunca dispara. Prometer é pior que não oferecer.
 */
const AVISO_DE_MEDICAO =
  "Parte do que a IA gastou este mês não entra nesta conta: o produto ainda não sabe " +
  "o preço do modelo que está em uso, então o número abaixo é MENOR que o real e a " +
  "parada no limite pode não acontecer. Enquanto isso, acompanhe o gasto direto no " +
  "painel do seu provedor de IA.";

export function BudgetCard({ initialData, isAdmin }: Props) {
  const q = useAiBudget({ initialData });
  const status = q.data;

  if (!status) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Carregando orçamento...</p>
      </Card>
    );
  }

  const limit = status.monthly_limit_cents;
  const consumed = status.current_month_consumed_cents;
  const pct = clamp(status.pct, 0, 100);
  const overLimit = status.pct >= 100;
  const chave = avisoDaChave(status);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Orçamento mensal de IA</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Gasto de {mesCorrente()} · valores em dólar (é a moeda em que o provedor de
            IA cobra)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Um badge só de parada, e ele vem do ÚNICO produtor real: um
              `budget_exceeded` aberto na Central. */}
          {status.blocked_now && <Badge variant="destructive">IA parada por gasto</Badge>}
          {!status.blocked_now && overLimit && limit > 0 && (
            <Badge variant="secondary">Passou do limite</Badge>
          )}
          {isAdmin && <EditBudgetDialog status={status} />}
        </div>
      </div>

      {chave && (
        <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
          {chave}
        </p>
      )}

      {status.gasto_incompleto && (
        <p
          data-testid="aviso-medicao-incompleta"
          className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200"
        >
          {AVISO_DE_MEDICAO}
        </p>
      )}

      <div className="mt-4 space-y-2">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full transition-all ${
              status.pct >= 100
                ? "bg-destructive"
                : status.pct >= status.alarm_threshold_pct
                  ? "bg-amber-500"
                  : "bg-primary"
            }`}
            style={{ width: `${pct}%` }}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            role="progressbar"
          />
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span>
            <strong>{fmtCents(consumed)}</strong>
            {limit > 0 ? <> gastos de {fmtCents(limit)}</> : <> gastos este mês</>}
          </span>
          <span className="text-muted-foreground">
            {limit > 0 ? (
              <>
                {status.pct.toFixed(0)}% do limite · {frameDoEstado(status)}
              </>
            ) : (
              "Sem limite definido — a IA não vai parar sozinha por gasto."
            )}
          </span>
        </div>
      </div>
    </Card>
  );
}

function OpcaoDeModo({
  valor,
  atual,
  titulo,
  corpo,
  onPick,
  disabled,
  motivoBloqueado,
}: {
  valor: Modo;
  atual: Modo;
  titulo: string;
  corpo: string;
  onPick: (v: Modo) => void;
  disabled: boolean;
  motivoBloqueado?: string;
}) {
  const marcado = atual === valor;
  return (
    <label
      data-testid={`opcao-orcamento-${valor}`}
      data-marcada={marcado ? "sim" : "nao"}
      className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
        disabled
          ? "cursor-not-allowed border-border opacity-60"
          : marcado
            ? "cursor-pointer border-primary bg-primary/5"
            : "cursor-pointer border-border hover:bg-muted/40"
      }`}
    >
      <input
        type="radio"
        name="orcamento-modo"
        value={valor}
        checked={marcado}
        onChange={() => onPick(valor)}
        disabled={disabled}
        className="mt-1 h-4 w-4 shrink-0 accent-primary"
        aria-label={titulo}
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium">{titulo}</span>
        <span className="block text-xs text-muted-foreground">{corpo}</span>
        {disabled && motivoBloqueado && (
          <span className="block text-xs text-amber-700 dark:text-amber-300">
            {motivoBloqueado}
          </span>
        )}
      </span>
    </label>
  );
}

function EditBudgetDialog({ status }: { status: BudgetStatus }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateBudget();
  const [limitUsd, setLimitUsd] = useState<string>(
    (status.monthly_limit_cents / 100).toFixed(2),
  );
  const [thresholdPct, setThresholdPct] = useState<number>(status.alarm_threshold_pct);
  const [modo, setModo] = useState<Modo>(status.enforcement_mode);
  const [imediato, setImediato] = useState(false);

  useEffect(() => {
    if (open) {
      setLimitUsd((status.monthly_limit_cents / 100).toFixed(2));
      setThresholdPct(status.alarm_threshold_pct);
      setModo(status.enforcement_mode);
      setImediato(false);
    }
  }, [open, status]);

  // Campo vazio é INVÁLIDO, e não zero: `Number("")` é 0, e cair em "sem teto"
  // por um campo apagado seria desarmar a proteção sem ninguém escolher isso.
  const digitado = limitUsd.trim();
  const valorUsd = digitado === "" ? Number.NaN : Number(digitado.replace(",", "."));
  const centsValidos = Number.isFinite(valorUsd) && valorUsd >= 0;
  const centsDigitados = centsValidos ? Math.round(valorUsd * 100) : 0;
  const tetoParaCopy = centsValidos ? centsDigitados : status.monthly_limit_cents;

  // A ESCADA, na tela. O servidor recusa `off → bloquear` com 422; aqui a opção
  // nasce desabilitada com o motivo escrito, para que ninguém descubra a regra
  // por uma mensagem de erro.
  const pularDegrau = status.enforcement_mode === "off";
  // O piso NÃO desabilita o radio: quem já está em "Parar a IA" e digita um
  // valor baixo continua com a opção marcada (um radio marcado e desabilitado
  // parece defeito) — o que trava é o salvar, com o motivo escrito ao lado do
  // campo que ofende.
  //
  // ⚠️ VALE PARA `avisar` TAMBÉM (espelha o 422 da rota): "Me avisar ao passar de
  // 80% de US$ 0,00" era salvável, e produzia um aviso PERMANENTE e falso na
  // Central — a condição do limiar vira `gasto >= 0`, sempre verdadeira, e o
  // retrato exigia `gasto < 0`. Quem quer acompanhar sem limite escolhe "Só
  // acompanhar".
  const tetoInsuficiente = modo !== "off" && centsValidos && centsDigitados < PISO_DE_TETO_CENTS;
  const armando = modo === "bloquear" && status.enforcement_mode !== "bloquear";
  // Um só lugar decide o limiar que a cópia MOSTRA e que o payload MANDA: dois
  // cálculos separados é como a frase e o dado passam a discordar. O 50..99 é o
  // CHECK do banco; campo apagado vira 0 no `Number("")` e o clamp o sobe.
  const limiarEfetivo = Number.isFinite(thresholdPct)
    ? clamp(Math.round(thresholdPct), 50, 99)
    : status.alarm_threshold_pct;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!centsValidos || tetoInsuficiente) return;
    update.mutate(
      {
        enforcement_mode: modo,
        monthly_limit_cents: centsDigitados,
        alarm_threshold_pct: limiarEfetivo,
        ...(armando && imediato ? { confirmar_imediato: true } : {}),
      },
      { onSuccess: () => setOpen(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Editar limite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Orçamento de IA</DialogTitle>
          <DialogDescription>
            Escolha o que acontece quando o gasto do mês chega no limite. Os valores
            são em dólar — é a moeda em que o provedor de IA cobra.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <OpcaoDeModo
              valor="off"
              atual={modo}
              onPick={setModo}
              disabled={update.isPending}
              titulo="Só acompanhar"
              corpo="A IA nunca para por gasto. Você vê o número nesta tela e decide o que fazer."
            />
            <OpcaoDeModo
              valor="avisar"
              atual={modo}
              onPick={setModo}
              disabled={update.isPending}
              titulo={`Me avisar ao passar de ${limiarEfetivo}% de ${fmtCents(tetoParaCopy)}`}
              corpo="Abrimos um aviso na Central de avisos. A IA continua respondendo normalmente."
            />
            <OpcaoDeModo
              valor="bloquear"
              atual={modo}
              onPick={setModo}
              disabled={update.isPending || pularDegrau}
              titulo={`Parar a IA ao chegar em ${fmtCents(tetoParaCopy)}`}
              corpo={
                "As conversas em andamento vão para a fila de atendimento humano — ninguém " +
                "fica sem resposta, mas alguém precisa responder. Cada uma volta ao " +
                'automático pelo botão "Devolver ao automático" no cabeçalho dela.' +
                (status.gasto_incompleto
                  ? " ⚠️ Atenção: o produto ainda não sabe o preço do modelo em uso, então " +
                    "o gasto medido é menor que o real e esta parada pode não disparar."
                  : "")
              }
              {...(pularDegrau
                ? {
                    // A regra do servidor é de ESTADO, não de tempo (`modoAntes !==
                    // 'off'`). O texto anterior dizia "depois de um tempo em Me
                    // avisar" e prometia uma janela que o código não garante: dá
                    // para salvar "Me avisar", reabrir e armar a parada em segundos.
                    // Quem garante tempo é a carência de 72h — e é dela que a frase
                    // fala agora.
                    motivoBloqueado:
                      'Disponível depois de salvar "Me avisar" — e, quando você armar a parada, ' +
                      "ela só começa a valer 72 horas depois.",
                  }
                : {})}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="limit-usd">Limite mensal (US$)</Label>
            <Input
              id="limit-usd"
              type="number"
              min={0}
              step="0.01"
              value={limitUsd}
              onChange={(e) => setLimitUsd(e.target.value)}
              aria-invalid={tetoInsuficiente || !centsValidos}
            />
            {tetoInsuficiente && (
              <p className="text-xs text-destructive">
                Para avisar ou parar no limite, ele precisa ser de pelo menos{" "}
                {fmtCents(PISO_DE_TETO_CENTS)} por mês. Abaixo disso não é orçamento de
                um atendimento — é erro de digitação. Se você só quer acompanhar o gasto
                sem limite, escolha &quot;Só acompanhar&quot;.
              </p>
            )}
          </div>

          {modo !== "off" && (
            <div className="space-y-1.5">
              <Label htmlFor="threshold-pct">Avisar ao chegar em (% do limite)</Label>
              <Input
                id="threshold-pct"
                type="number"
                min={50}
                max={99}
                step={1}
                value={thresholdPct}
                onChange={(e) => setThresholdPct(Number(e.target.value))}
              />
            </div>
          )}

          {armando && (
            <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-xs">
                A parada começa a valer <strong>72 horas</strong> depois de salvar. É o
                tempo de você ver o aviso chegar antes que alguma conversa pare.
              </p>
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={imediato}
                  onChange={(e) => setImediato(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                Começar a valer agora, sem esperar as 72 horas
              </label>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={update.isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={update.isPending || !centsValidos || tetoInsuficiente}>
              {update.isPending ? "Salvando..." : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
