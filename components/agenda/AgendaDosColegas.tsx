"use client";

import { useId, useState, useTransition } from "react";

import {
  definirAgendaDosColegas,
  type ErroAgendaDosColegas,
} from "@/app/actions/settings/definirAgendaDosColegas";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

/**
 * AGENDA DOS COLEGAS — o interruptor da opção da migration 0343 (issue #978).
 *
 * Mora em Configurações › Tipos de agendamento, ao lado de "Clientes pela
 * agenda" e dos prazos da agenda: é a tela das regras de comportamento da
 * agenda por organização.
 *
 * LIGADO (o padrão, e o de quem já instalou): qualquer Atendente cancela e
 * remarca o compromisso de qualquer colega — o comportamento de sempre, e por
 * isso não há nada a avisar nem a confirmar. DESLIGADO: cada Atendente mexe só
 * no compromisso de que é dono; Gerente e Administrador seguem mexendo em tudo.
 *
 * ⚠️ NÃO PEDE CONFIRMAÇÃO, e a diferença para "Clientes pela agenda" é o
 * motivo: ali ligar reescreve etiquetas de toda a organização numa transação.
 * Aqui não se reescreve dado nenhum — a regra é lida no ato, e desfazer é
 * apertar de novo. Um diálogo de confirmação para o que se desfaz com o mesmo
 * clique seria cerimônia.
 *
 * ⚠️ DESLIGADA, ESTA OPÇÃO TAMBÉM MUDA O QUE O ATENDENTE VÊ — na agenda E nas
 * tarefas. Até a migration 0680 (issue #2902) ela só governava a escrita, e esta
 * tela afirmava que a leitura não mudava. Hoje, desligada, a agenda e as
 * tarefas seguem `visibility_mode` (Configurações › "O que cada atendente
 * enxerga"), como conversas e negócios: `fn_can_view_appointment` e
 * `fn_can_view_task`. Ligada, a RLS abre a organização inteira para o
 * atendente. Usar ESTA opção para a leitura foi escolha do PR #2954, não da
 * #978 (que decidiu só marcar/remarcar/cancelar) — se um dia virar opção
 * própria, a frase da tela muda junto.
 *
 * ⚠️ O interruptor NÃO é a autorização: quem decide é
 * `fn_definir_colegas_podem_mexer_na_agenda`, no banco. `podeMudar` é cortesia —
 * ele desabilita o controle para quem o banco recusaria de qualquer jeito.
 */

/** A frase de cada recusa. As gerais são as que "Clientes pela agenda" já usa. */
const TEXTO_DO_ERRO: Record<ErroAgendaDosColegas, string> = {
  sessao: "Sua sessão expirou. Entre de novo.",
  somente_leitura: "Acompanhamento somente leitura ou encerrado.",
  sem_empresa: "Nenhuma empresa ativa.",
  sem_permissao: "Só um gerente ou administrador pode mudar essa regra.",
  mfa: "Confirme a verificação em duas etapas.",
  tente_de_novo: "Outra mudança estava em andamento. Tente de novo.",
  falha: "Não consegui salvar essa mudança agora.",
};

export function AgendaDosColegas({
  ligadoInicial,
  podeMudar,
}: {
  ligadoInicial: boolean;
  /**
   * Espelha o piso `manager` que `fn_definir_colegas_podem_mexer_na_agenda`
   * cobra. Cortesia, não autorização.
   */
  podeMudar: boolean;
}) {
  const t = useT();
  const idDoRotulo = useId();
  const [ligado, setLigado] = useState(ligadoInicial);
  const [erro, setErro] = useState<ErroAgendaDosColegas | null>(null);
  const [salvando, iniciar] = useTransition();

  function aplicar(novo: boolean) {
    setErro(null);
    iniciar(async () => {
      const r = await definirAgendaDosColegas(novo);
      if (!r.ok) {
        setErro(r.erro);
        return;
      }
      // O estado vem do CORPO da action (`ligado` do banco), nunca de um
      // `router.refresh` que perca a corrida para os prefetches.
      setLigado(r.ligado);
    });
  }

  return (
    <section className="space-y-3 rounded-xl border p-4" data-testid="agenda-dos-colegas">
      <h2 className="font-semibold">{t("Agenda dos colegas")}</h2>

      <div className="flex items-center gap-3">
        <Switch
          checked={ligado}
          onCheckedChange={aplicar}
          disabled={!podeMudar || salvando}
          aria-labelledby={idDoRotulo}
          data-testid="agenda-dos-colegas-interruptor"
        />
        <span id={idDoRotulo} className="text-sm font-medium">
          {t("Atendentes podem mexer na agenda dos colegas")}
        </span>
      </div>

      <p className="text-sm text-text-muted">
        {t(
          "Com isto ligado, qualquer atendente vê, cancela e remarca o compromisso de qualquer colega, e vê e mexe nas tarefas da equipe — é o comportamento de sempre. Desligado, cada atendente mexe só no compromisso de que é o responsável; gerentes e administradores seguem mexendo em tudo.",
        )}
      </p>

      <p className="text-sm" data-testid="agenda-dos-colegas-estado">
        {ligado
          ? t("Ligado: qualquer atendente mexe na agenda e nas tarefas de qualquer colega.")
          : t(
              "Desligado: cada atendente mexe só na própria agenda, e a agenda e as tarefas seguem o que ele enxerga. Gerentes e administradores continuam mexendo em tudo.",
            )}
      </p>

      <p className="text-sm text-text-muted">
        {t(
          "Desligado, a agenda e as tarefas também seguem “O que cada atendente enxerga”: em “Só os seus” ou “Os seus, mais os que ainda não têm dono”, o atendente vê e mexe só nos próprios compromissos e nas próprias tarefas, mais as que ele criou (e, no segundo modo, o que ainda não tem dono). Em “Todos veem tudo”, ele continua vendo tudo.",
        )}
      </p>

      {!podeMudar && (
        <p className="text-sm text-text-muted">
          {t("Só um gerente ou administrador pode mudar essa regra.")}
        </p>
      )}

      {erro && (
        <p role="alert" className="text-sm text-destructive" data-testid="agenda-dos-colegas-erro">
          {t(TEXTO_DO_ERRO[erro])}
        </p>
      )}
    </section>
  );
}
