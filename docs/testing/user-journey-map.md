# Mapa de Jornadas & Testes E2E — Experiência do usuário em VPS fresca

> Fonte da verdade do QA de produto do DeskcommCRM open-source. Cada caso aqui é
> exercitado **pelo frontend real** (Playwright), com contas de teste reais e
> recursos reais (banco fresco do `baseline.sql`, WAHA local, receiver de webhook
> real). Curl/API só como diagnóstico, nunca como prova de UX.
>
> Persona: **usuário leigo** que rodou o `install.sh` numa VPS e abriu o navegador.
> Ambiente de referência: banco 100% zerado + `bootstrap-owner.ts` (espelha o que o kit
> faz — o `install.sh` refaz esse bootstrap em bash, não chama o script).

## Convenções

- `[P0]` primeira impressão — bug aqui é vergonha pública; prioridade máxima.
- `[P1]` rotina diária do operador/atendente.
- `[P2]` exploração/edge.
- Resultado: `PASS` / `FAIL(bug#)` / `WARN` (funciona mas UX ruim).
- Evidência: screenshot/trace em `.superpowers/evidence/vps-qa/`.

---

## J1 — Onboarding do primeiro usuário `[P0]`

Contexto do código: sem signup público (`app/(public)/login`); primeiro usuário nasce
do `scripts/bootstrap-owner.ts` (na VPS, do bootstrap equivalente dentro do `install.sh`).
Wizard: welcome → whatsapp → (nuvemshop
se `NUVEMSHOP_ENABLED`) → setup-ai → invite-team → done. Gate: `organizations.onboarded_at`.
MFA obrigatório pra admin logo após o wizard (`MfaEnrollGate`).

| # | Caso | Expectativa |
|---|------|-------------|
| J1.1 | Login com credenciais do bootstrap | entra e é redirecionado pro `/onboarding` (org sem `onboarded_at`) |
| J1.2 | Login com senha errada | mensagem clara "Email ou senha incorretos", sem stack |
| J1.3 | Welcome: termos não aceitos | botão avança desabilitado |
| J1.4 | Welcome: nome da org + timezone salvos | grava `display_name`/`timezone`, avança pro WhatsApp |
| J1.5 | Connect WhatsApp: WAHA ativo → QR aparece | sessão criada, QR renderiza via proxy, poll de status roda |
| J1.6 | Connect WhatsApp: "Pular por enquanto" | avança pro step correto (setup-ai quando Nuvemshop off) |
| J1.7 | Setup IA: criar agente default | `ai_agents` criado, avança |
| J1.8 | Invite team: enviar convite SEM Resend configurado (realidade da VPS fresca) | UI **não mente**: mostra que email não saiu + oferece `accept_url` copiável |
| J1.9 | Done: "Ir para o Inbox" | seta `onboarded_at`, cai no `/app/inbox` |
| J1.10 | Gate MFA pós-onboarding | blocker aparece; enrolar TOTP + ver/salvar recovery codes funciona de ponta a ponta |
| J1.11 | Abandonar no meio e voltar (fecha browser no step 3) | retoma exatamente no step pendente |
| J1.12 | Tentar `/app/inbox` antes de concluir | redirect pro onboarding, sem loop |
| J1.13 | Reabrir `/onboarding` depois de concluído | redirect pro app (wizard não reabre) |
| J1.14 | Stepper com Nuvemshop desabilitado | numeração/etapas não quebram visualmente |

## J2 — Conectar WhatsApp e Central de Conexões `[P0]`

| # | Caso | Expectativa |
|---|------|-------------|
| J2.1 | Central lista a sessão criada no onboarding | card com status coerente |
| J2.2 | Conectar novo WhatsApp (admin) | sessão STARTING → SCAN_QR, QR visível no dialog |
| J2.3 | QR escaneado com celular real (**precisa do Rafael**) | status WORKING, card "Conectado" |
| J2.4 | Reconectar sessão | volta a SCAN_QR/WORKING sem duplicar sessão |
| J2.5 | WAHA derrubado (docker stop) | banner claro, botões desabilitados, 503 amigável |
| J2.6 | Atendente (role agent) não vê botão de conectar | gate admin respeitado na UI |
| J2.7 | AntiBanSheet: editar ritmo/janela/teto | salva, persiste em `channel_knobs`, validação de janela |

## J3 — Agentes de IA `[P0]` (criação) / `[P1]` (rotina)

