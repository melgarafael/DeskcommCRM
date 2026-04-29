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
import { EmptyState, type EmptyStateAction } from "./EmptyState";

interface VariantProps {
  primary?: EmptyStateAction;
  secondary?: EmptyStateAction;
}

export function EmptyInbox({ primary, secondary }: VariantProps = {}) {
  return (
    <EmptyState
      icon={ChatCircle}
      headline="Sem conversas por aqui"
      subcopy="Quando chegarem mensagens, elas aparecem aqui em tempo real."
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyKanban({ primary, secondary }: VariantProps = {}) {
  return (
    <EmptyState
      icon={Kanban}
      headline="Pipeline vazio"
      subcopy="Crie um lead pra começar a movimentar cards entre as etapas."
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyContacts({ primary, secondary }: VariantProps = {}) {
  return (
    <EmptyState
      icon={UsersThree}
      headline="Nenhum contato ainda"
      subcopy="Contatos chegam automaticamente via WhatsApp ou Nuvemshop."
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyAudit({ primary, secondary }: VariantProps = {}) {
  return (
    <EmptyState
      icon={ListMagnifyingGlass}
      headline="Sem eventos no período"
      subcopy="Ajuste o filtro de datas ou a busca pra ver eventos."
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyPipeline({ primary, secondary }: VariantProps = {}) {
  return (
    <EmptyState
      icon={GitBranch}
      headline="Sem pipelines configurados"
      subcopy="Crie um pipeline pra organizar leads em etapas."
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyTeam({ primary, secondary }: VariantProps = {}) {
  return (
    <EmptyState
      icon={Users}
      headline="Sem membros no time"
      subcopy="Convide colegas pra atender em conjunto."
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyApiTokens({ primary, secondary }: VariantProps = {}) {
  return (
    <EmptyState
      icon={Key}
      headline="Nenhum token criado"
      subcopy="Tokens permitem integrações server-to-server."
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyTimeline({ primary, secondary }: VariantProps = {}) {
  return (
    <EmptyState
      icon={ClockCounterClockwise}
      headline="Sem atividades registradas"
      subcopy="A timeline mostra mensagens, mudanças de stage e notas."
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyMergeQueue({ primary, secondary }: VariantProps = {}) {
  return (
    <EmptyState
      icon={ArrowsLeftRight}
      headline="Sem candidatos a merge"
      subcopy="Contatos duplicados aparecerão aqui pra revisão."
      primary={primary}
      secondary={secondary}
    />
  );
}

export function EmptyFilterResults({ primary, secondary }: VariantProps = {}) {
  return (
    <EmptyState
      icon={Funnel}
      headline="Nenhum resultado"
      subcopy="Tente ajustar os filtros ou a busca."
      primary={primary}
      secondary={secondary}
    />
  );
}
