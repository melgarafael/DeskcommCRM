"use client";

/**
 * "FOLLOW-UP POR ETAPA" (#3603) — a tabela que edita OS PRÓPRIOS FLUXOS.
 *
 * ─── O que esta tela NÃO faz ───────────────────────────────────────────────
 *
 * Ela não guarda prazo. O prazo de um follow-up por etapa é
 * `automation_rules.trigger_config.dias` da regra `lead.stage_stale` — e esta
 * tela grava ali, pelo `PATCH /api/v1/automation-rules/[id]` que o construtor de
 * fluxos já usa. Um lugar só guarda o prazo; o que a tela mostra é o que a
 * varredura faz.
 *
 * ─── Por que UMA linha por fluxo, e nunca uma por etapa ────────────────────
 *
 * Uma etapa pode ser alcançada por vários fluxos ao mesmo tempo: dois fluxos de
 * 2 e 7 dias na mesma etapa emitem os dois lembretes, e um fluxo "qualquer
 * etapa" alcança todas as colunas do funil. Mostrar "o prazo da etapa" seria
 * inventar um valor que ninguém configurou e esconder o segundo fluxo atrás
 * dele — exatamente o mal-entendido que derrubou a primeira versão. A tabela
 * mostra TODOS, cada um com o seu prazo, e editar um não mexe no outro.
 *
 * ─── O texto da mensagem não mora aqui ─────────────────────────────────────
 *
 * Onde o fluxo manda mensagem (`send_whatsapp_message`/`send_ai_message`), a
 * linha linka o construtor do fluxo. Um campo de texto nesta tela seria um
 * segundo dono do mesmo conteúdo — a mensagem sairia sem ninguém revisar no
 * construtor, que é onde ela é enviada.
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { GATILHO_ETAPA_PARADA } from "@/lib/automation/gatilhos-de-tempo";
import {
  DIAS_DA_ETAPA_MAX,
  DIAS_DA_ETAPA_MIN,
  configComNovoPrazo,
  fluxosQueAlcancam,
  pedidosDePrazo,
  type FluxoDeEtapaParada,
} from "@/lib/automation/prazos-da-etapa-parada";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import type { FunilDaTela } from "./_tipos";

/**
 * As frases de recusa, indexadas pelo código que a rota devolve — tabela de
 * MÓDULO para a guarda de i18n ver cada valor: uma frase montada em runtime
 * escaparia do dicionário e sairia em português para quem escolhe espanhol.
 */
const ERRO = {
  prazo_invalido: "Cada prazo precisa ser um número inteiro de dias, de 1 a 3650.",
  invalid_request: "A regra recusou o valor. Confira o prazo e tente de novo.",
  forbidden_role: "Só um gerente ou administrador pode mudar o prazo de um fluxo.",
  not_found: "Um dos fluxos foi apagado enquanto a tela estava aberta. Recarregue.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  no_active_org: "Você não está em nenhuma organização ativa.",
  erro_ao_gravar: "Não consegui salvar agora. Tente de novo.",
} as const;

type ChaveDeErro = keyof typeof ERRO;

/** O escopo do fluxo, na frase que a linha mostra. Literais, para o dicionário ver. */
function escopoDoFluxo(fluxo: FluxoDeEtapaParada, t: (texto: string) => string): string {
  if (fluxo.stageId) return t("Só nesta etapa");
  if (fluxo.pipelineId) return t("Qualquer etapa do funil");
  return t("Qualquer etapa de qualquer funil");
}

