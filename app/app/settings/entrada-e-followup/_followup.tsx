"use client";

/**
 * SEÇÃO 2 — "FOLLOW-UP POR ETAPA" (#3603, fatia 3).
 *
 * Uma linha por etapa ABERTA do funil, com as três decisões que a issue pede:
 * se aquela etapa tem acompanhamento, em quantas horas ele começa e com que
 * texto. O que é gravado é `settings.followup_por_etapa` (contrato em
 * `lib/schemas/settings.ts`), pela action `definirFollowupPorEtapa`.
 *
 * ─── Por que a lista vem do FUNIL e não da configuração ────────────────────
 *
 * A tela mostra TODAS as etapas abertas, marcadas ou não. Listar só as que já
 * têm regra esconderia justamente a etapa em que ninguém pensou — e "esta etapa
 * não tem acompanhamento" é a informação que a operação precisa ver. Etapa de
 * funil arquivado, ou fechada como ganho/perdido, não aparece: a action recusaria
 * gravar nela, e um formulário que só falha no salvar é pior que sua ausência.
 *
 * ─── O que a tela NÃO promete ──────────────────────────────────────────────
 *
 * O ENVIO não nasce aqui. Quem manda mensagem por etapa é o fluxo de follow-up
 * que a etapa arma (`trigger_config.kind='stage_change'`, endereçado no
 * construtor de fluxos) — é lá que o texto é revisado por uma pessoa antes de
 * sair, e é a mesma regra da fatia 2. Esta seção registra a régua da operação:
 * desligar aqui não apaga prazo nem texto, e religar não obriga a escrever tudo
 * de novo.
 *
 * ⚠️ O SALVAR É UM SÓ PARA A SEÇÃO. Gravar por linha faria uma escrita de jsonb
 * por etapa, e a segunda poderia falhar deixando a tela pela metade sem ninguém
 * ver. Uma gravação, um resultado, uma frase.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirFollowupPorEtapa } from "@/app/actions/settings/definirFollowupPorEtapa";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import {
  MENSAGEM_DE_FOLLOWUP_MAX,
  PRAZO_DE_FOLLOWUP_HORAS_MAX,
  PRAZO_DE_FOLLOWUP_HORAS_MIN,
  type FollowupPorEtapa,
} from "@/lib/schemas/settings";

import type { FunilDaTela } from "./_tipos";

/** O rascunho de UMA etapa: o prazo fica em texto porque o campo pode estar vazio. */
interface Rascunho {
  ativa: boolean;
  prazo: string;
  mensagem: string;
}

/**
 * As frases de recusa, indexadas pelo código da action — e as duas que nascem na
 * própria tela (`formato_incompleto`, `prazo_maximo`) entram na MESMA tabela.
 *
 * Tabela de MÓDULO e não `setErro("frase")`: a guarda de i18n recusa
 * `t(<variável>)`, e uma frase que não passa pelo dicionário sai em português
 * para quem escolhe espanhol.
 */
const ERRO = {
  validation_failed: "Toda etapa ligada precisa de prazo e de modelo de mensagem.",
  formato_incompleto: "Toda etapa ligada precisa de prazo e de modelo de mensagem.",
  prazo_maximo: "O prazo máximo de um follow-up é de 720 horas (30 dias).",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um gerente ou administrador pode mudar esta opção.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  etapa_invalida: "Uma das etapas mudou enquanto a tela estava aberta. Recarregue.",
  erro_ao_gravar: "Não consegui salvar agora. Tente de novo.",
} as const;

type ChaveDeErro = keyof typeof ERRO;

function rascunhoInicial(inicial: FollowupPorEtapa, stageId: string): Rascunho {
  const regra = inicial[stageId];
  return {
    ativa: regra?.ativa === true,
    prazo: regra?.prazo_horas == null ? "" : String(regra.prazo_horas),
    mensagem: regra?.mensagem ?? "",
  };
}