| # | Caso | Expectativa |
|---|------|-------------|
| J3.1 | Agente default do onboarding aparece em `/app/ai/agents` | lista consistente |
| J3.2 | Criar agente novo pelo builder: draft → publicar | bloqueios de publish EXPLICADOS (credencial, número) |
| J3.3 | Knowledge sources: 4 slots visíveis, status honesto | sem "Em breve" enganoso no caminho principal |
| J3.4 | Mensagem inbound → bot responde (WAHA + AI key real) | resposta chega na conversa, `sent_via='bot'` |
| J3.5 | Bot NÃO responde quando humano assumiu (claim) | guard `assignee_kind='user'` |
| J3.6 | Handoff G1 ("quero falar com humano") | conversa vai pra fila humana, aviso visível |
| J3.7 | AI Gateway key ausente | feedback visível (hoje: skip silencioso — candidato a bug de UX) |
| J3.8 | Central de avisos do agente (sino) | eventos aparecem com copy leiga |
| J3.9 | Propostas do flywheel: aplicar bullet | nova versão publicada, badge atualiza |

## J4 — CRM e Pipelines `[P1]`

| # | Caso | Expectativa |
|---|------|-------------|
| J4.1 | Pipeline default existe pra org nova | Kanban abre com 8 colunas |
| J4.2 | Criar lead manual pelo dialog | card aparece na coluna certa |
| J4.3 | Drag-and-drop entre colunas | posição persiste após reload |
| J4.4 | Ganhar lead (mover pra "Pago") | status won + `closed_at` |
| J4.5 | Perder lead exige motivo | sem motivo → validação clara |
| J4.6 | Filtro por owner | leads coerentes com filtro |
| J4.7 | Bulk: mover/taguear 2+ leads | funciona; automações disparam por lead |
| J4.8 | Timeline do contato mostra atividades do lead | merge contato+leads correto |
| J4.9 | Vocabulário customizado (Pedido/Pago/Cancelado) | UI reflete em todo o kanban |
| J4.10 | Editar config de pipeline como agent | 403 amigável |
| J4.11 | Painel de Evolução → CTA da lacuna de funil | leva a Configurações › Funis, não ao quadro (executado 2026-07-27, manager) |
| J4.12 | Mapear passo do agente → etapa e salvar | persiste no reload e em `crm_stages.agent_stage_hint` (executado 2026-07-27) |
| J4.13 | Etapa já usada por outro passo | some das demais listas; volta ao desfazer (executado 2026-07-27) |
| J4.14 | «Ganho»/«Perdido» num funil sem etapa de fechamento | explica o motivo, não mostra lista vazia (executado 2026-07-27) |
| J4.15 | Lista de funis com o usuário em DUAS organizações | mostra só a org ativa — nunca funis homônimos de outra (executado 2026-08-03; **defeito encontrado e corrigido**) |
| J4.16 | Criar funil pela tela do Kanban | nasce com Novo · Em andamento · Ganho · Perdido, e o quadro abre com as 4 colunas (executado 2026-08-03) |
| J4.17 | Renomear, reordenar (↑↓) e eleger padrão | persiste; o padrão anterior é liberado antes do novo (executado 2026-08-03) |
| J4.18 | Arquivar o funil PADRÃO | recusa explicada: "marque OUTRO funil como padrão antes" (executado 2026-08-03) |
| J4.19 | Arquivar o ÚLTIMO funil ativo | recusa explicada: sem funil não há quadro (executado 2026-08-03) |
| J4.20 | Arquivar funil que é destino de formulário/automação | recusa NOMEANDO a fonte ou a regra (coberto por unit; `webhook_sources` cascateia) |
| J4.21 | Lista de funis como `agent` | vê a lista e abre o quadro, sem nenhum controle de escrita (executado 2026-08-03) |

## J5 — Time: convites e atuação de atendentes `[P0]` (convite) / `[P1]` (rotina)

| # | Caso | Expectativa |
|---|------|-------------|
| J5.1 | Admin convida atendente pela UI (sem Resend) | UI diz a verdade + accept_url copiável |
| J5.2 | Convidado abre link, cria sessão, aceita | vira membro agent, cai no inbox |
| J5.3 | Atendente vê APENAS fila + suas conversas | escopo RLS na prática |
| J5.4 | Atendente dá claim numa conversa da fila | claim ok; 2º atendente levando 409 amigável |
| J5.5 | Transferir conversa pra colega | imediata, contador de não-lidas zera pro novo dono |
| J5.6 | Atendente tenta ver billing/api-tokens | 403 página amigável |
| J5.7 | Revogar atendente | perde acesso na hora (próxima navegação) |
| J5.8 | Revogar último admin | bloqueado com explicação |
| J5.9 | Link de convite expirado/adulterado | tela clara, sem stack |

## J6 — Webhooks: receber, automatizar, provar `[P0]`

