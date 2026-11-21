"use client";
/**
 * EM QUE FUNIS ESTE ASSISTENTE PODE MEXER (spec 17 passo 3).
 *
 * Medido na produção: uma organização com 4 funis e 5 assistentes de negócios
 * diferentes — um SDR, dois de suporte e uma atendente de clínica. Qualquer um
 * alcançava qualquer funil.
 *
 * Três coisas que esta tela faz de propósito:
 *
 *  1. **Nomeia o estado vazio.** Nenhum funil marcado é um estado LEGÍTIMO (é o
 *     default, e é falha fechada), mas quem liga o papel e não marca nada
 *     concluiria que quebrou. A frase diz o que acontece, não o que falta.
 *  2. **Avisa quando o funil de ENTRADA está de fora.** É o caso que produz um
 *     estado novo e silencioso: o sistema cria um card por conversa todo dia num
 *     funil que o assistente é proibido de tocar, enquanto ele conversa
 *     normalmente. "Atendido e não registrado" não existe hoje.
 *  3. **Não usa jargão.** Nada de "escopo" nem de nome de coluna: o dono do
 *     negócio lê "mexer em negócio", que é o que de fato acontece.
 */
import Link from "next/link";
import * as React from "react";

import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import type { FunilDaResposta } from "@/hooks/pipelines/usePipelines";

/** Quanto de cada funil o assistente sabe percorrer (spec 17 passo 4). */
export interface CoberturaPorFunil {
  [pipelineId: string]: { traduzidos: number; total: number; mudo: boolean };
}

/**
 * Um número que este assistente atende (o que ele escolheu e o do roteador em
 * que ele está), com o funil de entrada que o número escolheu (#4921).
 */
export interface NumeroDoAgente {
  id: string;
  nome: string;
  /** `channel_sessions.entry_pipeline_id`. Nulo = o funil padrão da organização. */
  funilDeEntradaId: string | null;
}

