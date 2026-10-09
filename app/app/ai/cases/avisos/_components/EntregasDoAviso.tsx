"use client";
/**
 * A LISTA DOS ÚLTIMOS AVISOS — a superfície do registro de entregas.
 *
 * ## Por que ela não é opcional
 *
 * Doutrina do Sistema Vivo: mecanismo invisível é mecanismo que morre. Sem esta
 * lista, "os avisos estão saindo?" só se responde com `psql` — e num self-host
 * quem instalou não abre `psql`.
 *
 * ## Por que a FONTE é esta tabela, e não a Central
 *
 * A falha definitiva também abre um item na Central, mas a Central **não é a
 * fonte da verdade**: qualquer membro apaga um item dela pelo PostgREST hoje
 * (dívida anterior, declarada no motor). Uma tela que lesse "não há item
 * aberto" como "está tudo bem" mentiria justo para quem foi conferir.
 *
 * ## O destino sai MASCARADO, e a máscara é do servidor
 *
 * Quem lê esta lista pode ser `manager` (a RLS da tabela), e o telefone do
 * plantão não é assunto de quem só quer saber se o aviso saiu. A rota já manda
 * `destino_mascarado`; o número inteiro nunca entra no wire desta lista.
 *
 * ## O laço de retorno vive aqui embaixo
 *
 * Invariante 7: a feature declara o que muda quando ela erra. O contraste é
 * intra-organização — casos avisados × casos não avisados —, porque num
 * self-host existe UMA organização e contraste entre contas não existe.
 */
import Link from "next/link";
import { format } from "date-fns";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { FRASE_DO_ERRO_DO_AVISO } from "@/lib/escalacao/vocabulario-do-aviso";
import type { EntregaNaTela } from "@/lib/escalacao/tela-do-aviso";
import type { LacoDoAviso } from "@/lib/escalacao/laco-do-aviso";
import { ArrowSquareOut } from "@/lib/ui/icons";

/**
 * A palavra que descreve cada estado da entrega para quem não programa.
 *
 * Tabela rasa de módulo: é assim que o guarda de espanhol resolve `t(X[k])` e
 * cobra tradução de cada uma. `pendente` diz "ainda tentando" e não "pendente",
 * que para um leigo parece coisa parada esperando ELE.
 */
const SITUACAO_DA_ENTREGA = {
  pendente: "Tentando enviar",
  enviado: "Aceito pelo canal",
  falhou: "Não saiu",
  cancelado: "Cancelado",
} as const;

function situacao(status: string): string {
  return status in SITUACAO_DA_ENTREGA
    ? SITUACAO_DA_ENTREGA[status as keyof typeof SITUACAO_DA_ENTREGA]
    : status;
}

function marcoDaEntrega(entrega: EntregaNaTela): {
  rotulo: string;
  minuto: number | null;
  ciclo: string | null;
} {
  if (entrega.wait_generation === null && entrega.reminder_minute === null) {
    return { rotulo: "Aviso de abertura", minuto: null, ciclo: null };
  }

  if (entrega.wait_generation !== null && entrega.reminder_minute !== null) {
    return {
      rotulo: "Reforço de",
      minuto: entrega.reminder_minute,
      ciclo: String(entrega.wait_generation),
    };
  }

  return { rotulo: "Tipo de aviso não reconhecido", minuto: null, ciclo: null };
}

function fraseDoErro(codigo: string | null): string | null {
  if (!codigo) return null;
  return codigo in FRASE_DO_ERRO_DO_AVISO
    ? FRASE_DO_ERRO_DO_AVISO[codigo as keyof typeof FRASE_DO_ERRO_DO_AVISO]
    : null;
}