| # | Caso | Expectativa |
|---|------|-------------|
| J6.1 | Criar fonte de dados pela UI | URL pública + snippets exibidos |
| J6.2 | "Enviar lead de teste" | toast de sucesso + lead visível no Kanban + feed atualiza |
| J6.3 | POST externo real (curl de "Zapier") | lead entra; feed mostra recebimento; idempotência por external_id |
| J6.4 | HMAC: fonte com secret + assinatura errada | 401; feed marca inválido |
| J6.5 | Criar regra: lead com utm instagram → tag | regra nasce pausada; ativar pelo switch |
| J6.6 | Drain roda → regra executa | tag aplicada; aba Atividade mostra run Sucesso |
| J6.7 | Ação call_webhook → receiver local REAL | payload chega no receiver; envelope sem org_id/cpf |
| J6.8 | call_webhook com URL interna (SSRF) | bloqueado com erro claro |
| J6.9 | Run falho → botão Reenviar | novo run; sucesso após receiver voltar |
| J6.10 | Automação SEM cron configurado | hoje: morre em silêncio — **candidato a bug de produto** |

## J7 — Exploração completa `[P2]`

Andar por TODAS as rotas navegáveis logado como admin e como agent: settings, contacts,
LGPD anonymize, /admin (platform), error pages (403/503/not-found), estados vazios.
Critério: nenhuma tela quebra, nenhum stack trace, nenhum texto de erro cru.

---

## Achados do mapeamento (pré-execução) — candidatos a correção

| ID | Achado | Origem | Severidade |
|----|--------|--------|-----------|
| M1 | `supabase/config.toml` trava `major_version = 15`, mas `baseline.sql` exige PG17 (`GRANT MAINTAIN`) — contribuidor open-source não sobe ambiente local | reproduzido | Alta (DX) |
| M2 | Trilha manual do `docs/deploy-selfhost/README.md` não configura o cron do drain → automações mortas em silêncio | explorer webhooks | Alta |
| M3 | README self-host aponta repo/imagem `deskcommcrm/*`; kit usa `melgarafael/*` | explorer webhooks | Alta |
| M4 | `INVITE_TOKEN_SECRET` ausente → fallback `"dev-fallback"` → convite forjável em VPS mal configurada | explorer CRM/time | Alta (segurança) |
| M5 | AI Gateway key ausente → bot mudo sem NENHUM feedback na UI | explorer IA | Média |
| M6 | Knowledge sources: botões de upload/configurar são stubs "Em breve" | explorer IA | Média |
| M7 | Enviar mensagem com canal não-WORKING fica `queued` silencioso | explorer WhatsApp | Média |
| M8 | Kanban: colisão de fractional index aborta drag sem feedback | explorer CRM | Baixa |
| M9 | Toasts com códigos crus (`db_error`, `invalid_input`) no onboarding | explorer onboarding | Baixa |
| M10 | Onboarding: pular WhatsApp redirecionava hardcoded pro connect-nuvemshop (step oculto quando Nuvemshop off) | execução J1.6 | Alta (travava wizard) |
| M11 | Onboarding: convite sem Resend redirecionava em silêncio, sem dar o accept_url | execução J1.8 | Alta |
| M12 | MFA gate: revalidação do Server Action desmontava o modal e o usuário nunca via os recovery codes | execução J1.10 | Crítica |

## Ordem de execução

1. **Fase A `[P0]` primeira impressão:** J1 completo → J2.1-2.2/2.5-2.6 → J5.1-5.2 → J6.1-6.3.
2. **Fase B rotina:** J4, J5.3-5.9, J6.4-6.9, J3.1-3.3.
3. **Fase C IA viva + WhatsApp real:** J3.4-3.9, J2.3-2.4 (com Rafael no QR).
4. **Fase D exploração:** J7 + edge cases restantes.

## Bugs corrigidos nesta rodada de QA

| Bug | Arquivo | Correção |
|-----|---------|----------|
| M10 | `app/actions/onboarding/skipWhatsapp.ts` | `skipWhatsapp`/`markWhatsappConfigured` redirecionam pro roteador `/onboarding`, não pro step fixo |
| M11 | `app/actions/onboarding/sendOnboardingInvites.ts` + `invite-team/_form.tsx` | retorna `undelivered[]` com accept_url; UI mostra links copiáveis quando email falha |
| M12 | `components/auth/MfaEnrollGate.tsx` + `app/app/layout.tsx` | gate latcha a decisão client-side; revalidação não derruba mais a tela de recovery codes |

---

# Sessão 2026-07-29/30 — instalação do zero na VPS + jornada completa

