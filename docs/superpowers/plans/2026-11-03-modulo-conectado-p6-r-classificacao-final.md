# Módulo conectado (Spec 33) — R: classificação final dos 80 métodos que faltavam

Medido em 04/11/2026, lendo cada handler e a ÚLTIMA definição das funções em `supabase/baseline.sql`. Decide, método a método, o que vira token (`dsk_…`) e o que fica só de sessão de propósito. É a ordem das conversões que sobraram das fatias R1, R2 e R3. Onde este documento e os planos p2, p3 e p4 discordarem, **este vale**.

Escopo e papel do token: leitura `config:read` (R1) ou `mcp:read` (R2, R3); escrita `config:write` (R1) ou `mcp:write` (R2). `tokenRole` indicado por rota.

A ÁREA de cada rota (F3) NÃO é decidida aqui. Sugestões estão na coluna "área?" e a F3 as confirma; o financeiro não tem área na lista de 9 e a F3 decide se ganha uma.

Regra de decisão para ficar só de sessão: (a) a função do banco ou o handler usa `auth.uid()` ou a pessoa é o sujeito; (b) manda ou agenda mensagem a cliente final; (c) usa credencial, provedor de IA, cobrança, equipe, ou gasta o orçamento de IA do cliente com conteúdo do cliente; (d) depende de cliente de banco logado como a pessoa sem como trocar sem mexer em função SQL.

## CONVERTER (38)

### R1 — configuração (22), `tokenRole: "admin"`, escrita `config:write`

| Rota | Método | Receita | Notas obrigatórias |
|---|---|---|---|
| ai/guardrail-layers | GET | A | `GET()` passa a receber `req`; `podeEditar` fixo `true` no token. área? agentes_ia |
| ai/style-adjustments | GET | A | igual ao PUT já convertido; `podeEditar` `true`. agentes_ia |
| ai/routing-results | GET | A | já usa admin client com org; `pode_revisar` `true`. agentes_ia |
| ai/skills/[name]/install | POST | A | a consulta `.is("organization_id", null)` ao catálogo de plataforma é intencional: o cliente falso do teste a trata como exceção. `createdBy` pode ser null. |
| ai/skills/[name]/restore | POST | A | audit usa o ator do token. |
| ai/skills/[name] | PUT | A | idem; o DELETE vizinho é o molde. |
| ai/skills/import | POST | A | upload multipart; storage com prefixo da organização. |
| attendants/sector/[user_id] | PUT | A | já admin com org; `actorUserId` vira null no token. configuracao |
| attendants/sectors/[id] | PATCH | A | idem. |
| attendants/sectors/[id] | DELETE | A | idem. |
| attendants/sectors | GET | A | papel mínimo `viewer`; trocar o cliente de sessão por `authz.supabase`. |
| attendants/sectors | POST | A | idem. |
| ~~automation-rules~~ | ~~POST~~ | — | **REVOGADO em 04/11 (medido na conversão):** as ações da regra carregam ids sem FK dentro de jsonb (`pipeline_id`, `stage_id`, `channel_session_id`, `agent_id`, `user_id`, `fila[].user_id`, ações aninhadas em `ai_decide`) e a rota só confere `webhook_source_id`. Com token, uma regra poderia apontar para recurso de outra organização. Fica de sessão até existir validador de ids por tipo de ação. |
| message-templates/[id]/midias | POST | A | no ramo do token só `owner_user_id is null` (compartilhado), no select e no update. |
| message-templates/[id]/ordem | PUT | A | token só mexe nas compartilhadas: `.is("owner_user_id", null)` na lista e nos updates; teste próprio da renumeração relativa. |
| message-templates/[id] | PATCH | A | idem. |
| message-templates | POST | A | token só cria compartilhado: recusar `shared:false`; `created_by_user_id` null. |
| pipelines/[id]/forecast | GET | A | no token a leitura é da organização inteira; atualizar o comentário e o teste. funis |
| pipelines/[id]/stages/[stageId] | PATCH | A | passar `authz.actor` à lib (`atualizarEtapa` aceita Actor). |
| pipelines/[id]/stages/[stageId] | DELETE | A | `arquivarEtapa` move negócios: grava atividade com o ator. |
| pipelines/[id]/stages | POST | A | `criarEtapa` aceita Actor. |
| settings/routing/channels | GET | **B** | o portão atual usa `allowPlatformAdmin:"leitura"` e `mfaEmDivida()`: manter a sessão idêntica e acrescentar só o ramo bearer chamando `loadChannelRoutingSettings(authz.supabase, authz.organizationId)`. O PATCH fica de fora. |

### R2 — operação (11), `mcp:write` / `mcp:read`

