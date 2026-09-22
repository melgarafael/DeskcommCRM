"use client";

import {
  ChatCircle,
  Kanban,
  UsersThree,
  ListMagnifyingGlass,
  Funnel,
  ArrowsLeftRight,
  Key,
  ClockCounterClockwise,
  GitBranch,
  Users,
} from "@phosphor-icons/react";
import { useT } from "@/hooks/i18n/useT";
// Do barril, e não do `@phosphor-icons/react` que as linhas acima usam: a regra
// (ADR-05) é o barril, e 116 arquivos a seguem. O import de cima é dívida
// anterior a esta feature — replicá-la para ficar "consistente com o arquivo"
// espalharia o problema em vez de parar de crescê-lo.
import { CalendarBlank } from "@/lib/ui/icons";
import { EmptyState, type EmptyStateAction } from "./EmptyState";

interface VariantProps {
  primary?: EmptyStateAction;
  secondary?: EmptyStateAction;
}

export function EmptyInbox({ primary, secondary }: VariantProps = {}) {
  const t = useT();
  return (
    <EmptyState
      icon={ChatCircle}
      headline={t("Sem conversas por aqui")}
      subcopy={t("Quando chegarem mensagens, elas aparecem aqui em tempo real.")}
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyKanban({ primary, secondary }: VariantProps = {}) {
  const t = useT();
  return (
    <EmptyState
      icon={Kanban}
      headline={t("Quadro vazio")}
      subcopy={t(
        "Ainda não há nenhum cliente aqui. Assim que a primeira conversa começar, o cartão aparece nesta coluna.",
      )}
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyContacts({ primary, secondary }: VariantProps = {}) {
  const t = useT();
  return (
    <EmptyState
      icon={UsersThree}
      headline={t("Nenhum cliente ainda")}
      subcopy={t("Clientes chegam automaticamente via WhatsApp ou Nuvemshop.")}
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyAudit({ primary, secondary }: VariantProps = {}) {
  const t = useT();
  return (
    <EmptyState
      icon={ListMagnifyingGlass}
      headline={t("Sem eventos no período")}
      subcopy={t("Ajuste o filtro de datas ou a busca pra ver eventos.")}
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyPipeline({ primary, secondary }: VariantProps = {}) {
  const t = useT();
  return (
    <EmptyState
      icon={GitBranch}
      headline={t("Nenhum funil ainda")}
      subcopy={t(
        "Um funil é o caminho que o cliente percorre até fechar. Crie o primeiro para ter um quadro.",
      )}
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyTeam({ primary, secondary }: VariantProps = {}) {
  const t = useT();
  return (
    <EmptyState
      icon={Users}
      headline={t("Sem membros no time")}
      subcopy={t("Convide colegas pra atender em conjunto.")}
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyApiTokens({ primary, secondary }: VariantProps = {}) {
  const t = useT();
  return (
    <EmptyState
      icon={Key}
      headline={t("Nenhum token criado")}
      subcopy={t("Tokens permitem integrações server-to-server.")}
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyTimeline({ primary, secondary }: VariantProps = {}) {
  const t = useT();
  return (
    <EmptyState
      icon={ClockCounterClockwise}
      headline={t("Sem atividades registradas")}
      subcopy={t("A timeline mostra mensagens, mudanças de stage e notas.")}
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyMergeQueue({ primary, secondary }: VariantProps = {}) {
  const t = useT();
  return (
    <EmptyState
      icon={ArrowsLeftRight}
      headline={t("Sem candidatos a merge")}
      subcopy={t("Contatos duplicados aparecerão aqui pra revisão.")}
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyFilterResults({ primary, secondary }: VariantProps = {}) {
  const t = useT();
  return (
    <EmptyState
      icon={Funnel}
      headline={t("Nenhum resultado")}
      subcopy={t("Tente ajustar os filtros ou a busca.")}
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyAgenda({ primary, secondary }: VariantProps = {}) {
  const t = useT();
  return (
    <EmptyState
      icon={CalendarBlank}
      headline={t("Sua agenda está livre esta semana")}
      // O vazio diz de onde VEM o próximo agendamento, em vez de constatar a
      // ausência. "Nenhum agendamento encontrado" é verdadeiro e inútil: quem
      // acabou de instalar não sabe o que fazer com essa frase.
      subcopy={t(
        "Agendamentos aparecem aqui quando alguém marca pela tela, quando o agente marca por você, ou quando chegam da agenda do Google conectada.",
      )}
      primary={primary}
      secondary={secondary}
    />
  );
}