Ambiente: VPS HostGator (143.95.209.17), domínio `test-crm.vidagamificada.com.br`,
projeto Supabase **novo e virgem** (0 tabelas / 0 usuários / 0 buckets antes de cada
instalação), cache de build do Docker zerado (a VPS realmente compila o worker),
imagem `ghcr.io/melgarafael/deskcommcrm:latest` — a mesma que o comprador recebe.

Duas instalações completas do zero: a primeira para achar defeitos, a segunda
(após todas as correções publicadas na `main`) como prova. Entre elas, o banco
voltou ao estado virgem — correção não foi validada em cima de instalação remendada.

Nome da organização na instalação final: **"Loja do João QA"** — de propósito com
espaço e acento, que era o gatilho do defeito #6.

## Defeitos encontrados e corrigidos

| # | Onde | Defeito | Como foi provado |
|---|---|---|---|
| 1 | `install.sh` | Morria em **silêncio** (exit 2) com connection string errada: o `psql` falhava dentro de `$( )` sob `set -e`+`pipefail` e o `2>/dev/null` engolia a causa | reproduzido colando a senha sem URL-encoding; log terminava num aviso amarelo e o prompt voltava |
| 2 | `install.sh` | Nenhuma validação de URL/anon/service_role/connection string | validadores novos + `test-validators.sh` (19 casos, cada rejeição assere o MOTIVO) |
| 3 | `install.sh` | Impossível corrigir uma resposta errada | `voltar` em qualquer pergunta + tela de conferência editável por número |
| 4 | `install.sh` | `OPENAI_API_KEY` nunca perguntada → RAG e transcrição de áudio desligados em silêncio | `lib/env.ts:181` consome a variável; o `.env` gerado não a tinha |
| 5 | `README` | Nenhum comando de instalação de VPS; o único bloco era o Quickstart de dev | leitura do README publicado |
| 6 | `_common.sh` | Nome com espaço quebrava **os 4 scripts de socorro** (`.env` lido com `source`) | `reset-mfa/reset-password/healthcheck/backup` morriam com `QA: command not found`; após o conserto, exit 0 com o **mesmo** `.env` |
| 7 | `install.sh` | `SENTRY_DSN` documentado mas nunca escrito no `.env`; telemetria sem aviso | grep no `.env` gerado |
| 8 | onboarding WhatsApp | QR expirado = beco sem saída apontando `http://localhost:3030` (inexistente numa VPS), sem retry | sessão foi a `FAILED` ("QR refs attempts ended") e a tela ofereceu só "Pular"/"Já configurei" |
| 9 | `Stepper` | Congelado no passo 1 nas 6 telas: lia `x-pathname`, header que **nada** no projeto escreve (não existe middleware) | após o conserto: `1 Boas-vindas → 2 WhatsApp → 4 IA → 5 Time → 6 Concluído` |
| 10 | 3 formulários de lead | `249.90` gravava **2.499.000 centavos** (R$ 24.990,00), sem aviso | `value_cents` no banco; parser único em `lib/money.ts` + eco na tela |
| 11 | onboarding IA | Agente criado **nunca responderia** (sem versão publicada) e a lista dizia "Publicado" | o JOIN que os dois runtimes usam devolvia 0 linhas; hoje devolve o agente |
| 12 | seed do funil | Etapas "Em separacao" e "Pos-venda" sem acento no quadro principal | migration 0092 + apêndice do baseline |
| 13 | `update.sh` | Atualização interrompida após o `git pull` prendia o CRM na imagem antiga **para sempre** ("já está na versão mais recente") | digest local `273079c8` ≠ remoto `bb402c13` com o git em dia |
| 14 | API Tokens | Impossível emitir token que use **MCP**: faltavam `mcp:read`/`mcp:write`/`role:manager` no catálogo da tela | toda tool respondia "Token missing required scope 'mcp:read'"; hoje token criado pela tela chama as tools |
| 15 | `lib/mcp/audit.ts` | **Nenhuma** ação via MCP era auditada: nome da tool ia para `resource_id` (uuid) e id do token para `actor_user_id` (FK) | log do contêiner + `select count(*) where action='mcp.tool_called'` = 0; hoje grava |
| 16 | `lib/audit/index.ts` | Falha de audit só fazia `console.error` — foi o que manteve #15 invisível | doutrina exige alerta no Sentry |
| 17 | crons de follow-up/snooze | **95% do audit log** era batida de cron vazia (1.175 de 1.236 linhas em ~9h paradas) numa tabela append-only com retenção de 5 anos | contagem por `action` |

## Jornadas exercitadas (instalação final, virgem)

