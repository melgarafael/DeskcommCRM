"use client";

import { useT } from "@/hooks/i18n/useT";
/**
 * O QUE ESTE ASSISTENTE CONSULTA ANTES DE RESPONDER (0181).
 *
 * Até aqui não existia superfície nenhuma para isto: o acervo pertencia ao
 * agente e a única tela do produto resolvia o agente por `is_default` — como
 * TODO agente criado pela interface nasce `is_default: false`, cadastrar
 * material para qualquer assistente que não fosse o semeado no bootstrap era
 * impossível pela tela, e o indexador ainda o gravava no agente errado.
 *
 * Três coisas que esta seção faz de propósito, no molde de `FunisDoAgente`:
 *
 *  1. **Nomeia o estado vazio.** Nenhum material marcado é LEGÍTIMO (é o
 *     default, e é falha fechada), mas quem publica e não marca nada concluiria
 *     que quebrou. A frase diz o que acontece, não o que falta.
 *  2. **Avisa quando existe acervo e ele está todo de fora.** É o caso que
 *     produz o pior silêncio: a organização pagou para preparar material, o
 *     assistente atende, e responde de improviso sobre um assunto que está
 *     escrito.
 *  3. **Mostra o material que ainda não foi preparado.** Marcar um material que
 *     não virou trecho nenhum é uma promessa que não se cumpre — ele aparece na
 *     lista e o agente não acha nada nele.
 */
import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

export interface MaterialDoAcervo {
  id: string;
  name: string;
  source_type: string;
  chunks_count: number;
  last_index_status: string | null;
}

interface Props {
  materiais: MaterialDoAcervo[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

export function BasesDoAgente({ materiais, value, onChange, disabled = false }: Props) {
  const t = useT();
  const marcados = new Set(value);

  function alternar(id: string, marcado: boolean): void {
    const proximo = new Set(marcados);
    if (marcado) proximo.add(id);
    else proximo.delete(id);
    onChange([...proximo]);
  }

  const semPreparo = materiais.filter(
    (m) => marcados.has(m.id) && (m.chunks_count ?? 0) === 0,
  );
  const acervoTodoDeFora = materiais.length > 0 && value.length === 0;

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("O que ele consulta antes de responder")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Marque o material do seu negócio que este assistente pode ler. Ele procura ali antes de responder, em vez de improvisar — e cita de onde tirou.",
          )}
        </p>
      </div>

      {materiais.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="agente-sem-acervo">
          {t("Você ainda não cadastrou nenhum material.")}{" "}
          <Link
            href="/app/ai/knowledge/sources"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("Comece pelo que ele mais vai precisar")}
          </Link>{" "}
          {t("— as perguntas que se repetem, e a política que você mais explica.")}
        </p>
      ) : (
        <div className="space-y-2" data-testid="agente-bases">
          {materiais.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              {/* `input` nativo, como o ToolPicker e o FunisDoAgente ao lado: o
                  repo não tem componente de checkbox, e introduzir um só para
                  esta seção criaria duas aparências para o mesmo controle na
                  MESMA página. */}
              <input
                id={`base-${m.id}`}
                data-testid={`base-${m.id}`}
                type="checkbox"
                className="h-4 w-4 shrink-0 rounded-md border-border accent-primary"
                checked={marcados.has(m.id)}
                onChange={(e) => alternar(m.id, e.target.checked)}
                disabled={disabled}
                aria-label={m.name}
              />
              <Label htmlFor={`base-${m.id}`} className="text-sm font-normal">
                {m.name}
                {/* Singular e plural viram CHAVES separadas em vez de um sufixo
                    concatenado: em português o plural de "trecho" é +s, em
                    espanhol "fragmento"/"fragmentos" muda a palavra inteira, e
                    um `${…}s` no fim não tem como dizer isso. */}
                <span className="ml-2 text-xs text-muted-foreground">
                  {(m.chunks_count ?? 0) > 0
                    ? `${m.chunks_count} ${m.chunks_count === 1 ? t("trecho") : t("trechos")}`
                    : t("ainda não preparado")}
                </span>
              </Label>
            </div>
          ))}
        </div>
      )}

      {value.length === 0 && materiais.length > 0 ? (
        <p data-testid="agente-sem-base-marcada" className="text-xs text-muted-foreground">
          {t(
            "Sem nenhum material marcado, ele conversa normalmente — mas responde só com o que o modelo já sabe, e a ferramenta de busca nem entra na conversa dele.",
          )}
        </p>
      ) : null}

      {acervoTodoDeFora ? (
        <p data-testid="agente-acervo-de-fora" className="text-xs text-warning-fg">
          {t("Você tem")} {materiais.length}{" "}
          {materiais.length === 1 ? t("material") : t("materiais")}{" "}
          {t(
            "no acervo e este assistente não lê nenhum. Ele vai responder de improviso sobre assuntos que já estão escritos.",
          )}
        </p>
      ) : null}

      {semPreparo.length > 0 ? (
        <p data-testid="agente-base-sem-preparo" className="text-xs text-warning-fg">
          {semPreparo.length === 1
            ? `"${semPreparo[0]?.name}" ${t("está marcado mas ainda não foi preparado — o agente não vai achar nada nele.")}`
            : `${semPreparo.length} ${t("materiais marcados ainda não foram preparados — o agente não vai achar nada neles.")}`}{" "}
          <Link
            href="/app/ai/knowledge/sources"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("Ver o acervo")}
          </Link>
        </p>
      ) : null}
    </Card>
  );
}
