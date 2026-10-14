# Agente interno de configuração e rotina — design

- Data: 2026-10-14
- Base medida: `origin/main` @ `0c05ca348`, worktree `feat/agente-interno-config` sem código alterado (só estes 2 docs, untracked — "limpa" seria falso afirmar)
- Destino (DoD 18): **núcleo** — exige execução de código, leitura de dados do tenant, ferramentas de IA e cadeia de auditoria; pacote declarativo não comporta (lei em `docs/doctrine/extensoes.md`: régua em `:26`, "núcleo útil com zero extensões" em `:29-30`, pacote "não importa código interno nem lê o banco" em `:56-63`, lista fechada ADR-0003 em `:59`, `:90`). Sem nenhuma organização usar, a operação comum continua inteira — e ainda assim é núcleo, porque identidade, isolamento, auditoria e RBAC dependem disto.
- Issues relacionadas: #1941 (assistente de configuração — proposta OPEN de `Fabricio-Point-Machine`; nenhum PR vinculado verificado), #1995 (Blueprints — OPEN de `tec7alex`), #1410/Discussion #1411 (chat interno, F4 = IA na thread — OPEN de `webtecnica`, sem código), #1869 (acervo à superfície — OPEN), #2147 (MCP externo — OPEN de `brunno-soaress`), #2004 (criar agente pelo MCP perde follow-up — OPEN de `melgarafael`), #1833/#2390/#1750 (relatórios por etiqueta/canal/funil — OPEN).

## 1. Intenção e porquê

