"use client";
/**
 * O painel do papel SEGURANÇA (spec 16 §3.3 e §6) — o terceiro papel, que existia
 * no motor e não existia na tela.
 *
 * ═══ O DEFEITO QUE ISTO FECHA ═══
 *
 * A cadeia de dez conferências roda desde sempre e é boa: veto instrutivo, trace
 * por linha, custo zero nas determinísticas. Mas o dono do negócio **não sabia
 * que ela existia**. A própria spec 16 §3.3 escreveu que o que faltava ao
 * terceiro papel era *superfície* — e o épico foi entregue com dois papéis na
 * tela e o terceiro como um `<details>` que só aparece depois de rodar um teste.
 *
 * Mecanismo invisível que funciona é pior do que não existir: quando barra, a
 * pessoa não sabe o que barrou; quando falha, falha sem culpado. É o anti-exemplo
 * literal do invariante 6 da doutrina.
 *
 * ═══ POR QUE NÃO HÁ NENHUM INTERRUPTOR AQUI ═══
 *
 * Nove das dez não se desligam, e isso é decisão de produto, não rigidez: um
 * botão que queima o número do cliente, ou que escreve para quem pediu para
 * parar, não é preferência — é sabotagem do negócio dele, e **oferecer** o
 * controle já ensina que é opcional. Onde não há escolha, a tela diz por quê em
 * uma linha; onde há (as duas que custam uma consulta ao modelo), ela diz o custo
 * e de onde a decisão vem hoje.
 *
 * As duas configuráveis TÊM interruptor, e ele só existe porque o motor passou a
 * ler a escolha por organização (`org_guardrail_layers`, migration 0142) nos três
 * pontos onde as camadas são consumidas. A ordem importou: enquanto o motor lia
 * só o `.env`, um interruptor aqui seria a tela gravando o que o código ignora —
 * o defeito de "controle decorativo", que é pior que controle ausente.
 *
 * E há TRÊS estados, não dois. Sem escolha da organização vale o padrão do
 * servidor, e a tela diz isso em vez de mostrar um interruptor desligado para
 * quem tem a camada ligada por fora.
 */
import * as React from "react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

import {
  useGuardrailLayers,
  useSetGuardrailLayer,
  type CamadaDeSeguranca,
} from "@/hooks/ai/useGuardrailLayers";

import {
  CONFERENCIAS_DE_SAIDA,
  CONFERENCIA_DE_ENTRADA,
  type ConferenciaDeSaida,
} from "@/lib/ai/guardrails/lista-de-conferencia";

function Conferencia({
  c,
  ordem,
  estado,
  podeEditar,
  salvando,
  onToggle,
}: {
  c: ConferenciaDeSaida;
  ordem: number | null;
  estado: CamadaDeSeguranca | undefined;
  podeEditar: boolean;
  salvando: boolean;
  onToggle: (layer: string, v: boolean) => void;
}) {
  const t = useT();
  // Prefixo próprio para o ITEM: os controles dentro dele têm testid começando em
  // `conferencia-`, e contar por esse prefixo misturava os dois — a contagem
  // mudava a cada elemento novo. O teste de tela pegou isso quando o interruptor
  // entrou.
  return (
    <li data-testid={`item-conferencia-${c.nome}`} className="flex gap-3 py-3">
      <span
        aria-hidden
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
      >
        {ordem ?? "•"}
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t(c.rotulo)}</p>
        <p className="text-xs text-muted-foreground">{t(c.oQueProtege)}</p>
        {c.escolha === null ? (
          <p data-testid={`conferencia-${c.nome}-fixa`} className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{t("Isto não se desliga.")}</span>{" "}
            {t(c.porQueNaoSeDesliga)}
          </p>
        ) : (
          <div data-testid={`conferencia-${c.nome}-escolha`} className="space-y-1">
            <div className="flex items-center gap-2">
              <Switch
                data-testid={`conferencia-${c.nome}-liga`}
                checked={estado?.efetivo ?? false}
                disabled={!podeEditar || salvando}
                onCheckedChange={(v) => onToggle(c.nome, v)}
                aria-label={t(c.rotulo)}
              />
              <span className="text-xs text-muted-foreground">
                {estado === undefined
                  ? t("carregando…")
                  : estado.escolha === null
                    ? `${estado.efetivo ? t("Ligada") : t("Desligada")} ${t("— vem da configuração do servidor")}`
                    : estado.escolha
                      ? t("Ligada por você")
                      : t("Desligada por você")}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Custa")} {t(c.escolha.custo)}
              {t(". O modelo usado se escolhe em")}{" "}
              <a className="underline underline-offset-2" href="/app/ai/providers">
                {t("Provedores de IA")}
              </a>
              .
            </p>
          </div>
        )}
      </div>
    </li>
  );
}

export function PainelDeSeguranca() {
  const t = useT();
  const camadas = useGuardrailLayers();
  const gravar = useSetGuardrailLayer();

  const porNome = new Map((camadas.data?.camadas ?? []).map((c) => [c.layer as string, c]));
  const podeEditar = camadas.data?.podeEditar ?? false;
  const props = (camada: string | null) => ({
    estado: camada === null ? undefined : porNome.get(camada),
    podeEditar,
    salvando: gravar.isPending,
    onToggle: (layer: string, v: boolean) =>
      gravar.mutate({ layer: layer as CamadaDeSeguranca["layer"], enabled: v }),
  });

  return (
    <div className="space-y-4" data-testid="painel-de-seguranca">
      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-medium">{t("Antes de cada mensagem sair")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("O assistente escreve, e o sistema confere. São")} {CONFERENCIAS_DE_SAIDA.length}{" "}
          {t(
            "verificações, nesta ordem — a primeira que barra interrompe as seguintes, e o assistente recebe de volta o motivo para reescrever.",
          )}
        </p>
        <ul className="divide-y">
          {CONFERENCIAS_DE_SAIDA.map((c, i) => (
            <Conferencia key={c.nome} c={c} ordem={i + 1} {...props(c.camada)} />
          ))}
        </ul>
      </Card>

      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-medium">{t("Antes de o assistente ler")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("Esta roda sobre a mensagem que chega, antes das outras — por isso aparece separada.")}
        </p>
        <ul className="divide-y">
          <Conferencia c={CONFERENCIA_DE_ENTRADA} ordem={null} {...props(CONFERENCIA_DE_ENTRADA.camada)} />
        </ul>
      </Card>
    </div>
  );
}