| Rota | Método | Receita | Notas obrigatórias |
|---|---|---|---|
| agenda/excecoes | DELETE | A | `tokenRole: "manager"` (a RLS deixa agent apagar só as próprias). |
| contacts/duplicates/dismiss | POST | A (pool pg) | `userId` do ator só se `type==="user"`, senão null; `actorApiTokenId` no audit; manter `requireSupportWrite`. manager |
| financeiro/catalogo/[tipo] | POST | A | manager. `account_id` de `formas_de_pagamento` é FK simples: com admin, conferir que a conta é da organização antes do insert. audit com ator. |
| financeiro/catalogo/[tipo] | PATCH | A | idem (`account_id` em `campos`). |
| financeiro/catalogo/[tipo] | DELETE | A | só inativa. |
| financeiro/fidelidade | POST | A | agent. `created_by_user_id` null no token; `contact_id` do corpo: buscar o contato com `.eq("organization_id")`; o `audit()` precisa ganhar `organizationId`, `actorUserId`, `actorApiTokenId`. |
| financeiro/lancamentos | POST | A | agent. `account_id`/`account_plan_id` do corpo: validar que são da organização; `created_by_user_id` null; audit com organização e ator. |
| financeiro/lancamentos/[id] | PATCH | A | agent. **Hoje NÃO filtra `organization_id`** (só a RLS): acrescentar `.eq("organization_id", authz.organizationId)` na leitura e no update. |
| financeiro/lancamentos/[id] | DELETE | A | idem nos dois pontos; sem isso o delete por id apagaria lançamento de outra organização. |
| honorarios/contratos/[id]/parcelas | POST | A | manager. Buscar `honorarios_contratos` com `.eq("organization_id").eq("id")` antes de inserir; audit com organização e ator. |
| leads/at-risk | GET | **B** | agent. Ramo bearer chama `carregaRadarDeRisco(authz.supabase, {organizationId, limit, minHours})` sem `humanRole`; a visão da organização inteira é a mesma da tool MCP. negocios |

### R3 — leitura (5), `mcp:read`, `tokenRole: "manager"` em todas

| Rota | Método | Notas obrigatórias |
|---|---|---|
| metrics/atrito | GET | idioma por `authz.idioma ?? IDIOMA_PADRAO`; `fn_atrito_metrics(p_org=authz.organizationId)`. manager |
| metrics/channels | GET | `fn_channel_metrics`. manager |
| metrics/funil | GET | a moeda da organização vem de `organizations.currency` lida com admin (a resposta do token é igual à da sessão). manager |
| metrics/metas | GET | idem moeda. manager (corrigido após revisão de segurança: a RLS da sessão limita o atendente aos negócios dele; o token lê a organização inteira). |
| reports/activities | GET | `fn_activity_report(p_org)`. manager. Medido: a função filtra por organização na CTE `janela`; só há 2 joins por id sem filtro (risco baixo, endurecimento opcional com migration + tripla). |

Por que manager nos que têm recorte "own": na sessão o atendente comum só vê as conversas dele; o token vê a organização inteira, então exigimos gerente para não abrir mais do que a tela abre.

## FICAR SÓ DE SESSÃO (de propósito)

| Rota | Método(s) | Motivo |
|---|---|---|
| ai/jev | GET, PATCH | estado da chave de IA e aceite de LGPD gravado em nome da pessoa (c, a) |
| ai/pacing | PUT | antecipa turnos de IA já adiados ao salvar; ritmo do número de WhatsApp (b) |
| ai/voz/preview | POST | gasta a credencial de voz da organização (c) |
| settings/proposal-templates/importar | POST | gasta a IA do cliente com documento do cliente (c) |
| ai/cases/[id]/chat | GET, POST | guarda de visibilidade pela RLS do atendente; autor é a pessoa (a, d) |
| ai/cases/[id]/close | POST | exige mudar `encerrarChamadoPelaPessoa`, lib compartilhada com o agente (a) |
| ai/inbox, ai/inbox/[id], ai/inbox/resolve-all | GET, PATCH, POST | central pessoal; filtro por pessoa; link de pagamento de cobrança (a, c, d) |
| attendants/availability/[user_id] | PATCH | disponibilidade é estado pessoal (a) |
| automation-rules/[id] | PATCH | ligar/editar regra viva agenda envio e webhook (b, c) |
| tags/vocabulario | POST | `fn_vocabulario_de_tags_operar` exige `auth.uid()` (d) |
| team | GET | e-mail e último acesso de pessoas (c) |
| agenda/agendamentos/[id]/google/resolver, …/retry | POST | `fn_google_resolve` exige `auth.uid()` e MFA (a, d) |
| agenda/agendamentos/[id] | GET | `can_manage`/destinos dependem da pessoa; resposta degradada com token (a, d) |
| agenda/excecoes | POST | a pessoa da sessão é a dona da agenda por padrão (a) |
| agenda/google/calendarios, …/atualizar | GET, PATCH, POST | conexão Google da pessoa (c) |
| contacts/[id]/carteira | PATCH | posse por pessoa; função recusa ator nulo (a) |
| lead-captures | GET | dado pessoal bruto e IP do histórico de webhook (c) |
| proposals/[id]/assistant, …/preencher-com-conversa | POST | gastam a IA do cliente e mandam conversa de cliente ao modelo (c) |
| conversations/[id]/aviso-de-mensagem, draft-reply, reactivate-bot, pause-ai, close, notes/[noteId] DELETE, participants, transfer POST, PATCH [id], bulk, counts | vários | decidido na R2 anterior: função do banco ou vínculo forjável (a, d) |
| messages/[id]/hide | POST, DELETE | JÁ convertido (a medição por texto contou como faltando; o código está numa função compartilhada) |

## Ordem de execução

1. R3 (5 rotas): Sonnet, pedido em 04/11.
2. R2 (11 rotas), financeiro com Sonnet por causa do filtro de organização que falta hoje.
3. R1 (22 rotas), em lotes: ai/skills + guardrail/style/routing-results; attendants; message-templates + automation-rules POST; pipelines + routing/channels.
4. Um lote por vez, na mesma pasta (os arquivos de porta do proxy são compartilhados). Cada lote: commit por rota, validação por leitura minha, CI julga.

Placar esperado ao fim: 280 + 38 = 318 de 360 métodos aceitando token; os 42 restantes ficam de sessão pelos motivos acima.