export function FollowupPorEtapaForm({
  fluxos,
  funis,
  idioma,
}: {
  fluxos: FluxoDeEtapaParada[];
  funis: FunilDaTela[];
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  // Um rascunho por FLUXO (id da regra), semeado com o prazo gravado. O mapa é
  // indexado pela mesma chave que o PATCH usa: não existe rascunho sem fluxo.
  const [rascunhos, setRascunhos] = useState<Record<string, string>>(() => {
    const mapa: Record<string, string> = {};
    for (const fluxo of fluxos) mapa[fluxo.id] = String(fluxo.dias);
    return mapa;
  });
  const [erro, setErro] = useState<ChaveDeErro | null>(null);
  const [isPending, startTransition] = useTransition();

  const etapasDaTela = funis.flatMap((funil) =>
    funil.etapas.map((etapa) => ({ ...etapa, funil })),
  );

  function mudar(regraId: string, valor: string) {
    setErro(null);
    setRascunhos((atual) => ({ ...atual, [regraId]: valor }));
  }

  function salvar() {
    setErro(null);
    const pedidos = pedidosDePrazo(rascunhos, fluxos);

    // A conferência local repete a da rota de propósito: a pessoa vê o que está
    // errado sem uma ida ao servidor — e a rota continua sendo quem decide.
    for (const fluxo of fluxos) {
      const valor = rascunhos[fluxo.id];
      if (valor === undefined) continue;
      const dias = Number(valor.trim());
      if (!valor.trim() || !Number.isInteger(dias) || dias < DIAS_DA_ETAPA_MIN || dias > DIAS_DA_ETAPA_MAX) {
        setErro("prazo_invalido");
        return;
      }
    }

    if (pedidos.length === 0) {
      toast.success(t("Nenhum prazo mudou."));
      return;
    }

    startTransition(async () => {
      const porId = new Map(fluxos.map((fluxo) => [fluxo.id, fluxo]));
      let codigo: ChaveDeErro | null = null;
      for (const pedido of pedidos) {
        const fluxo = porId.get(pedido.regraId);
        // Defesa em profundidade: sem fluxo lido do banco não há gravação. O
        // caminho normal nem chega aqui — `pedidosDePrazo` só percorre `fluxos`.
        if (!fluxo) {
          codigo = "not_found";
          continue;
        }
        try {
          await apiClient.patch(`/api/v1/automation-rules/${fluxo.id}`, {
            // O gatilho vai junto porque a rota recusa `trigger_config` de
            // gatilho por tempo sem saber QUAL gatilho é (o mesmo veto que a
            // criação aplica). É o valor que já está gravado — não troca nada.
            trigger_event: GATILHO_ETAPA_PARADA,
            trigger_config: configComNovoPrazo(fluxo.config, pedido.dias),
          });
        } catch (falha) {
          if (!codigo) {
            const daRota = falha instanceof ApiError ? (falha.code as ChaveDeErro) : null;
            codigo = daRota && daRota in ERRO ? daRota : "erro_ao_gravar";
          }
        }
      }
      if (codigo) {
        setErro(codigo);
        return;
      }
      toast.success(t("Prazo dos fluxos salvo."));
      router.refresh();
    });
  }

  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-sm font-medium">{t("O prazo de cada fluxo, etapa por etapa")}</h2>
        <p className="max-w-2xl text-xs text-muted-foreground">
          {t(
            "Cada linha é um fluxo de \u201cnegócio parado na mesma etapa\u201d que alcança a etapa, com o prazo que ele promete. Editar aqui grava no próprio fluxo: é o mesmo valor que a varredura lê, e não existe um segundo lugar guardando prazo.",
          )}
        </p>
      </div>

      {etapasDaTela.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="followup-sem-etapas">
          {t("Nenhum funil aberto com etapa para acompanhar. Crie um funil primeiro.")}
        </p>
      )}

      {fluxos.length === 0 && etapasDaTela.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="followup-sem-fluxos">
          {t(
            "Nenhum fluxo de etapa parada existe nesta empresa. Crie um no construtor de fluxos para dar prazo a uma etapa.",
          )}
        </p>
      )}

      {funis.map((funil) =>
        funil.etapas.length === 0 ? null : (
          <div key={funil.id} className="space-y-3" data-testid={`funil-${funil.id}`}>
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {funil.name}
            </h3>
            {funil.etapas.map((etapa) => {
              const daEtapa = fluxosQueAlcancam(fluxos, funil.id, etapa.id);
              return (
                <div
                  key={etapa.id}
                  className="space-y-2 rounded-md border p-3"
                  data-testid={`etapa-${etapa.id}`}
                >
                  <Label className="text-sm">{etapa.name}</Label>
                  {daEtapa.length === 0 ? (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid={`etapa-sem-fluxo-${etapa.id}`}
                    >
                      {t("Nenhum fluxo de etapa parada alcança esta etapa.")}
                    </p>
                  ) : (
                    daEtapa.map((fluxo) => (
                      <div
                        key={fluxo.id}
                        className="grid gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-[1fr_7rem]"
                        data-testid={`fluxo-${fluxo.id}`}
                      >
                        <div className="flex flex-col gap-1">
                          <span className="text-sm">{fluxo.nome}</span>
                          <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                            <span>{escopoDoFluxo(fluxo, t)}</span>
                            {fluxo.ativo ? null : <span>{t("Fluxo desligado")}</span>}
                            {fluxo.temMensagem ? (
                              <span>{t("Mensagem definida no fluxo")}</span>
                            ) : null}
                          </span>
                          <Link
                            href={`/app/webhooks/automacoes/${fluxo.id}`}
                            className="text-xs underline underline-offset-2"
                            data-testid={`construtor-${fluxo.id}`}
                          >
                            {t("Abrir no construtor do fluxo")}
                          </Link>
                        </div>
                        <div className="flex flex-col gap-1">
                          <Label htmlFor={`prazo-${etapa.id}-${fluxo.id}`} className="text-xs">
                            {t("Prazo (dias)")}
                          </Label>
                          <input
                            id={`prazo-${etapa.id}-${fluxo.id}`}
                            data-testid={`prazo-fluxo-${fluxo.id}`}
                            className="w-full rounded-md border bg-background p-2 text-sm"
                            type="number"
                            min={DIAS_DA_ETAPA_MIN}
                            max={DIAS_DA_ETAPA_MAX}
                            value={rascunhos[fluxo.id] ?? String(fluxo.dias)}
                            disabled={isPending}
                            onChange={(evento) => mudar(fluxo.id, evento.target.value)}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        ),
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          data-testid="salvar-followup"
          disabled={isPending || fluxos.length === 0}
          onClick={salvar}
        >
          {t("Salvar prazos")}
        </Button>
        <p role="status" className="text-xs text-destructive" data-testid="followup-erro">
          {erro ? t(ERRO[erro]) : ""}
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        {t(
          "Quem envia a mensagem é o fluxo, no construtor: é lá que o texto é revisado por uma pessoa antes de sair. Esta tela só ajusta o prazo — o mesmo que o editor de fluxos mostra.",
        )}
      </p>
    </Card>
  );
}
