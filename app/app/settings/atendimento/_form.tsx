"use client";
/**
 * O formulário da tela de distribuição de atendimento (issue #144).
 *
 * A cópia é a parte que importa aqui, não o layout: quem instala este produto
 * numa VPS não sabe o que é "round robin" nem "visibility mode". Cada opção diz
 * o que ACONTECE com o cliente e com o atendente, e cada modo tem a sua
 * consequência escrita — inclusive a ruim.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import type { VisibilityMode } from "@/lib/auth/types";
import { PRAZO_MAX_MINUTOS, PRAZO_MIN_MINUTOS } from "@/lib/escalacao/devolucao-automatica";
import { ROUTING_MODES, VISIBILITY_MODES, type RoutingMode } from "@/lib/schemas/routing";
import { useT } from "@/hooks/i18n/useT";

export interface AtendimentoConfig {
  mode: RoutingMode;
  max_retries: number;
  backoff_seconds: number;
  visibility_mode: VisibilityMode;
  /** `null` = nunca devolve sozinho (o padrão do produto). */
  handoff_return_after_minutes: number | null;
  /** "A conversa fica com quem atendeu" — desligado é o padrão do produto. */
  conversation_stays_with_attendant: boolean;
}

const MODO_COPY: Record<RoutingMode, { titulo: string; corpo: string }> = {
  manual: {
    titulo: "Cada um pega o que quiser",
    corpo:
      "Todo cliente novo cai numa fila aberta e o primeiro atendente que clicar assume. " +
      "Simples, e é onde nasce a discussão de quem furou a fila.",
  },
  round_robin: {
    titulo: "Rodízio automático entre os atendentes",
    corpo:
      "Cliente 1 vai para o atendente A, cliente 2 para o B, e ao acabar a lista volta ao " +
      "primeiro. Quem recebe é sempre quem está há mais tempo sem receber — entre os que " +
      "estão disponíveis e dentro do horário. Ninguém escolhe, então não há fila furada.",
  },
};

const VISIBILIDADE_COPY: Record<VisibilityMode, { titulo: string; corpo: string }> = {
  all: {
    titulo: "Todos veem tudo",
    corpo: "Qualquer atendente abre a conversa e o negócio de qualquer colega.",
  },
  own_and_unassigned: {
    titulo: "Os seus, mais os que ainda não têm dono",
    corpo:
      "O atendente vê a própria carteira e a fila de quem chegou agora. Não vê o que já é " +
      "de um colega.",
  },
  own: {
    titulo: "Só os seus",
    corpo:
      "O atendente vê apenas o que foi direcionado a ele — nem a fila. Combine com o " +
      "rodízio: sem alguém distribuindo, ninguém recebe nada e as telas ficam vazias.",
  },
};

