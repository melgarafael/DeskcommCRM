# Plano de implementação — Fase 7 (aprovações do cliente)

> Estado: **construída, publicada no teste.emmovimento.tech e provada** em 26/10/2026, branch
> `feat/agencia-fase-7` (sai da Fase 6). Prova pela tela em `evidence/agencia-fase-7/`.
> Spec: [`SPEC-aprovacoes`](SPEC-aprovacoes.md). É a primeira fase que toca o lado do cliente;
> o dono mandou seguir com as próximas fases em 26/10/2026.
>
> **Verificação (26/10/2026):** typecheck e lint limpos; no Postgres da VPS, baseline install +
> update sem erro e todos os invariantes da agência verdes — inclusive o isolamento de
> `agencia_aprovacoes` entre duas organizações por JWT (leitura local, ZERO do vizinho, anon
> recusado, insert/update/delete de sessão recusados) e a prova de que `agencia_clientes` não
> é lida nem pelo membro da organização ligada (as duas agora em `PROVA_PROPRIA` da varredura de
> RLS). No teste: a agência pediu a aprovação de um vídeo ligado à tarefa "Editar 8 vídeos do
> mês" (a tarefa foi para Revisão); como membro temporário (agent) da organização "Empresa
> Modelo (Testes)" — retirado depois —, a porta **Aprovações** apareceu no menu do CRM, o
> cliente pediu ajustes com comentário (a tarefa voltou para Em andamento com o ajuste no
> checklist, e o responsável foi avisado); a agência mandou a v2 ligada à v1; o cliente aprovou
> (a tarefa foi para Concluído e o aviso "Aprovado" chegou); 375 px sem rolagem lateral.
>
> **Achado na prova e consertado:** a tela do cliente mostrava a hora no fuso do navegador
> (UTC no robô da prova); agora usa o fuso da organização.
>
> **Não provado ainda:** o aviso no grupo/WhatsApp do cliente (o número da agência não está
> conectado no teste — a tela diz "avise você"), o texto em espanhol na tela (as traduções
> estão no dicionário) e a recusa ao viewer pela tela (a regra está na action).

## Decisões de arquitetura

- **Migration 9009** + apêndice no baseline. Primeira tabela da agência com `organization_id`
  e policy de tenant (`tenant_isolation_agencia_aprovacoes_read`, só SELECT); escrita só pelo
  servidor.
- **Capacidade nova** `aprovacoes_da_agencia` em `lib/organizacao/capacidades.ts` (módulo
  `agencia`), ligada pela agência em `organizations.settings.agencia.aprovacoes`.
- Tela do cliente em `app/app/aprovacoes/` (layout com o portão da capacidade, página lendo
  pelo servidor filtrada pela organização ativa, componente com `useT()`), porta no
  `NAV_CATALOG` (grupo CRM), traduções em espanhol no `lib/i18n/dicionario.ts`.
- Resposta em `app/actions/aprovacoesDaAgencia.ts`: `supportWriteError`, organização da sessão,
  `roleAtLeast(agent)`, capacidade, e UPDATE só da linha DESTA organização e pendente.
- O WhatsApp da agência passou a mandar para **grupo** (`…@g.us`) — `comGrupo()` no handler.
