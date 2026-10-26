# Spec: `aprovacoes` — o cliente aprova pela organização dele

> Fase 7 do [mapa de capacidades](mapa-de-capacidades.md). Estado: **decidida** em 26/10/2026
> pelas sugestões — o dono pediu, na mesma data, para seguir com as próximas fases ("vá
> seguindo em diante nas próximas fases"), o que cobre a consulta que o mapa pedia antes desta
> fase (é a única que toca o lado do cliente).
> Depende de [`clientes`](SPEC-clientes.md), [`tarefas`](SPEC-tarefas.md) e
> [`whatsapp-agencia`](SPEC-whatsapp-agencia.md).

## Objetivo

A agência manda para o cliente aprovar **vídeos, roteiros, artes e a estratégia do mês**; o
cliente vê e responde **dentro do CRM da própria organização** (`/app/aprovacoes`) — aprova ou
pede ajustes com um comentário —, e o **grupo do WhatsApp** recebe um aviso apontando para lá
(D11). A resposta volta para a agência no sininho e mexe na tarefa ligada.

## Decisões

| # | Decisão | Por quê |
|---|---|---|
| P1 | **Só acrescenta** ao lado do cliente: uma tabela nova, uma tela nova e uma porta no menu. Nenhuma tabela ou tela que as organizações já usam muda; a única escrita fora da agência é a chave `settings.agencia.aprovacoes = true` na organização do cliente. | Mapa › Limites: o lado do cliente é o de maior risco. |
| P2 | A porta aparece **só para organizações que são clientes da agência**: nova **capacidade** `aprovacoes_da_agencia` (`lib/organizacao/capacidades.ts`), que exige o módulo `agencia` ligado na instalação e é ligada pela própria agência ao pedir a primeira aprovação. | Mesmo mecanismo de Propostas; organização comum nunca vê a tela. |
| P3 | `agencia_aprovacoes` tem `organization_id` e **RLS de tenant**: o membro da organização LÊ as aprovações dela e só dela; **ninguém escreve pelo PostgREST** — a resposta passa por server action que confere a organização ativa, o papel e a guarda de suporte. | Doutrina de multi-tenancy do `CLAUDE.md`. |
| P4 | Quem responde: papel **agent** ou acima; o **viewer** só vê. "Pedir ajustes" exige comentário. | Mesma régua das Tarefas. |
| P5 | Tipos: vídeo, roteiro, arte, estratégia do mês, outro. Cada aprovação aponta para um **link** (do Drive, do YouTube…) ou para um **arquivo do acervo** do cliente, e pode estar ligada a uma **tarefa**. | O material mora no Drive (D20). |
| P6 | Aprovado → a tarefa ligada vai para **Concluído** (e a trilha acompanha). Ajustes → a tarefa volta para **Em andamento** com o comentário no checklist; a agência pode mandar uma **nova versão**, que fica ligada à anterior. | O ciclo do vídeo: editar → revisar → aprovar. |
| P7 | Aviso ao cliente: no **grupo** do contrato (quando foi criado), senão no WhatsApp do responsável, pelo WhatsApp da agência; o texto leva o título e o link da tela, nunca o conteúdo. | D11. |
| P8 | A resposta avisa (`aprovacao_respondida`) os responsáveis da tarefa ligada, ou quem pediu a aprovação, ou os avisos gerais. | Ninguém fica esperando sem saber. |

## Dados (migration 9009)

`agencia_aprovacoes` (organização, cliente, tipo, título, descrição, link, arquivo, tarefa,
versão, origem, situação pendente/aprovado/ajustes/cancelado, comentário do cliente, quem
pediu e quando, quem respondeu e quando). RLS: `select` para quem é da organização
(`fn_user_org_ids()`); nenhum `insert/update/delete` para `authenticated` ou `anon`. Motivo
`aprovacao` no WhatsApp da agência.

## Telas

| Onde | O quê |
|---|---|
| Agência › ficha do cliente › **Aprovações** | Pedir aprovação (tipo, título, descrição, link ou arquivo do acervo, tarefa), lista com situação e comentário, nova versão, cancelar. |
| Organização › **`/app/aprovacoes`** | Pendentes primeiro; cada item com o link, "Aprovar" e "Pedir ajustes" (comentário); respondidas embaixo. Em português e espanhol. |

## Critérios de aceite

1. A porta só aparece para organização cliente da agência; as outras recebem 404 na rota.
2. Membro da organização A não lê aprovação da organização B (teste por JWT).
3. Viewer não responde; agent responde; ajustes sem comentário é recusado.
4. Aprovar conclui a tarefa ligada; ajustes a devolve com o comentário.
5. A agência é avisada da resposta.