interface Props {
  funis: FunilDaResposta[];
  /**
   * Opcional: quando ausente (ou vazio), o funil de entrada é o padrão da
   * organização, como antes do #4921.
   */
  numeros?: NumeroDoAgente[];
  /**
   * Opcional: quando ausente, a tela não fala de tradução nenhuma. É melhor
   * calar do que exibir "0 de 5" para todo funil só porque o dado não chegou.
   */
  cobertura?: CoberturaPorFunil;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

export function FunisDoAgente({ funis, value, onChange, cobertura, numeros, disabled = false }: Props) {
  const t = useT();
  const marcados = new Set(value);

  function alternar(id: string, marcado: boolean): void {
    const proximo = new Set(marcados);
    if (marcado) proximo.add(id);
    else proximo.delete(id);
    onChange([...proximo]);
  }

  // O aviso mais importante desta tela, e o menos óbvio: o funil de entrada é
  // onde o sistema cria um card por conversa nova (spec 17 passo 1). Se ele
  // ficar de fora, o assistente conversa e os cards se acumulam sem que ele
  // possa tocá-los.
  //
  // Desde o #4921 cada número escolhe o seu funil de entrada. A régua é a de
  // `lib/leads/nascimento-do-lead.ts`: vale o funil que o número escolheu se ele
  // ainda existe (a lista só traz funis não arquivados); senão, o padrão.
  const entradas = funisDeEntrada(funis, numeros);
  const entradasDeFora = value.length > 0 ? entradas.filter((e) => !marcados.has(e.funil.id)) : [];
  const ehEntrada = new Set(entradas.map((e) => e.funil.id));

  // Funis que o assistente cuida e não sabe percorrer: promessa que não se
  // cumpre. O dono marcou achando que ele ia organizar, e ele não vai.
  const mudosMarcados = funis
    .filter((f) => marcados.has(f.id) && cobertura?.[f.id]?.mudo)
    .map((f) => f.name);

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("Em que negócios ele pode mexer")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Marque os funis que este assistente cuida. Ele conversa com qualquer cliente, mas só move, edita ou encerra negócio dos funis marcados aqui.",
          )}
        </p>
      </div>

      {funis.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("Você ainda não tem nenhum funil. Crie um em Funis para poder liberar o assistente.")}
        </p>
      ) : (
        <div className="space-y-2" data-testid="agente-funis">
          {funis.map((f) => (
            <div key={f.id} className="flex items-center gap-2">
              {/* `input` nativo, como o ToolPicker ao lado: o repo não tem
                  componente de checkbox, e introduzir um só para esta tela
                  criaria duas aparências para o mesmo controle na MESMA página. */}
              <input
                id={`funil-${f.id}`}
                data-testid={`funil-${f.id}`}
                type="checkbox"
                className="h-4 w-4 shrink-0 rounded-md border-border accent-primary"
                checked={marcados.has(f.id)}
                onChange={(e) => alternar(f.id, e.target.checked)}
                disabled={disabled}
                aria-label={f.name}
              />
              <Label htmlFor={`funil-${f.id}`} className="text-sm font-normal">
                {f.name}
                {ehEntrada.has(f.id) ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t("(é para cá que vão as conversas novas)")}
                  </span>
                ) : null}
                {/* A lacuna de tradução só aparece no funil MARCADO: fora do
                    escopo ela não custa nada, e mostrá-la ali seria cobrar uma
                    configuração que ninguém prometeu. */}
                {marcados.has(f.id) && cobertura?.[f.id]?.mudo ? (
                  <span
                    data-testid={`funil-mudo-${f.id}`}
                    className="ml-2 text-xs text-warning-fg"
                  >
                    {t("— ele não sabe organizar este funil ainda")}
                  </span>
                ) : null}
              </Label>
            </div>
          ))}
        </div>
      )}

      {value.length === 0 ? (
        <p data-testid="agente-sem-funil" className="text-xs text-muted-foreground">
          {t(
            "Sem nenhum funil marcado, ele conversa com os clientes normalmente, mas não mexe em negócio nenhum — nem move, nem encerra, nem marca.",
          )}
        </p>
      ) : null}

      {mudosMarcados.length > 0 ? (
        <p data-testid="agente-funis-mudos" className="text-xs text-warning-fg">
          {mudosMarcados.length === 1
            ? `${t("Você marcou")} ${mudosMarcados[0]}${t(", mas ninguém disse ao assistente o que cada etapa desse funil significa — ele vai atender e deixar os negócios parados onde estão.")}`
            : `${t("Você marcou")} ${mudosMarcados.length} ${t("funis em que ninguém disse ao assistente o que cada etapa significa — ele vai atender e deixar os negócios parados onde estão.")}`}{" "}
          {/* O caminho é o do menu (`lib/navigation/catalogo.ts`): a tela das
              etapas mora no CRM desde a reorganização da navegação, e o texto
              antigo ("Configurações › Funis") mandava para um lugar que não existe. */}
          {t("Isso se configura em")}{" "}
          <Link
            href="/app/settings/tenant/pipelines"
            className="underline underline-offset-2"
            data-testid="agente-funis-mudos-caminho"
          >
            {`CRM › ${t("Ver tudo em CRM")} › ${t("Etapas do funil")}`}
          </Link>
          .
        </p>
      ) : null}

      {entradasDeFora.length > 0 ? (
        <div data-testid="agente-entrada-de-fora" className="space-y-1">
          {entradasDeFora.map(({ funil, numerosQueEscolheram }) => (
            <p key={funil.id} className="text-xs text-warning-fg">
              {numerosQueEscolheram.length > 0 ? (
                <>
                  {t("As conversas novas do número")} <strong>{numerosQueEscolheram.join(", ")}</strong>{" "}
                  {t("viram negócio em")} <strong>{funil.name}</strong>
                </>
              ) : (
                <>
                  {t("As conversas novas viram negócio em")} <strong>{funil.name}</strong>
                </>
              )}
              {t(", que não está marcado. O assistente vai atender e os negócios vão se acumular ali sem que ele possa organizá-los.")}
            </p>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Os funis onde nascem os cards das conversas novas deste assistente.
 *
 * Sem números conhecidos, é o padrão da organização (o comportamento de antes do
 * #4921). Com números, é o funil que cada um escolheu, ou o padrão para quem não
 * escolheu ou escolheu um funil que não existe mais. `numerosQueEscolheram` só
 * leva quem escolheu de propósito: é o que a frase do aviso nomeia.
 */
function funisDeEntrada(
  funis: FunilDaResposta[],
  numeros: NumeroDoAgente[] | undefined,
): Array<{ funil: FunilDaResposta; numerosQueEscolheram: string[] }> {
  const padrao = funis.find((f) => f.is_default);
  if (!numeros || numeros.length === 0) return padrao ? [{ funil: padrao, numerosQueEscolheram: [] }] : [];
  const porFunil = new Map<string, { funil: FunilDaResposta; numerosQueEscolheram: string[] }>();
  for (const numero of numeros) {
    const escolhido = numero.funilDeEntradaId ? funis.find((f) => f.id === numero.funilDeEntradaId) : undefined;
    const funil = escolhido ?? padrao;
    if (!funil) continue;
    const item = porFunil.get(funil.id) ?? { funil, numerosQueEscolheram: [] };
    if (escolhido && !item.numerosQueEscolheram.includes(numero.nome)) item.numerosQueEscolheram.push(numero.nome);
    porFunil.set(funil.id, item);
  }
  return [...porFunil.values()];
}