| Jornada | Resultado |
|---|---|
| Instalação `install.sh` do zero, 3 erros propositais + `voltar` + correção pela tela | PASS — cada erro barrado com motivo e receita |
| Instalação limpa do zero (respostas certas) | PASS — ~6 min, exit 0, 7 contêineres, 94 tabelas, 8 modelos de IA, SSL válido |
| Scripts do kit com nome acentuado e com espaço | PASS |
| Login + onboarding 6 passos + MFA (TOTP) | PASS — zero erro de console/HTTP na jornada inteira |
| Varredura de 33 telas autenticadas | PASS — todas com conteúdo, sem 4xx/5xx nem erro de JS |
| Criar lead pela tela, ver no quadro e no banco | PASS |
| Captação por webhook → lead + contato + `event_log` drenado pelo cron | PASS |
| Criar fluxo de follow-up e tentar publicar incompleto | PASS — publicação **recusada** com os nós inalcançáveis destacados |
| MCP: `tools/list` (16 tools), leitura, escrita, RBAC por papel | PASS |
| Auditoria das ações MCP | PASS (após #15/#16) |
| `update.sh` com imagem atrasada | PASS (após #13) |
| **Conectar WhatsApp por QR code** | **PENDENTE** — depende de escanear com o celular do dono |

## Aberto para decisão do dono

- `channel_session.status_changed` é emitido por trigger e **não tem consumidor**
  (anti-pattern nº 3 do `CLAUDE.md`): as linhas ficam `pending` para sempre. Ou
  alguém passa a escutar, ou o trigger sai. Não inventei consumidor.
- Tela de Conexões diz "1 número conectado" mesmo com o número **caído** (conta
  sessões, não conectados).
- O autenticador registra o nome fixo "DeskcommCRM", ignorando o `APP_NAME` que o
  instalador vende como marca de toda a interface.
- `CLAUDE.md` documenta bearer `tok_...`; o token real nasce com prefixo `dsk_`.

## Segurança — achados após conectar o WhatsApp real (2026-07-30)

| # | Defeito | Como foi provado | Correção |
|---|---|---|---|
| 18 | 🔴 **Webhook do WAHA aceitava qualquer um.** `POST /api/v1/webhooks/waha` sem assinatura e com HMAC de zeros → `200 {"accepted":true}`, mensagem gravada no banco, contato criado e **o agente respondeu para o número escolhido pelo atacante** | `curl` de fora, e `select` no banco mostrando `external_id` "falso"/"falso2" | fail-closed em `lib/waha/webhook-auth.ts` (as duas rotas) + Caddy deixa de publicar a rota global |
| 18b | 🔴 Causa: **fail-open por construção** — `hmacSkipped = true` quando o segredo não podia ser obtido. E as duas rotas que criam sessão gravam `webhook_secret_encrypted: Buffer.from([0])`, então era o estado **permanente** de toda instalação | leitura das duas rotas + `WAHA_HMAC_SECRET` ausente de `lib/env.ts` | segredo declarado no env; sem segredo para conferir, assinatura presente é rejeitada |
| 18c | 🟠 **O log mentia sobre a própria verificação**: `valid_signature: validSignature \|\| hmacSkipped` gravava "assinatura válida" em evento sem assinatura nenhuma | todos os eventos reais no banco com `valid_signature = t` e `signature_header` nulo | grava a verdade; hoje `f` com header nulo |
| 18d | 🟡 Auditoria da rejeição usava `nuvemshop.webhook_invalid_signature` para evento do WAHA | leitura do código | usa `webhook.hmac_invalid`, que já existia |
| 19 | 🟠 **A regra de bloqueio no Caddy não valia**: fora de um bloco `route`, o Caddy reordena e `respond` vem depois de `reverse_proxy` — o catch-all atendia primeiro | após o deploy, o POST sem assinatura ainda respondia 200 | `route { }` para valer a ordem escrita |
| 20 | 🔴 **Mudança no Caddyfile nunca chegava em quem já instalou.** Bind mount de um arquivo fica preso ao inode; `git pull` cria inode novo e o contêiner segue lendo o antigo | inode 3283869 no host x 3271833 no contêiner, com conteúdo velho, depois de um `update.sh` que disse "concluída" | `update.sh` recria o contêiner do proxy |

**Nota de método:** medi o que o WAHA realmente envia **antes** de escrever o conserto. Os eventos reais chegam **sem assinatura** (2026.7.2 CORE não assina, mesmo com `WHATSAPP_HOOK_HMAC` no contêiner) — o único evento com header no log era a minha própria injeção. Passar a exigir assinatura por padrão derrubaria a ingestão de mensagens de todo mundo: por isso a defesa padrão é de rede, e a exigência de assinatura fica atrás de `WAHA_WEBHOOK_REQUIRE_SIGNATURE` para quem roda WAHA Plus.

**Efeito colateral no mundo real, registrado:** ao conectar o WhatsApp **pessoal** do dono, o agente começou a responder contatos reais (4 respostas automáticas para 2 pessoas) assinando "assistente virtual da loja". O agente foi despublicado. Recomendação: testar agente com número descartável, e avaliar um modo "só observa" para primeira conexão.

## IA com WhatsApp real conectado (2026-07-30)

**O que ficou provado funcionando:** mensagem real chega → conversa e contato criados → agente responde no WhatsApp. Sete conversas reais ingeridas; o agente respondeu a duas pessoas com texto contextual e coerente. A ingestão e o ciclo responder-no-WhatsApp **funcionam**.

| # | Achado | Estado |
|---|---|---|
| 21 | 🔴 **RAG do tenant não existe na prática.** O botão "Configurar" das 4 fontes é stub `disabled` com um toast "Em breve" que, por estar desabilitado, nunca aparece. Criando a fonte pela API (que funciona, 201), o "Re-indexar" não produz nada: o handler de `knowledge_source.updated` é stub declarado (S-06.05/06/07); só `nuvemshop.product_synced` indexa de verdade — e a Nuvemshop vem desligada no kit | tela passa a dizer a verdade; **indexação não implementada de propósito** (multi-fonte exige decisão de arquitetura: o agente busca por UMA versão ativa) |
| 22 | 🟠 **Agente pausado continua gastando.** Despublicar não impede o motor de enfileirar e executar turnos: ele chama o LLM, descobre depois que não há agente publicado e falha, retentando. Medido: **90 chamadas ao LLM e 65 turnos falhos** | **corrigido** (achado 24) — a causa não era o pause — o modelo é resolvido em vários pontos do turno e um palpite no caminho que gasta dinheiro é pior que o defeito |
| 23 | 🟡 `ai_agent_runs` e `ai_invocations` **vazias** apesar de respostas reais terem saído — as telas de Uso e Evolução da IA não têm dado para mostrar | aberto |

**Correção de rumo registrada:** as falhas "modelo LLM não definido" das 17:03 foram **consequência do meu pause**, não defeito do produto — a cadeia de fallback do modelo depende do agente publicado (`inbound-turn.ts:686`). Quase reportei como P0 de instalação nova; a leitura do código desmentiu. O que sobrou de verdadeiro é o achado 22, que é outro e menor.

**Efeito colateral no mundo real:** o agente respondeu contatos pessoais do dono assinando "assistente virtual da loja". Testar agente em número pessoal precisa de um aviso explícito no produto, ou de um modo "só observa" na primeira conexão.

## Correções de rumo desta sessão (registradas de propósito)

| O que eu afirmei | O que era verdade |
|---|---|
| "As falhas do turno são consequência do meu pause do agente" | **Errado.** Com o agente publicado o turno falhava igual. A causa era outra: roteador sem membros → caminho genérico → `organizations.settings.llm.default_model` que ninguém preenche (achado 24) |
| "Nada na interface avisava que o agente parou" | **Errado.** O Inbox da IA mostrava **16 alertas críticos** "Job descartado após esgotar tentativas" — o mecanismo anti-morte funcionou. O que faltava era o alerta dizer o MOTIVO, que ele descartava (achado 25) |

| # | Achado | Estado |
|---|---|---|
| 24 | 🔴 **Roteador de intenção sem membros derrubava TODAS as respostas.** A tela permite criar; o turno cai no caminho genérico (decisão de produto: "não é silêncio") e o genérico não tem modelo, porque `settings.llm.default_model` não é preenchido por ninguém e não tem tela. Medido: 80 chamadas de classificador em retry, zero respostas | corrigido — migration 0096 semeia o modelo em toda org, nova e existente. Provado com o MESMO job que falhava: passou a concluir e entregou a resposta |
| 25 | 🟠 O alerta de job morto trazia só `kind=...; attempts=5` e **descartava o erro** que o causou | corrigido — o motivo vai no corpo do alerta |
| 26 | 🟡 Custo de IA: a tela lia `ai_invocations` (workers legados) e o runtime grava em `llm_calls` — mostrava R$ 0,00 com dinheiro saindo | corrigido |
| 27 | 🟠 O gatilho do orçamento só existia em `ai_invocations`: alarme de 80% e pausa em 100% nunca disparariam | corrigido — migration 0095 |

## Jornadas concluídas nesta rodada autônoma

| Jornada | Resultado |
|---|---|
| **Handoff IA→humano** (via MCP) | PASS — conversa vai a `pending`, **bot silenciado**, motivo gravado, fila com posição, `ai.handoff_triggered` no audit E no event_log (consumido) |
| **Follow-up: criar, montar grafo e publicar** | PASS — e a validação **recusou** o grafo inválido com a regra de negócio certa: *"nó acumula ≥24h de espera e precisa de fallback_template_id"* (política de 24h do WhatsApp). Com o template ligado, publicou: fluxo `active` com versão ativa |
| **Contatos e Templates (criar pela tela)** | PASS — persistem e aparecem sem recarregar |
| **Equipe, LGPD, Radar, Desempenho, Casos, Memória, Skills** | PASS — renderizam com conteúdo, sem 4xx/5xx nem erro de JS |
| **Turno completo do agente** | PASS após o achado 24 — as 6 etapas do pipeline rodam (`intent_router`, `agent_turn`, `stage_classifier`, `jailbreak_detect`, `promise_semantic`, `checkpoint`) e a resposta é entregue |
| **Transcrição de áudio** | **PENDENTE** — exige alguém enviar um áudio ao número; é a única coisa que não consigo produzir sozinho |

| # | Achado | Estado |
|---|---|---|
| 28 | 🟠 **CI vermelho por lentidão, não por defeito.** O teste que abre processo filho (`npx tsx`) leva ~5s e o timeout padrão do vitest é 5s — derrubou a `main` num PR que só mexia em documentação | corrigido — timeout explícito de 60s; 3 rodadas seguidas verdes. O controle positivo continua provando o aparato |

**Nota de ambiente:** o `.env` da VPS foi apontado para `ghcr.io/...:latest` durante o QA, porque o fluxo de release novo fixa a imagem numa tag (`1.1.0`) e as correções desta sessão estão à frente dela. Para voltar ao comportamento de release, basta repor `APP_IMAGE` com a tag desejada.

## RAG do tenant — implementado e provado (2026-07-30)

Autorizado pelo dono, o RAG saiu do stub. **Cinco defeitos encadeados**: cada
conserto revelava o próximo, e nenhum aparecia sem rodar de verdade.

| # | Defeito | Como apareceu |
|---|---|---|
| 29 | Handler de `knowledge_source.updated` era stub declarado | só `nuvemshop.product_synced` indexava — e a Nuvemshop vem desligada |
| 30 | `ON CONFLICT` apontava para constraint **inexistente** | *"there is no unique or exclusion constraint matching"* — TODO chunk falhava. **O mesmo alvo errado estava no caminho de produto**: o RAG nunca gravou um chunk, para nenhuma fonte |
| 31 | `token_count` é NOT NULL e ninguém preenchia | *"null value in column token_count"* |
| 32 | 🔴 Versão **vazia** era marcada `ready` e **ativada** | numa instalação com base funcionando, uma indexação com problema trocaria a base boa por uma vazia — o agente perderia o RAG em silêncio |
| 33 | Fonte tipo `policy` era criada **vazia**, conteúdo descartado | a rota só tratava `source_type === "faq"`; política enviada com markdown voltava 201 com o conteúdo no lixo |
| 34 | 🔴 Limiar padrão **0.72** descartava toda paráfrase | medido: relevante 0.49–0.85, irrelevante 0.27. Só a pergunta **literal** passava — o RAG parecia quebrado funcionando bem |

**Decisão de arquitetura tomada** (a que faltava para destravar): a reindexação
**reconstrói UMA versão com TODAS as fontes**, em vez de uma versão por fonte —
a busca recebe um único `kb_version_id` e o agente aponta para uma única versão
ativa; uma versão por fonte faria o FAQ desativar o catálogo e vice-versa.

**Prova final, medida:** FAQ (4 itens) + Política (2 itens) → versão 5 com 6
chunks, ativa. Busca atravessando as duas fontes:

| Pergunta | Acerto | Semelhança |
|---|---|---|
| "quanto tempo demora pra chegar em BH?" | FAQ — prazo BH | 0.653 |
| "e se eu quiser devolver o produto?" | Política — devolução | 0.649 |
| "tem garantia?" | Política — garantia | 0.690 |
| "aceita pix?" | FAQ — pagamento | 0.490 |

E a tela ganhou o cadastro que faltava: o botão "Configurar" era stub `disabled`
com um toast que nunca aparecia.

## Áudio do WhatsApp

| # | Defeito | Estado |
|---|---|---|
| 35 | 🔴 **A transcrição mandava a chave da Anthropic para a OpenAI.** O Whisper é da OpenAI, mas recebia `llm.apiKey` (provedor de chat da org) → `transcription_401` em toda tentativa, com a `OPENAI_API_KEY` certa no `.env` | corrigido — fallback de ambiente para OpenAI, simétrico ao que a Anthropic já tinha |
| 36 | 🟠 **O agente responde ANTES de a mídia ser derivada** — dispatch às 20:24:22, derivação pedida às 20:25:03 | **aberto**: é ordenação de pipeline, não conserto pontual |

Prova: áudio real recebido (`type: audio`), agente respondeu *"não consigo ouvi-lo"*.
Com o 35 corrigido a transcrição passa a rodar; o 36 faz a PRIMEIRA resposta
ainda sair antes dela.

## Áudio: cadeia fechada (2026-07-31)

| # | Defeito | Prova |
|---|---|---|
| 35 | A transcrição mandava a **chave da Anthropic para a OpenAI** (`transcription_401`) | mesmo áudio: antes *"não consigo ouvi-lo"*; depois transcrito (`"Oi!"`) e o agente respondeu ao conteúdo |
| 36 | O turno era despachado **antes** de a mídia virar texto | log ao vivo: `drain: mídia ainda sendo transcrita — turno adiado (tipo: audio, esperando_ha_ms: 708)` |
| 37 | 🔴 **Regressão minha**: o alerta de job morto referenciava `last_error` numa CTE que não o devolvia — e como esse reap roda no BOOT, **o worker parou de subir** | worker em loop de reinício; corrigido e validado executando a query INTEIRA contra o banco (em transação com rollback) |
| 38 | Timeout padrão de 5s por teste reprovava teste saudável em máquina carregada | 3 falsos vermelhos locais em testes diferentes + 1 CI vermelho num PR de documentação; com 15s, 1473 testes verdes sob a mesma carga |

**Erro de método registrado (nº 37):** validei a expressão SQL nova contra linhas
reais, mas **isolada** — não dentro da CTE onde ela ia viver. Testei a peça, não
a montagem, e a peça passou. Mudança dentro de string SQL agora se prova
executando a query inteira.

## Agente pausado que continuava gastando (2026-07-31)

**Achado nº 39 — dinheiro indo pro ralo com o agente desligado.** Pausar o agente
pela tela tirava a resposta do lead, mas **não** tirava o gasto: o drain
enfileirava o turno assim mesmo, o worker resolvia credencial, chamava o LLM e só
então descobria que não havia ninguém publicado para atender. O usuário via
"pausado" e continuava pagando por token.

**A guarda.** `lib/agent-engine/edge/crm/drain.ts` agora pergunta ao banco, **antes
de enfileirar** (portanto antes de qualquer gasto), se existe alguém que pode
atender aquela sessão: agente com versão `published` ligada à sessão, **ou**
roteador ativo com fallback/membros. Não havendo nenhum dos dois, o turno é
pulado com log explícito (`nenhum agente publicado para a sessão — turno pulado
(sem gasto)`) e o evento fecha como processado — não fica reciclando na fila.

**Medida na VPS, com contador de chamadas de LLM (`llm_calls`).** Primeira
tentativa foi **teste confundido**: caiu na conversa que eu mesmo havia posto em
atendimento humano, e o log disse "turno pulado — lead em handoff humano", que é
outra guarda. Refiz com um contato sintético (`QA Sintetico`, número inexistente,
para o envio falhar sem incomodar ninguém):

| Estado do agente | `llm_calls` antes → depois | Resposta ao lead |
|---|---|---|
| pausado | 221 → **221** | nenhuma |
| republicado | 221 → **227** | respondeu |

Mesma mensagem, mesmo contato, só o estado do agente mudando — a diferença é do
efeito, não do cenário.

**Cobertura.** `drain.test.ts` ganhou 3 casos de capacidade (nenhum dos dois →
pula; agente publicado → despacha; roteador com membro → despacha). Sabotada a
guarda, ficam vermelhos.

**Custo colateral, e a lição.** A guarda deixou vermelho o invariante
`agent-dispatch-single-consumer`: o fixture dele nunca teve agente publicado,
então o drain passou a pular — corretamente. O CI pegou, que é o trabalho dele. O
fixture passou a criar o agente publicado: a premissa "existe alguém que pode
atender" sempre esteve implícita ali, e a guarda apenas a tornou observável. A
edição de invariante é congelada por hook; usei a válvula
`DESKCOMM_GOV_INVARIANTS_EDIT=1` **declarando o uso no commit** (`685d6e7`) em vez
de contornar em silêncio. CI verde em `2c045c4` (invariants, verify, e2e,
build-and-size, build-and-push).