export function FollowupPorEtapaForm({
  inicial,
  funis,
  idioma,
}: {
  inicial: FollowupPorEtapa;
  funis: FunilDaTela[];
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  // Um rascunho por etapa, semeado com o que está gravado: é esse mapa que o
  // "marcada" da tela lê, e é ele que o teste recarrega.
  const [rascunhos, setRascunhos] = useState<Record<string, Rascunho>>(() => {
    const mapa: Record<string, Rascunho> = {};
    for (const funil of funis) {
      for (const etapa of funil.etapas) mapa[etapa.id] = rascunhoInicial(inicial, etapa.id);
    }
    return mapa;
  });
  const [erro, setErro] = useState<ChaveDeErro | null>(null);
  const [isPending, startTransition] = useTransition();

  const etapasDaTela = funis.flatMap((funil) =>
    funil.etapas.map((etapa) => ({ ...etapa, funilId: funil.id, funilNome: funil.name })),
  );

  function mudar(stageId: string, patch: Partial<Rascunho>) {
    setErro(null);
    setRascunhos((atual) => ({
      ...atual,
      [stageId]: { ...(atual[stageId] ?? { ativa: false, prazo: "", mensagem: "" }), ...patch },
    }));
  }

  function salvar() {
    setErro(null);
    // A conferência local repete a da action de propósito: a pessoa vê o que falta
    // sem uma ida ao servidor, e a action continua sendo quem decide.
    for (const etapa of etapasDaTela) {
      const rascunho = rascunhos[etapa.id];
      if (!rascunho?.ativa) continue;
      const prazo = Number(rascunho.prazo);
      if (!rascunho.prazo || !Number.isInteger(prazo) || prazo < PRAZO_DE_FOLLOWUP_HORAS_MIN) {
        setErro("formato_incompleto");
        return;
      }
      if (prazo > PRAZO_DE_FOLLOWUP_HORAS_MAX) {
        setErro("prazo_maximo");
        return;
      }
      if (!rascunho.mensagem.trim()) {
        setErro("formato_incompleto");
        return;
      }
    }

    startTransition(async () => {
      const resultado = await definirFollowupPorEtapa({
        etapas: etapasDaTela.map((etapa) => {
          const rascunho = rascunhos[etapa.id] ?? { ativa: false, prazo: "", mensagem: "" };
          const prazo = Number(rascunho.prazo);
          return {
            stage_id: etapa.id,
            ativa: rascunho.ativa,
            prazo_horas: rascunho.prazo && Number.isInteger(prazo) ? prazo : null,
            mensagem: rascunho.mensagem.trim() || null,
          };
        }),
      });
      if (resultado.ok) {
        toast.success(t("Follow-up por etapa salvo."));
        router.refresh();
        return;
      }
      if (resultado.error === "mfa_required") {
        irAoDesafioDeMfa();
        return;
      }
      setErro(resultado.error);
    });
  }

  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-sm font-medium">{t("Follow-up por etapa")}</h2>
        <p className="max-w-2xl text-xs text-muted-foreground">
          {t(
            "Para cada etapa: se ela tem acompanhamento, em quantas horas ele começa e qual modelo de mensagem a equipe usa. Desligar uma etapa não apaga o prazo nem o texto — religar depois não obriga a escrever tudo de novo.",
          )}
        </p>
      </div>

      {etapasDaTela.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="followup-sem-etapas">
          {t("Nenhum funil aberto com etapa para acompanhar. Crie um funil primeiro.")}
        </p>
      )}

      {funis.map((funil) =>
        funil.etapas.length === 0 ? null : (
          <div key={funil.id} className="space-y-3" data-testid={`funil-${funil.id}`}>
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {funil.name}
            </h3>
            {funil.etapas.map((etapa) => {
              const rascunho =
                rascunhos[etapa.id] ?? ({ ativa: false, prazo: "", mensagem: "" } as Rascunho);
              return (
                <div
                  key={etapa.id}
                  className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_8rem]"
                  data-testid={`etapa-${etapa.id}`}
                >
                  <div className="flex items-start gap-3">
                    <Switch
                      id={`followup-${etapa.id}`}
                      data-testid={`followup-ativa-${etapa.id}`}
                      checked={rascunho.ativa}
                      disabled={isPending}
                      onCheckedChange={(novo) => mudar(etapa.id, { ativa: novo })}
                    />
                    <div className="flex flex-col gap-2">
                      <Label htmlFor={`followup-${etapa.id}`}>
                        {etapa.name}
                        <span className="block text-xs font-normal text-muted-foreground">
                          {rascunho.ativa
                            ? t("Marcada para follow-up")
                            : t("Sem follow-up automático")}
                        </span>
                      </Label>
                      <textarea
                        aria-label={t("Modelo de mensagem da etapa {etapa}").replace(
                          "{etapa}",
                          etapa.name,
                        )}
                        data-testid={`followup-mensagem-${etapa.id}`}
                        className="min-h-16 w-full rounded-md border bg-background p-2 text-sm"
                        maxLength={MENSAGEM_DE_FOLLOWUP_MAX}
                        placeholder={t("O que a equipe escreve se o cliente não responder")}
                        value={rascunho.mensagem}
                        disabled={isPending}
                        onChange={(evento) => mudar(etapa.id, { mensagem: evento.target.value })}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`prazo-${etapa.id}`}>{t("Prazo (horas)")}</Label>
                    <input
                      id={`prazo-${etapa.id}`}
                      data-testid={`followup-prazo-${etapa.id}`}
                      className="w-full rounded-md border bg-background p-2 text-sm"
                      type="number"
                      min={PRAZO_DE_FOLLOWUP_HORAS_MIN}
                      max={PRAZO_DE_FOLLOWUP_HORAS_MAX}
                      value={rascunho.prazo}
                      disabled={isPending}
                      onChange={(evento) => mudar(etapa.id, { prazo: evento.target.value })}
                    />
                  </div>
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
          disabled={isPending || etapasDaTela.length === 0}
          onClick={salvar}
        >
          {t("Salvar follow-up por etapa")}
        </Button>
        <p role="status" className="text-xs text-destructive" data-testid="followup-erro">
          {erro ? t(ERRO[erro]) : ""}
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        {t(
          "O envio continua sendo do fluxo de follow-up de cada etapa, no construtor de fluxos: é lá que o texto é revisado por uma pessoa antes de sair. Esta tela guarda a régua da operação — o que cada etapa espera.",
        )}
      </p>
    </Card>
  );
}
