-- `agent_cases.kind` — do que o caso trata, para quem tria a fila.
--
-- POR QUE: hoje o assunto de um caso vive só em texto livre (`title`, `summary`,
-- `blocker`). Com a fila curta isso basta — dá para ler tudo. Com volume, não:
-- quem abre a fila quer separar "alguém quer marcar horário" de "alguém está
-- reclamando" antes de ler qualquer coisa, porque as duas pedem pessoas e
-- urgências diferentes.
--
-- Medido no CRM de origem: 102 pedidos em poucos meses, distribuídos em
-- agendamento 53, atendimento humano 33, remarcação 4, pagamento 4, curso 3,
-- cancelamento 2, dúvida 2, outro 1. A triagem por assunto era o que a tela de
-- lá oferecia, e é o que falta aqui.
--
-- ⚠️ SEM CHECK, DE PROPÓSITO — e isto é a doutrina de vocabulário ABERTO do
-- CLAUDE.md, não descuido. O vocabulário útil muda com o negócio: clínica tem
-- "remarcação", loja tem "troca". Um CHECK fixo aqui obrigaria uma migration
-- por nicho, e faria o `update.sh` de um clone com valor próprio quebrar. Quem
-- prende o vocabulário é a constante `TIPOS_DE_CASO` no TypeScript, e o emissor
-- usa ela — nunca string literal. A coluna fica FORA do invariante
-- `vocabulario-banco-x-typescript`, que só cobre coluna que JÁ tem CHECK.
--
-- `default 'outro'` e `not null`: caso antigo não fica com buraco, e caso novo
-- sem classificação cai no genérico em vez de num nulo que toda tela precisa
-- tratar. Nenhum backfill: o default resolve as linhas existentes na hora.

alter table public.agent_cases
  add column if not exists kind text not null default 'outro';

comment on column public.agent_cases.kind is
  'Do que o caso trata, para triagem. Vocabulário ABERTO (sem CHECK): a lista vigente é TIPOS_DE_CASO em lib/ai/case-copy.ts, e quem escreve usa a constante. Valor desconhecido cai no rótulo genérico da tela, nunca quebra.';

-- A fila é sempre lida por organização e por status; o assunto é o terceiro
-- corte. Parcial nos abertos porque é neles que se tria — resolvido vira
-- histórico, e histórico se consulta inteiro.
create index if not exists agent_cases_org_status_kind_idx
  on public.agent_cases (organization_id, kind)
  where status in ('awaiting_human', 'awaiting_lead');
