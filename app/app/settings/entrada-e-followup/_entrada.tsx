"use client";

/**
 * SEÇÃO 1 — "ENTRADA AUTOMÁTICA NO FUNIL" (#3603, fatia 3).
 *
 * A tela da chave que a fatia 1 criou. Ela não grava nada por conta própria: o
 * salvar chama `definirEntradaAutomaticaNoFunil`, a MESMA action que já
 * conferia funil e etapa contra o banco desta organização, com manager+ e MFA.
 * Duplicar a gravação aqui seria duas cópias da mesma regra — e a segunda ficaria
 * para trás no primeiro ajuste.
 *
 * ─── O que a tela NÃO deixa fazer, e por quê ───────────────────────────────
 *
 * Ligar sem funil. A action recusa (`validation_failed`), e a tela desabilita o
 * salvar antes de tentar: a configuração "ligada sem destino" é lida pelo serviço
 * como desligada (`nao_configurado`) — aceitá-la na tela seria prometer um
 * cartão que nunca nasce.
 *
 * ─── Por que a etapa é opcional e o funil não ──────────────────────────────
 *
 * Sem etapa escolhida, o card entra na PRIMEIRA etapa aberta do funil escolhido —
 * é o que o quadro já diz pela ordem das colunas. Escolher a etapa é refinamento,
 * e desligar não apaga nenhuma das duas escolhas: religar não obriga a escolher
 * de novo (mesma decisão da action).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirEntradaAutomaticaNoFunil } from "@/app/actions/settings/definirEntradaAutomaticaNoFunil";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import type { FunilDaTela } from "./_tipos";

export interface EntradaInicial {
  ativa: boolean;
  pipeline_id: string | null;
  stage_id: string | null;
}

/**
 * As frases de recusa, indexadas pelo código que a action devolve.
 *
 * Tabela de MÓDULO e não um mapa montado no `setErro`: a guarda de i18n
 * (`tests/unit/i18n-espanhol-cobre-a-tela`) recusa `t(<variável>)` — chave
 * montada em runtime não está em nenhum dicionário e a frase sairia em
 * português para quem escolhe espanhol. Aqui cada valor é resolvido da tabela,
 * e todos têm coluna `es`.
 */
const ERRO = {
  validation_failed: "Escolha o funil de destino antes de ligar a entrada automática.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um gerente ou administrador pode mudar esta opção.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  funil_invalido: "Este funil não existe mais nesta empresa. Escolha outro.",
  etapa_invalida: "Esta etapa não faz parte do funil escolhido. Escolha outra.",
  erro_ao_gravar: "Não consegui salvar agora. Tente de novo.",
} as const;

type ChaveDeErro = keyof typeof ERRO;

export function EntradaNoFunilForm({
  inicial,
  funis,
  idioma,
}: {
  inicial: EntradaInicial;
  funis: FunilDaTela[];
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [ativa, setAtiva] = useState(inicial.ativa);
  const [pipelineId, setPipelineId] = useState(inicial.pipeline_id ?? "");
  const [stageId, setStageId] = useState(inicial.stage_id ?? "");
  const [erro, setErro] = useState<ChaveDeErro | null>(null);
  const [isPending, startTransition] = useTransition();

  const funil = funis.find((f) => f.id === pipelineId) ?? null;
  const etapas = funil?.etapas ?? [];
  // A etapa escolhida só continua válida dentro do funil escolhido — trocar o
  // funil e manter a etapa antiga gravaria um par impossível (a action recusaria
  // e a pessoa não entenderia por quê).
  const etapaValida = etapas.some((etapa) => etapa.id === stageId);
  const podeSalvar = !isPending && (!ativa || Boolean(pipelineId));

  function trocarFunil(novo: string) {
    setPipelineId(novo);
    setStageId("");
    setErro(null);
  }

  function salvar() {
    setErro(null);
    startTransition(async () => {
      const resultado = await definirEntradaAutomaticaNoFunil({
        ativa,
        pipeline_id: pipelineId || null,
        stage_id: etapaValida ? stageId : null,
      });
      if (resultado.ok) {
        toast.success(t("Entrada automática salva."));
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

  const nomeDoFunil = funil?.name ?? "";
  const nomeDaEtapa = etapas.find((etapa) => etapa.id === stageId)?.name ?? "";

  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-sm font-medium">{t("Entrada automática no funil")}</h2>
        <p className="max-w-2xl text-xs text-muted-foreground">
          {t(
            "Toda conversa nova que nasce pelo CRM — Iniciar conversa, ficha do contato, lembrete de agenda ou de tarefa e a ferramenta de início de conversa do agente — passa a gerar um negócio nesta etapa, vinculada ao contato. Desligada é o comportamento de sempre: nenhum negócio nasce sozinho, e é o estado de quem nunca abriu esta tela.",
          )}
        </p>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="entrada_automatica_no_funil">
            {t("Conversa nova entra no funil sozinha")}
          </Label>
          <p className="max-w-2xl text-xs" data-testid="entrada-estado">
            {ativa
              ? t("Ligada: cada conversa nova gera um negócio na etapa escolhida abaixo.")
              : t("Desligada: a conversa nova não gera negócio nenhum por conta do CRM.")}
          </p>
        </div>
        <Switch
          id="entrada_automatica_no_funil"
          data-testid="entrada-ativa"
          checked={ativa}
          disabled={isPending}
          onCheckedChange={(novo) => {
            setAtiva(novo);
            setErro(null);
          }}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="funil-da-entrada">{t("Funil de destino")}</Label>
          <select
            id="funil-da-entrada"
            data-testid="funil-da-entrada"
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={pipelineId}
            disabled={isPending}
            onChange={(evento) => trocarFunil(evento.target.value)}
          >
            <option value="">{t("Escolha um funil")}</option>
            {funis.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="etapa-da-entrada">{t("Etapa de destino")}</Label>
          <select
            id="etapa-da-entrada"
            data-testid="etapa-da-entrada"
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={etapaValida ? stageId : ""}
            disabled={isPending || !pipelineId}
            onChange={(evento) => {
              setStageId(evento.target.value);
              setErro(null);
            }}
          >
            <option value="">{t("Primeira etapa aberta do funil")}</option>
            {etapas.map((etapa) => (
              <option key={etapa.id} value={etapa.id}>
                {etapa.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {ativa && pipelineId && (
        <p className="text-xs text-muted-foreground" data-testid="entrada-resumo">
          {etapaValida
            ? t("A conversa nova entra em «{funil}» → «{etapa}».").replace("{funil}", nomeDoFunil).replace("{etapa}", nomeDaEtapa)
            : t("A conversa nova entra na primeira etapa aberta de «{funil}».").replace("{funil}", nomeDoFunil)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" disabled={!podeSalvar} onClick={salvar}>
          {t("Salvar entrada automática")}
        </Button>
        <p role="status" className="text-xs text-destructive" data-testid="entrada-erro">
          {erro ? t(ERRO[erro]) : ""}
        </p>
      </div>
    </Card>
  );
}