function Escolha({
  nome,
  valor,
  atual,
  titulo,
  corpo,
  onPick,
  disabled,
}: {
  nome: string;
  valor: string;
  atual: string;
  titulo: string;
  corpo: string;
  onPick: (v: string) => void;
  disabled: boolean;
}) {
  const marcado = atual === valor;
  return (
    <label
      data-testid={`opcao-${nome}-${valor}`}
      data-marcada={marcado ? "sim" : "nao"}
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
        marcado ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
      }`}
    >
      <input
        type="radio"
        name={nome}
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
      </span>
    </label>
  );
}

export function AtendimentoForm({ initial }: { initial: AtendimentoConfig }) {
  const t = useT();
  const [form, setForm] = useState<AtendimentoConfig>(initial);
  const [salvo, setSalvo] = useState<AtendimentoConfig>(initial);
  const [isPending, startTransition] = useTransition();

  const sujo = JSON.stringify(form) !== JSON.stringify(salvo);

  /**
   * O aviso que evita o pior par de escolhas. Não é decoração: "só os seus" com
   * distribuição manual significa que ninguém enxerga a fila para pegar, então
   * nada é atendido — e a tela de todo mundo fica vazia sem explicação.
   */
  const combinacaoMorta = form.visibility_mode === "own" && form.mode === "manual";

  const devolveSozinho = form.handoff_return_after_minutes !== null;

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/routing", form);
        setSalvo(form);
        toast.success(t("Distribuição de atendimento salva."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-6" data-testid="form-atendimento">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Quem recebe o cliente novo")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("Vale para conversa que chega sem dono.")}
          </p>
        </div>
        <div className="space-y-2">
          {ROUTING_MODES.map((m) => (
            <Escolha
              key={m}
              nome="modo"
              valor={m}
              atual={form.mode}
              titulo={t(MODO_COPY[m].titulo)}
              corpo={t(MODO_COPY[m].corpo)}
              disabled={isPending}
              onPick={(v) => setForm((f) => ({ ...f, mode: v as RoutingMode }))}
            />
          ))}
        </div>

        {form.mode === "round_robin" ? (
          <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="max_retries">{t("Tentativas antes de desistir")}</Label>
              <Input
                id="max_retries"
                type="number"
                min={0}
                max={20}
                value={form.max_retries}
                disabled={isPending}
                onChange={(e) =>
                  setForm((f) => ({ ...f, max_retries: Number(e.target.value) }))
                }
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  "Quando não há ninguém disponível, o sistema tenta de novo mais tarde. Ao estourar, a conversa fica na fila esperando alguém.",
                )}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="backoff_seconds">
                {t("Espera entre tentativas (segundos)")}
              </Label>
              <Input
                id="backoff_seconds"
                type="number"
                min={1}
                max={3600}
                value={form.backoff_seconds}
                disabled={isPending}
                onChange={(e) =>
                  setForm((f) => ({ ...f, backoff_seconds: Number(e.target.value) }))
                }
              />
            </div>
          </div>
        ) : null}
      </Card>

      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("O que cada atendente enxerga")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("Restringe apenas quem tem o papel")} <strong>{t("Atendente")}</strong>.{" "}
            {t("Gerente e administrador continuam vendo a operação inteira.")}
          </p>
        </div>
        <div className="space-y-2">
          {VISIBILITY_MODES.map((v) => (
            <Escolha
              key={v}
              nome="visibilidade"
              valor={v}
              atual={form.visibility_mode}
              titulo={t(VISIBILIDADE_COPY[v].titulo)}
              corpo={t(VISIBILIDADE_COPY[v].corpo)}
              disabled={isPending}
              onPick={(x) => setForm((f) => ({ ...f, visibility_mode: x as VisibilityMode }))}
            />
          ))}
        </div>

        {combinacaoMorta ? (
          <p
            data-testid="aviso-combinacao-morta"
            className="rounded-md border border-amber-500/40 bg-amber-50/60 p-3 text-xs dark:bg-amber-900/10"
          >
            {t("Com")} <strong>&ldquo;{t("só os seus")}&rdquo;</strong>{" "}
            {t(
              "e distribuição manual, ninguém enxerga a fila para pegar — e nenhum cliente é atendido. Ligue o rodízio para que alguém receba.",
            )}
          </p>
        ) : null}
      </Card>

      <Card className="space-y-4 p-4" data-testid="devolucao-ao-agente">
        <div>
          <h2 className="text-sm font-semibold">{t("Quando a pessoa some, a IA volta?")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Quando alguém assume uma conversa, o agente de IA para de responder nela até ser devolvido. Se ninguém devolve, o cliente que escreve de novo fica sem resposta.",
            )}
          </p>
        </div>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            data-testid="devolver-sozinho"
            checked={devolveSozinho}
            disabled={isPending}
            onChange={(e) =>
              setForm((f) => ({ ...f, handoff_return_after_minutes: e.target.checked ? 60 : null }))
            }
            className="mt-1 h-4 w-4 shrink-0 accent-primary"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium">
              {t("Devolver ao agente sozinho depois de um tempo sem resposta da equipe")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t(
                "O tempo conta a partir do último sinal de uma pessoa na conversa: assumir, responder pela tela ou pelo celular. Só devolve onde há agente publicado. Desligado, vale a regra de sempre: a IA só volta quando alguém clica em Devolver.",
              )}
            </span>
          </span>
        </label>
        {devolveSozinho ? (
          <div className="max-w-xs space-y-1 border-t pt-4">
            <Label htmlFor="handoff_return_after_minutes">{t("Minutos sem resposta da equipe")}</Label>
            <Input
              id="handoff_return_after_minutes"
              type="number"
              min={PRAZO_MIN_MINUTOS}
              max={PRAZO_MAX_MINUTOS}
              value={form.handoff_return_after_minutes ?? 60}
              disabled={isPending}
              onChange={(e) =>
                setForm((f) => ({ ...f, handoff_return_after_minutes: Number(e.target.value) }))
              }
            />
            <p className="text-xs text-muted-foreground">
              {t("Entre 5 minutos e 24 horas. Sessenta minutos é a ordem de grandeza de um atendimento humano.")}
            </p>
          </div>
        ) : null}
      </Card>

      <Card className="space-y-4 p-4" data-testid="conversa-fica-com-quem-atendeu">
        <div>
          <h2 className="text-sm font-semibold">
            {t("Quando alguém responde, a conversa fica com essa pessoa?")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Desligado, vale a regra de sempre: responder pela tela cala a IA por alguns minutos, e a conversa encerrada que recebe mensagem nova volta para a fila.",
            )}
          </p>
        </div>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            data-testid="fica-com-quem-atendeu"
            checked={form.conversation_stays_with_attendant}
            disabled={isPending}
            onChange={(e) =>
              setForm((f) => ({ ...f, conversation_stays_with_attendant: e.target.checked }))
            }
            className="mt-1 h-4 w-4 shrink-0 accent-primary"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium">{t("A conversa fica com quem atendeu")}</span>
            <span className="block text-xs text-muted-foreground">
              {t(
                "Responder pelo Inbox numa conversa sem dono passa a assumi-la, e a IA fica calada até alguém devolver. Quando o cliente escreve numa conversa encerrada, ela volta direto para o último atendente, sem passar pela distribuição, se ele ainda faz parte da equipe.",
              )}
            </span>
          </span>
        </label>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending || !sujo}>
          {isPending ? t("Salvando…") : t("Salvar")}
        </Button>
        {sujo ? (
          <span className="text-xs text-muted-foreground">
            {t("Há mudanças não salvas.")}
          </span>
        ) : null}
      </div>
    </form>
  );
}