export function EntregasDoAviso({
  entregas,
  laco,
  atualizando,
  aoAtualizar,
}: {
  entregas: EntregaNaTela[];
  laco: LacoDoAviso;
  atualizando: boolean;
  aoAtualizar: () => void;
}) {
  const t = useT();
  const locale = useLocaleDeData();

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{t("Histórico de tentativas de aviso")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "O que saiu, o que não saiu e por quê. Esta lista é o registro do sistema — ela não some quando alguém resolve um alerta.",
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              "“Aceito pelo canal” confirma que o canal recebeu o pedido de envio; sem recibo de entrega, não confirma que a mensagem chegou ao WhatsApp.",
            )}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={atualizando}
          onClick={aoAtualizar}
          aria-label={t("Atualizar histórico")}
          data-testid="atualizar-historico-aviso"
        >
          {atualizando ? t("Atualizando…") : t("Atualizar histórico")}
        </Button>
      </div>

      {entregas.length === 0 ? (
        <p
          className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground"
          data-testid="entregas-vazias"
        >
          {t(
            "Nenhum aviso saiu ainda. Quando o assistente abrir um caso, a tentativa aparece aqui — inclusive se ela falhar.",
          )}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="lista-de-entregas">
          {entregas.map((entrega) => {
            const frase = fraseDoErro(entrega.erro_codigo);
            const quando = entrega.enviado_em ?? entrega.created_at;
            const marco = marcoDaEntrega(entrega);
            return (
              <li key={entrega.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {format(new Date(quando), "dd/MM 'às' HH:mm", { locale })}
                </span>
                <span
                  className="text-xs font-medium"
                  data-testid={`entrega-situacao-${entrega.status}`}
                >
                  {t(situacao(entrega.status))}
                </span>
                <span
                  className="text-xs font-medium"
                  data-testid="entrega-tipo"
                  data-marco={entrega.reminder_minute ?? "abertura"}
                  data-wait-generation={entrega.wait_generation ?? ""}
                >
                  {t(marco.rotulo)}
                  {marco.minuto === null
                    ? ""
                    : ` ${marco.minuto} ${t(marco.minuto === 1 ? "minuto" : "minutos")}`}
                  {marco.ciclo === null ? "" : ` · ${t("Ciclo")} ${marco.ciclo}`}
                </span>
                <span className="text-xs text-muted-foreground">{entrega.destino_mascarado}</span>
                <Link
                  href={`/app/ai/cases?caso=${entrega.case_id}`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  {t("Abrir o atendimento")}
                  <ArrowSquareOut className="h-3 w-3" />
                </Link>
                {frase ? (
                  <span className="basis-full text-xs text-muted-foreground">{t(frase)}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <LacoDeRetorno laco={laco} />
    </Card>
  );
}

/**
 * "O aviso adiantou alguma coisa?" — a única pergunta que justifica o recurso
 * continuar existindo.
 *
 * Os dois grupos contam do MESMO marco (a abertura do caso), que é o instante
 * em que o cliente começou a esperar. O atraso da própria entrega aparece
 * separado, porque é outra pergunta.
 */
function LacoDeRetorno({ laco }: { laco: LacoDoAviso }) {
  const t = useT();
  const temAmostra = laco.comAviso.respondidos > 0 || laco.semAviso.respondidos > 0;

  return (
    <div className="mt-4 border-t pt-3" data-testid="laco-do-aviso">
      <h3 className="text-xs font-semibold">{t("O aviso está adiantando o atendimento?")}</h3>
      {!temAmostra ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            "Ainda não há casos suficientes nos últimos 30 dias para comparar. A comparação aparece sozinha quando houver.",
          )}
        </p>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Medida
            titulo={t("Casos em que o canal aceitou o aviso")}
            casos={laco.comAviso.casos}
            respondidos={laco.comAviso.respondidos}
            minutos={laco.comAviso.medianaMinutos}
          />
          <Medida
            titulo={t("Casos sem aviso")}
            casos={laco.semAviso.casos}
            respondidos={laco.semAviso.respondidos}
            minutos={laco.semAviso.medianaMinutos}
          />
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        {t(
          "Tempo típico entre o assistente travar e alguém da equipe agir, nos últimos 30 dias. Os dois grupos contam a partir do mesmo momento.",
        )}
      </p>
    </div>
  );
}

function Medida({
  titulo,
  casos,
  respondidos,
  minutos,
}: {
  titulo: string;
  casos: number;
  respondidos: number;
  minutos: number | null;
}) {
  const t = useT();
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{titulo}</p>
      <p className="text-lg font-semibold tabular-nums">
        {minutos === null ? "—" : `${minutos} min`}
      </p>
      <p className="text-[11px] text-muted-foreground">
        {respondidos}/{casos} {t("casos já tiveram uma ação da equipe")}
      </p>
    </div>
  );
}