Donos de operação configuram o CRM em várias telas e precisam conhecer conceitos internos (pipeline, router, RAG, follow-up flow) antes do primeiro valor (relato do autor, não medido). O onboarding em wizard cobre a primeira entrada; depois dele, montar agente por segmento, criar follow-ups, ler relatórios e afinar prompt continuam manuais. A casa já escreveu o *conteúdo* desse trabalho nas skills `.agents/skills/` (cliente-novo, metricas, prompt, operacao, doutrina) — mas elas só servem a agentes externos de código (Claude Code e afins). A intenção é um **chat dentro do CRM** onde o usuário pede em linguagem natural ("monta o agente da minha clínica", "por que a conversão caiu?") e um agente interno executa: lendo estado e métricas, propondo configuração como diff visível, aplicando só com aprovação humana e auditando tudo.

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos.**
1. Responder relatórios e dúvidas de rotina dentro do CRM, com os mesmos números das telas (nunca PII crua).
2. Executar a skill cliente-novo por conversa: triagem → pacote do nicho → rascunhos (agente, follow-ups, roteador, memória, conhecimento) → teste sandbox → publish como ato humano.
3. Afinar agente que não performa (skill prompt) propondo edição de versão, sem publicar sozinho.
4. Auditar o tenant em modo contínuo (#1941): PREENCHIDO / POSSO COMPLETAR / PRECISO CONFIRMAR / NÃO SE APLICA, com dependências explícitas ("falta conectar WhatsApp para ativar").
5. Cada efeito executivo passa pela mesma camada de domínio das telas, com `audit()` e RBAC. Nenhuma escrita direta em tabela de negócio via SQL pelo agente.

**Não-objetivos (fora deste design).**
- Widget/chat no site (#1333, OPEN de `webtecnica`), MCP externo (#2147), canais de equipe/DM (F2/F3 da #1411), Blueprints reutilizáveis entre orgs (#1995 — compatível, não incluído), substituir o wizard de onboarding (ele continua).

**Anti-objetivos (se acontecer, a feature falhou mesmo funcionando).**
- Agente publicando agente, credencial ou exclusão sem clique humano.
- Proposta aplicada em organização errada (org do body em vez da sessão/token).
- Número do chat divergindo da tela para a mesma pergunta.
- Log, prompt ou tool lendo/escrevendo PII de terceiros (telefone, e-mail, CPF, corpo de mensagem).
- Mensagem/configuração interna alcançando canal do cliente.

## 3. Restrições (doutrina aplicável, medida na base)

- **Multi-tenancy:** toda tabela nova leva `organization_id uuid not null` + RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()`; service role filtra org manualmente de fonte confiável (cookie/JWT/token `dsk_…`), nunca do body; backend sempre `getUser()`, nunca `getSession()`.
- **Schema em tripla:** migration versionada com `-- manifest:` + apêndice idempotente em `supabase/baseline.sql` (o que o self-host aplica — DoD item 11, `CLAUDE.md:727`). Nunca editar migration aplicada. Função nova em `public`: o teste `hardening-definer-varredura` exige `revoke execute ... from anon` na migration **e** no apêndice (`:362-364`), sem exceção. Não ler o baseline por `grep` no arquivo inteiro — vale a última definição.
- **Resposta de API:** sempre `ok()`/`fail()` de `lib/api/wrappers.ts` (com `X-Request-Id`); erro com código de `lib/api/errors.ts`; nunca `throw` cru na borda; Zod em todo input externo.
- **Mutação relevante:** `audit()` fire-and-forget em `api_audit_log` + superfície visível na tela (invariante 3 do sistema-vivo).
- **DoD 12 (QA visual + prova-em-par):** todo aceite que atravessa o agente vem em par — tela pelo agente + ferramenta chamada direto, mesmo texto cru — e só conta quando concordam (`docs/doctrine/prova-em-par.md`). Evidência visual em ambiente fresco estilo VPS.
- **DoD 13/14:** Living System Checklist respondido com artefatos concretos (§8); tela nova com porta em `lib/navigation/catalogo.ts` (`NAV_CATALOG`), grupos de configuração e observabilidade separados.
- **DoD 15/17/18:** nenhum serviço novo no compose (só `image:` publicada); sem env nova sem default; fragmento `.changes/` com efeito no operador (`capacidade_nova`); destino declarado (núcleo, ver cabeçalho).
- **i18n PT+ES**, sem chave crua. **LGPD:** sem PII em logs/prompts; definir retenção das threads antes de codar.

## 4. O que já existe (CONFIRMADO na base — paths verificados)

**Runtime do agente (reuso direto).**
- `lib/agent-engine/agent/inbound-turn.ts:1825` `runAgentTurn`; `:318` `AGENT_TOOL_DEFS` (12 tools, incl. `read_skill_reference:475`, `request_human_handoff:431`). Caminho canônico é `lib/agent-engine` (`lib/ai/dispatcher` está `@deprecated`).
- `lib/agent-engine/agent/operator-turn.ts:332` `createOperatorTurnHandler` — papel Operador: opera o CRM via `maoDoOperador`/`operator_tool_ids`, **sem** `send_message`; `registrarDesfecho:720`.
- `lib/agent-engine/agent/skills.ts` — `MAX_SKILL_BODY_LINES=200`, `skillMatcherSchema`, `insertSkillVersion()`, `setSkillPointer()`, `loadSkills()`, `renderSkillIndex()`, `matchSkills()` determinístico; índice no prompt via `composeSystemPrompt` (`org-memory.ts:52`, chamado em `inbound-turn.ts:2433`).
- `lib/agent-engine/agent/sandbox.ts:5` `testAgentVersion` (teste de versão, `kind:"sandbox"`).
- `lib/ai/gateway.ts:68` `resolveLanguageModel` (gateway → OpenRouter → Anthropic/OpenAI).
- `hooks/realtime/useRealtimeChannel.ts:52` (assina `postgres_changes` em `:172-173`, `broadcast` em `:183`).

**Domínio de configuração (o agente chama, nunca SQL direto).**
- Agentes: `POST app/api/v1/ai/agents/route.ts` (`role: admin`, `requireSupportWrite`, cria rascunho `kind='mcp_agent'` v1 `draft` via `mcpAgentDraftRecords`/`createMcpAgentDraft` em `lib/ai/agents/create-draft.ts`); `POST .../[id]/publish` (`role: admin`, `scope: config:write`) via `publishAgentVersion` (`lib/ai/agents/publish.ts`); schemas em `lib/ai/agents/validation.ts:283/300`.
- Follow-ups: `POST .../ai/followup-flows/from-model` (`role: manager`, **só rascunho**); modelos em `lib/followup/modelos/index.ts` (`modeloPorId`, `modelosDoNicho`); publish via `publishFollowupFlowVersion` (`lib/followup/publish.ts`).
- Roteadores: `POST .../ai/routers` (`role: admin`, `audit ai.router_created`); membros só por `PUT .../[id]/members` (`role: admin`, substitui lista inteira).
- Conhecimento/memória/credenciais/skills: `POST knowledge/sources` (`manager`), `POST memory` (`admin`, leitura `agent`), `POST credentials` (`admin`), `GET skills` (`agent`).
- **NÃO existe** `app/api/v1/ai/pipelines/**` — a leitura do funil passa pelo domínio próprio `app/api/v1/pipelines/**` (lista, board, stages, agent-mapping, win-rates), coberta no §8.
- Settings da org: `app/actions/settings/updateTenant.ts` (gate `supportWriteError` + `podeAdministrarEmpresa` + `audit org.updated`) e ~30 actions irmãs; schemas em `lib/schemas/settings.ts`.

**Leitura (números do chat).**
- Métricas: `metrics/{attendants,atrito,funil}` (`GET role: agent`), `metrics/lost` (`manager`); relatórios `reports/{activities,financeiro,tags}` (`GET role: viewer`); `ai/{usage,evolution,operator-metrics}` (`manager`). Doutrina de leitura correta na skill `deskcomm-metricas` (agregados, nunca PII).
- MCP: `lib/mcp/tools/index.ts:101` `allTools` (~72: 41 leitura + 30 escrita + handoff); tetos em `lib/mcp/rate-limit.ts` (60/token, 600/org, 30 escritas/60s) + `tetoDeEscritaDoToken` (`lib/api/auth-dual.ts:166`).

**Conhecimento (skills em disco, 9 pastas em `.agents/skills/`):** cliente-novo, metricas, prompt, operacao, doutrina, extensao, contribuir, instalar, sistema-vivo. **Ausente em `origin/main`:** `deskcomm-ajuda-configurar` (não verificado onde existe — a spec não depende dela) e qualquer rota/chat/action `internal-agent|copilot|config-assistant` (grep vazio em `app/`+`lib/` — nada implementado).

## 5. Desenho (decidido nesta spec)

**Modelo do turno (decisão do dono, 2026-10-14).** O assistente é um **ponto próprio PROPOSTO** no registro único `PONTOS_DE_IA` (`lib/ai/pontos/registro.ts:191`, cobrado por `pontos-de-ia-completude.test.ts`), com seletor individual na tela Provedores como os demais pontos — e herda o padrão da org (`organizations.settings.llm`, `resolver.ts:521-529`) quando não configurado. **Jev:** no código atual o Jev é cascata de handoff/opt-out (`lib/ai/decisao/pedidos.ts:1-80`), não triagem de intenção — usar o Jev para triar (relatório × configuração × dúvida) e escolher tier (econômico p/ leitura, forte p/ proposta) é **pedido novo PROPOSTO**, no molde de "Escolher qual agente atende", não reuso de comportamento existente.

**Papel novo no engine, sem `send_message`.** `lib/agent-engine/agent/config-turn.ts` (novo handler, espelhado no operador): turno autenticado por sessão da org, `CONFIG_TOOL_DEFS` só de leitura e proposta — `ler_metrica`, `ler_estado_org`, `buscar_conhecimento_operacional`, `propor_agente`, `propor_followup`, `propor_roteador`, `propor_memoria`, `propor_settings`. Proposta vira linha em `config_proposals` (status `pendente`); **aplicar** acontece só em rota própria com guard humano (§6). Nenhuma tool escreve tabela de negócio. **Granularidade (decisão do dono, 2026-10-14): 1 proposta = 1 artefato** (só o agente, só o follow-up, só o roteador…); **propor não cria rascunho nem efeito colateral** — o rascunho nasce no `aplicar`, depois do aprovar.

**Skills de runtime, não markdown solto.** O conteúdo operacional de cliente-novo/metricas/prompt/operacao é portado para `skill_versions` (corpo ≤200 linhas cada, matcher `any_keywords`), carregado por `matchSkills` + `read_skill_reference` como as skills situacionais de hoje. **Decisão:** a doutrina NÃO vira skill do agente — o `SKILL.md` dela proíbe confiar em resumo congelado (`.agents/skills/deskcomm-doutrina/SKILL.md:21-22`; fonte = `CLAUDE.md` de `origin/main`) e suas regras vivem melhor como guards em código do que como prompt.

**Classificação de risco antes de propor** (#1941): `seguro` (textos, descrições, tags, memória), `atencao` (funis, etapas, motivos, automações, follow-ups, comportamento de agentes — revisão antes de gravar), `critico` (usuários/permissões, credenciais, canais, billing, webhooks externos, secrets, exclusões — checkpoint humano obrigatório + nunca preenchido pela IA).

**Schema novo (1 migração + apêndice baseline + `-- manifest:`).**
- `config_threads` (`organization_id`, `kind`, `created_by`, `last_message_at`), `config_messages` (`thread_id`, `author`, `body`, `created_at`), `config_proposals` (`thread_id`, `kind`, `payload jsonb`, `risk`, `status`, `applied_by`, `applied_at`), `config_snapshots` (`organization_id`, `taken_at`, `resultado jsonb`, `pendencias int`). RLS por org + invariantes de teste (cross-tenant, proposta nunca aplicada sem aprovação — sabotagem obrigatória).

**Rotas novas (receita de route handler, §3).**
- `POST app/api/v1/assistente/chat` (resposta simples sem stream na F1; `requireRole("agent")`; tetos próprios usuário/org/dia a implementar no chat — molde: `app/api/v1/ai/cases/[id]/chat/route.ts`, a confirmar no plano — porque pela sessão-cookie não há teto nativo, `lib/api/auth-dual.ts:160-161`) e `GET` histórico.
- `GET .../assistente/propostas`; `POST .../assistente/propostas/[id]/{aprovar,aplicar,rejeitar}` — pedir proposta de escrita, aprovar e aplicar: **somente `admin`** (decisão do dono, 2026-10-14; sem "onde couber"). Toda aplicação com `requireSupportWrite` + `audit()`.
- Nada aqui entra em `lib/auth/public-paths.ts` (todas exigem sessão; DoD 6 n/a, valem os tetos de token/org).

**Tela nova com porta.** `app/app/assistente/page.tsx` (chat + painel de propostas/diff + estado da auditoria do tenant), entrada em `NAV_CATALOG` (grupo próprio; sidebar a decidir no plano — hub só a partir de 5 telas), realtime via `useRealtimeChannel`, PT+ES.

**Fatias (cada uma mergeável, DoD cheia por fatia).**
- **F1 — chat de leitura:** tabelas threads/messages + chat read-only (relatórios via rotas de leitura + dúvidas operacionais via skills portadas). Nenhuma escrita além do histórico do chat.
- **F2 — propostas com aprovação:** tabela proposals + rotas aprovar/aplicar/rejeitar + execução cliente-novo (agente rascunho → from-model → publish → router PUT → sandbox → publish humano).
- **F3 — auditoria do tenant:** snapshot PREENCHIDO/POSSO COMPLETAR/PRECISO CONFIRMAR/NÃO SE APLICA + dependências explícitas (ex.: "falta WhatsApp WORKING para ativar"). **Retrato guardado** (decisão do dono, 2026-10-14): cada rodada salva linha em `config_snapshots`, e a tela mostra evolução ("ontem faltavam 5, hoje 3").
- **F4 — laço de retorno (invariante 7):** telemetria de propostas (aprovação/aplicação/arrependimento) consumida no `/app/ai/evolution`; `quando o agente configura errado, o que muda nele` respondido com artefato, não com log.

## 6. Guardrails inegociáveis (viram testes)

1. `organization_id` sempre da sessão/token; teste cross-tenant por tabela nova.
2. Nenhum caminho de escrita lê proposta com status ≠ `aprovada`; teste de sabotagem tenta aplicar `pendente` e reprova.
3. `publish` de agente e credenciais só por clique humano (a skill cliente-novo já exige; #2004 lembra o custo de atalho).
4. Orçamento de IA por org/usuário/dia + tetos MCP; sem eles o chat é cheque em branco.
5. Paridade agente×ferramenta (prova-em-par) em todo aceite; divergência = medir o modelo, não o produto.
6. PII nunca em log/prompt/tool; teste varre payload das tools novas como `branding.test.ts` varre marca.

## 7. Living System Checklist (respostas com artefato concreto)

- **Quem me alimenta?** Sessão da org + tabelas de domínio (leitura) + `skill_versions` (conhecimento) + rotas de métricas.
- **Quem eu alimento?** Rascunhos de agente/follow-up/roteador/memória (via handlers), `api_audit_log`, fila de aprovação humana, `/app/ai/evolution` (F4).
- **Que atividade/log emito?** `audit()` por mutação + `config_proposals.status` como timeline na tela do chat.
- **Onde apareço na tela?** `/app/assistente` (chat + diff de propostas + auditoria do tenant).
- **Por qual porta?** `NAV_CATALOG` (+ `navegacao-completude.test.ts` verde).
- **Anti-morte?** Proposta `pendente` sem decisão vira item visível com responsável e expiração — nunca some em silêncio; chat sem resposta tem próximo passo (F1: sugerir reformulação ou chamar humano).
- **Onde se configura o que uso?** Tetos/orçamento em tela de IA existente; skills via telas de skills existentes; o que faltar vira item da auditoria (F3), nunca `return` mudo.
- **Continuidade IA↔humano?** IA→humano: proposta com diff + motivo + evidência; humano→IA: aprovação/rejeição com motivo vira input estruturado (F4).
- **Laço de retorno?** F4: taxa de aprovação/aplicação/arrependimento por kind de proposta alimenta evolution e o matcher das skills.
- **Mapa vivo?** `docs/architecture/*.json` com ≥2 arestas antes do merge (sem "re-render com archify" — doutrina em `sistema-vivo.md:131`; só `agent-turn.workflow.json` valida segundo ela).

## 7b. Decisões do autor (pós builder-check — chamadas minhas, revise)

- **Estados da proposta:** `pendente → aprovada → aplicada`, mais `rejeitada` e `expirada`. `aprovar` nunca executa efeito; `aplicar` exige status `aprovada` (guard na rota + teste de sabotagem aplicando `pendente`).
- **Allowlist de leitura:** o turno só lê pelos caminhos do §4 (rotas de métricas/relatórios/uso + buscas de conhecimento existentes), sob a regra da skill metricas — agregados, nunca `messages.body` nem PII. Corpo de conversa não entra em prompt/tool/log.
- **Risco `critico` sem tool:** não existe `propor_*` para credenciais, canais, billing, usuários/permissões, secrets ou exclusões. Crítico vira item "PRECISO CONFIRMAR" da auditoria (F3), com link para a tela onde o humano resolve.
- **Identidade do turno:** client de sessão (vale RLS + papel do usuário). Service role é proibido dentro do turno; só nas rotas de aplicar, com filtro manual de `organization_id` da fonte confiável.
- **Decisões do dono (2026-10-14):** 1 proposta = 1 artefato, nada criado antes do aprovar; escrita/aprovação/aplicação somente `admin`, dúvidas e leitura para qualquer usuário; auditoria F3 guarda retrato em `config_snapshots` com evolução na tela.

## 9. Impacto medido (2026-10-14, contra `origin/main` — DoD 16)

**Schema (números, não estimativas).** Próxima migration livre: **0655** (maiores em uso: 0654, 0652, 0649, 0648, 0646; prefixo de timestamp > `20261014000001`; padrão `TIMESTAMP_NNNN_slug.sql`). Colisão: `pnpm checar:colisao-de-migration` + hook `check-migration-triple.sh` (cobra tripla + `-- manifest:`). RLS canônica: migration `0067_org_memory.sql` (policy única `tenant_isolation_%s_all FOR ALL` via `fn_user_org_ids()`); padrão recente `0626` (select p/ authenticated, escrita só service_role + função `security invoker`, `set search_path = ''`). Tabelas-alvo CONFIRMADAS no baseline (última definição): `ai_agents` (`:1027`), `ai_agent_versions` (`:992`), `followup_flow_versions` (`:7253`) + `followup_flow_pointers` (`:7261`) (não existe tabela `followup_flows`), `ai_routers` (`:9028`) + `ai_router_members` (`:9050`), `ai_knowledge_sources` (`:1133`), `org_memory_entries` (`:7716`), `organizations.settings jsonb` (`:1769`); `config_*` ausentes (sem colisão). Função nova: `tests/invariants/hardening-definer-varredura.test.ts:38-40` (`ANON_PERMITIDO` vazio em `:61`) proíbe EXECUTE p/ `anon` sem exceção e exige `revoke execute ... from anon` na migration **e** no apêndice (`:362-364`).

**Código por fatia (criar × editar × testes que guardam).**
- F1 cria: migration `0655`, `app/app/assistente/page.tsx`, rotas `assistente/*`, apêndice baseline + `database.types.ts` regenerado, i18n (`dicionario.ts` + `registro`/dicionário, sem pastas en/es separadas). Edita: `NAV_CATALOG` (`catalogo.ts:146`; grupo "Assistente" a criar — `NAV_GROUPS` em `:89-100` só tem 6; atenção aos comentários anti-`sidebar:true` e ao risco da dobra medido em `catalogo.ts:456-460` + `navegacao.spec.ts`), `registry.ts` (ícone), `TopBar.tsx` (botão junto ao `UserMenu` `:22`, padrão `AlertsBell` `:20`; armadilha medida: dropdown dentro de `header` com `backdrop-blur` (`:11`) nasce cortado — usar portal, ver `AvisoDePropostaEmDestaque.tsx:28-39` e seu teste `:170-191`; `testid barra-do-topo` existe só no mock do teste, não usar como âncora). Testes que guardam: `navegacao-completude`, `navegacao-registry`, `nav-hub`, `sidebar-grupos`, `navegacao.spec.ts` (e2e), `i18n-catalogo-do-menu`, `i18n-espanhol-cobre-a-tela`, `branding` (proibido "Deskcomm" em código de tela), `telas-filtram-a-organizacao-ativa`, `rls-isolation` + `rls-completude-varredura` (ambos em `tests/invariants/`), `mapas-de-arquitetura`, `skills-embutidas`.
- F2 cria: migration (proposals), `config-turn.ts`, rotas `propostas/[id]/{approve,apply,reject}`. Armadilha: sem entrada em `public-paths.ts` o `proxy.ts` dá 401 em rota dual (`proxy.ts:57-59`, `:95-123`) — **decisão: F1/F2 só sessão cookie (sem Bearer), logo sem entrada** (coerente: rota só-cookie não deve ter entrada, `public-paths.ts:81-99`); Bearer um dia = entrar + inventário no threat-model. Testes: `mcp-respeita-o-teto-por-token` (só se expuser Bearer), `tests/invariants/rbac-config-ia-canais`, cercas (`cercas-sao-selecionadas-pelo-import` existe; guardas específicas das tools novas no plano — as tools são read-only + propose), `branding`, `i18n-*`, `mapas-de-arquitetura`.
- F3: migration (snapshots) + novo action em `lib/audit/actions.ts` (**arquivo existente**) + exibição em `app/app/audit`. Testes: `audit-resource-id-e-uuid`, `valor-de-filtro-nao-vai-ao-audit`, `audit-financeiro-nao-guarda-texto-livre`, `suporte-auditoria`, `retencao-das-tabelas-da-ia`, `retencao-poda-e-expurgo` (snapshot precisa de retenção — coberta pela decisão "segue a do tenant").
- F4: só edição (`app/api/v1/ai/evolution/route.ts` + `lib/ai/evolution/aggregate.ts` + `app/app/ai/evolution/page.tsx`). Teste `telemetria-tem-um-leitor-so` obriga ler via `aggregate` — nada de segundo leitor.

**Docs que o PR terá de atualizar (DoD 10/16).** Núcleo: `spec-16-tres-papeis` (4º papel espelhado no Operador), `spec-11-mcp` (escopo: 8 CONFIG_TOOL_DEFS fora do catálogo), `spec-12-ai-agents-ui` (`/app/assistente` como segunda porta do mesmo objeto), `agent-turn.workflow.json` + `architecture/README` (novo turno + ≥2 arestas), `threat-model` (superfície `assistente/*`, sessão-only), `business-rules-catalog` (audit/budget do turno; budget vive em `ai_budgets` + `llm_calls.cost_cents` via `fn_gasto_de_ia_do_mes`), `docs/doctrine/operacao-de-agentes.md` (manual→proposta), `docs/index`, `current-state`, `user-journey-map` (J1 + navegação). Secundários: `AGENTS.md` (turno + skills), `spec-07-events-workers` (por que fora do bus), `EPIC-13`, `prd-00` (contagens). `VISION.md` só se declarar o loop de config como flywheel. Conflito doutrinário a registrar: `ia-360` diz que agente não escreve regra — `propor+aplicar` com aprovação muda isso, com a aprovação como diferença.

## 8. Fica para o builder/plano (não decidido aqui)

1. ~~Streaming do chat~~ Decidido (autor): resposta simples sem stream na F1 — menos peça nova, sem SSE; streaming só entra se a F1 provar lentidão na prova-em-par.
2. ~~Números do orçamento~~ Decidido (dono, 2026-10-14): sem teto próprio — o gasto sai da credencial/provider da org (saldo da API key do usuário), com telemetria no `/app/ai/usage` existente. Risco aceito e registrado: os tetos MCP (60/600/30) **não valem para sessão-cookie** (`lib/api/auth-dual.ts:160-161`), logo a F1 nasce **sem trava operacional**; tetos próprios usuário/org/dia entram na **F2** (molde: chat de casos).
3. ~~Leitura do funil~~ Decidido (autor): via `app/api/v1/pipelines/**` (`route.ts`, `board`, `stages`, `agent-mapping`, `win-rates`). Ressalva: `manager` confirmado na lista (`route.ts:32,76`); nas demais, a confirmar no plano — onde exigir `manager`, usuário `agent` recebe degradação honesta ("peça a um manager/admin"), nunca bypass de papel.
4. ~~Retenção/LGPD~~ Decidido (dono, 2026-10-14): reaproveita a retenção operacional do tenant. Prazo/export do titular a declarar no plano.
5. ~~Grupo/sidebar~~ Decidido (autor + dono, 2026-10-14): grupo próprio "Assistente", `sidebar: true` **e** atalho no topo ao lado do avatar — botão em `components/shell/TopBar.tsx` junto ao `UserMenu` (padrão do `AlertsBell`), levando a `/app/assistente`.
6. ~~Reuso vs reescrita~~ Decidido (autor): reescrita condensada — o teto de 200 linhas/corpo obriga; preserva comandos verificáveis e aponta para o `SKILL.md` original como fonte.

## 10. Auditoria dos docs (2026-10-14 — para o revisor)

Três auditores independentes leram spec + planos contra `origin/main @ 0c05ca348` item a item (código no disco + `gh` para issues). Corrigido nesta revisão: "worktree limpa" (só os 2 docs, untracked), rótulo da régua de extensões, "8+ telas" (relato, não medida), #673 é Discussion (não issue), F5 removido da citação, ajuda-configurar sem paradeiro afirmado, Jev-triagem marcada como pedido novo (código atual é handoff/opt-out, `pedidos.ts:1-80`), tetos MCP não valem p/ sessão (`auth-dual.ts:160-161` → tetos próprios a implementar, CONFLITO com decisão do dono em §8.2 aguardando re-confirmação), `testid barra-do-topo` só em mock, `rbac-config-ia-canais` em `tests/invariants/`, `ai_router_members` em `baseline.sql:9050`, fórmula exata do hardening, `manager` só confirmado na lista de pipelines, `audit/actions.ts` existente, "onde couber" removido (admin-only), grupo "Assistente" a criar + risco da dobra, fragmento com `secao/titulo/corpo`, `requireRole("agent")` explícito, paths F4 completos, refs de linha DoD/arquivos.
Divergências resolvidas a favor da leitura direta: DoD 4/5/7 existem (`CLAUDE.md:720/721/723`); `docs/doctrine/operacao-de-agentes.md` existe. CONFLITO do §8.2 resolvido pelo dono (2026-10-14): F1 sem trava, tetos na F2.
