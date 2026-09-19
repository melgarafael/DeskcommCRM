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
 * ⚠️ ESTA OPÇÃO NÃO MUDA O QUE A PESSOA VÊ NA AGENDA. Quem é Atendente continua
 * vendo a grade da organização inteira — o que muda é o que ele consegue
 * ALTERAR. A frase está na tela de propósito: sem ela, é natural supor que
 * desligar esconde a agenda dos colegas, e a leitura é decisão em aberto do
 * mantenedor (declarada no PR da issue #978).
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
          "Com isto ligado, qualquer atendente cancela e remarca o compromisso de qualquer colega — é o comportamento de sempre. Desligado, cada atendente mexe só no compromisso de que é o responsável; gerentes e administradores seguem mexendo em tudo.",
        )}
      </p>

      <p className="text-sm" data-testid="agenda-dos-colegas-estado">
        {ligado
          ? t("Ligado: qualquer atendente mexe na agenda de qualquer colega.")
          : t(
              "Desligado: cada atendente mexe só na própria agenda. Gerentes e administradores continuam mexendo em tudo.",
            )}
      </p>

      <p className="text-sm text-text-muted">
        {t(
          "Isto não muda o que cada pessoa vê na agenda, só quem pode alterar o compromisso de quem.",
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
