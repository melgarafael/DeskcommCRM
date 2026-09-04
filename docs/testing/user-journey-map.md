# Mapa de Jornadas & Testes E2E — Experiência do usuário em VPS fresca

> Fonte da verdade do QA de produto do SonghaiCRM open-source. Cada caso aqui é
> exercitado **pelo frontend real** (Playwright), com contas de teste reais e
> recursos reais (banco fresco do `baseline.sql`, WAHA local, receiver de webhook
> real). Curl/API só como diagnóstico, nunca como prova de UX.
>
> Persona: **usuário leigo** que rodou o `install.sh` numa VPS e abriu o navegador.
> Ambiente de referência: banco 100% zerado + `bootstrap-owner.ts` (o que o kit faz).

## Convenções

- `[P0]` primeira impressão — bug aqui é vergonha pública; prioridade máxima.
- `[P1]` rotina diária do operador/atendente.
- `[P2]` exploração/edge.
- Resultado: `PASS` / `FAIL(bug#)` / `WARN` (funciona mas UX ruim).
- Evidência: screenshot/trace em `.superpowers/evidence/vps-qa/`.

---

## J1 — Onboarding do primeiro usuário `[P0]`

Contexto do código: primeiro usuário nasce do `scripts/bootstrap-owner.ts`
(install.sh); quem é convidado e ainda não tem conta entra por `/signup?invite=`.
Wizard: welcome → whatsapp → setup-ai →
**testar** → invite-team → done. A ordem, os rótulos e o resumo final saem de uma
fonte só (`lib/onboarding/passos.ts`) — eram três listas que discordavam. Gate:
`organizations.onboarded_at`. MFA obrigatório pra admin logo após o wizard.

| # | Caso | Expectativa |
|---|------|-------------|
| J1.1 | Login com credenciais do bootstrap | entra e é redirecionado pro `/onboarding` (org sem `onboarded_at`) |
| J1.2 | Login com senha errada | mensagem clara "Email ou senha incorretos", sem stack |
| J1.3 | Welcome: termos não aceitos | botão avança desabilitado |
| J1.4 | Welcome: nome da org + timezone salvos | grava `display_name`/`timezone`, avança pro WhatsApp |
| J1.5 | Connect WhatsApp: WAHA ativo → QR aparece | sessão criada, QR renderiza via proxy, poll de status roda |
| J1.6 | Connect WhatsApp: "Pular por enquanto" | avança pro setup-ai |
| J1.7 | Setup IA: criar agente default | `ai_agents` criado **e a versão publicada aponta para o provedor que a instalação escolheu**, com o modelo curado DAQUELE provedor; avança |
| J1.8 | Invite team: enviar convite SEM Resend configurado (realidade da VPS fresca) | UI **não mente**: mostra que email não saiu + oferece `accept_url` copiável |
| J1.9 | Done: "Ir para o Inbox" | seta `onboarded_at`, cai no `/app/inbox` |
| J1.10 | Gate MFA pós-onboarding | blocker aparece; enrolar TOTP + ver/salvar recovery codes funciona de ponta a ponta |
| J1.11 | Abandonar no meio e voltar (fecha browser no step 3) | retoma exatamente no step pendente |
| J1.12 | Tentar `/app/inbox` antes de concluir | redirect pro onboarding, sem loop |
| J1.13 | Reabrir `/onboarding` depois de concluído | redirect pro app (wizard não reabre) |
| J1.15 | Setup IA: erro de banco ao listar os números (a publicação não pode ser decidida) | UI **não mente**: agente criado como rascunho, causa técnica na tela e saída pro próximo passo; clicar de novo NÃO cria um 2º agente · **PASS** (`tests/unit/onboarding-agente-nao-publicado.test.ts`, `tests/unit/onboarding-setup-ai-aviso.test.tsx`) |
| J1.16 | Instalação escolheu OpenRouter (opção [1] do instalador) | o agente publicado usa `openrouter`, nunca `anthropic` — o provider da versão vence o da organização em runtime, então publicar o provedor errado entrega um "Publicado" que morre em toda mensagem · **PASS** (`tests/unit/onboarding-agente-nao-publicado.test.ts`) |
| J1.17 | Instalação em provedor cujo catálogo ainda não sincronizou (estado real de uma VPS nova: o baseline semeia ZERO modelos OpenRouter) | não publica e **diz a causa certa**: rascunho por falta de modelo, sem acusar o WhatsApp; oferece saída pro próximo passo · **PASS** (`tests/unit/onboarding-agente-nao-publicado.test.ts`, `tests/unit/onboarding-setup-ai-aviso.test.tsx`) |
| J1.18 | Não dá para ler qual provedor a instalação escolheu (erro no `select` de `organizations`) | não publica com chute — publicar "anthropic" quando não se sabe é o defeito de origem em roupa nova · **PASS** (`tests/unit/onboarding-agente-nao-publicado.test.ts`) |
| J1.19 | O agente entregue consegue mexer no CRM | nasce com as capacidades do pacote "Vender e mover o funil" ligadas e o funil de entrada no escopo — antes vinha com `tool_ids` e `pipeline_ids` vazios, isto é: conversava e não criava lead nem movia card · **PASS** (`tests/unit/onboarding-agente-nao-publicado.test.ts`, `tests/unit/capacidades-padrao-do-onboarding.test.ts`) |
| J1.20 | O escopo de funil chega ao turno REAL (agent-engine) | a ponte que monta as ferramentas do turno passa `pipeline_ids`; sem isso o campo era decorativo e toda escrita de lead era recusada, com a capacidade ligada na tela · **PASS** (`tests/unit/ponte-do-agente-passa-o-escopo.test.ts`) |

| J1.22 | Convidado que **ainda não tem conta** | a tela de aceite oferece "Ainda não tenho conta", o signup recebe o convite, não pede nome de empresa e trava o e-mail; ao confirmar, a pessoa vai para o aceite em vez de ganhar uma organização própria — antes ela virava **admin de uma empresa fantasma**, com wizard alheio e MFA de administrador · **PASS** (`lib/auth/convite-no-signup.test.ts`, `tests/e2e/invite-lifecycle.spec.ts` casos 10–12) |
| J1.23 | Convite expirado ou emitido para outro e-mail, no signup | falha FECHADA: não provisiona organização nenhuma e explica no login. Cair no provisionamento aqui devolveria o defeito de J1.22 para quem demorasse entre criar a conta e confirmar o e-mail · **PASS** (`lib/auth/convite-no-signup.test.ts`) |

| J1.24 | Ver o funcionário atender antes de terminar | passo novo entre treinar e chamar o time: ensaio com o runtime real (`is_dry_run`), nada enviado pelo WhatsApp. Trata os três estados — sem agente, agente em rascunho, e o caso normal — e o erro aparece aqui, não com o primeiro cliente de verdade · **PASS** (`tests/e2e/vps-fresh-onboarding.spec.ts`, `lib/onboarding/passos.test.ts`) |
| J1.25 | O passo 1 mostra o que a instalação já trouxe | provedor contratado, WhatsApp pronto, funil criado — cada linha MEDIDA. E o campo de nome vem vazio quando a organização ainda está com o "Minha Empresa" do instalador, em vez de obrigar a pessoa a apagá-lo · **PASS** (`lib/instalacao/ambiente.test.ts`) |
| J1.26 | O quadro de clientes deixa de nascer de e-commerce | passo novo entre treinar e ver ele atender. `trg_seed_default_pipeline_for_org` semeia "Carrinho abandonado / Em separação / Enviado" em TODA organização, e a clínica abria o quadro dela e lia isso. A sugestão sai do MESMO modelo que vai atender — se ela falha, o dono descobre agora e não com o primeiro cliente · **PASS** (`tests/e2e/wizard-do-funcionario.spec.ts`, `lib/onboarding/proposta-de-funil.test.ts`) |
| J1.27 | O quadro **ensina o funcionário a percorrê-lo** | MEDIDO em 2026-08-13: **312 etapas em 43 funis, 4 com `agent_stage_hint`** — e as 4 de organizações de teste. Toda instalação real nascia com `coberturaDoFunil()` devolvendo `mudo: true`: o assistente tinha o funil no escopo (J1.20) e não sabia o que significava nenhuma coluna. Aqui uma coluna é NOME + DESTINO indissociáveis · **PASS** (`tests/invariants/quadro-do-onboarding.test.ts`, 7 casos contra o Postgres do baseline) |
| J1.28 | Sem chave de IA, o passo ainda entrega quadro | falha ABERTA na informação, FECHADA na ação: seis quadros prontos por ramo, escolhidos pelo que o dono escreveu no passo 1, e a tela DIZ que a sugestão não veio. Devolver erro deixaria a pessoa com o funil de e-commerce, que é o defeito que o passo existe para consertar · **PASS** (`lib/onboarding/sugerir-funil.test.ts`, `tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.29 | O passo 1 pergunta **o que o negócio faz** | era o dado que faltava no produto inteiro: sem ele os três modelos de prompt diziam "loja online" e o quadro nascia de e-commerce — os dois defeitos vinham da mesma origem, uma instalação que nunca pergunta em que ramo entrou · **PASS** (`tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.30 | Sem chave da IA, o passo de treinar PEDE a chave | o passo 1 media e escrevia "Falta a chave da inteligência artificial" — diagnóstico certo, saída nenhuma: a pessoa teria de descobrir sozinha que existe uma tela de credenciais, e onde. Agora ela cola a chave no passo em que a chave passa a importar, um clique antes de o funcionário nascer com ela · **PASS** (`tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.31 | A chave é testada com uma GERAÇÃO, não com uma listagem | "Validada" nunca significou "funciona": o validador bate em `GET /v1/models`, que responde 200 com a conta zerada. `provarSaldo` existia e **nenhuma tela a chamava** (evento sem consumer, anti-pattern nº 3 do CLAUDE.md). Agora o passo de treinar confere e diz o resultado — e distingue "sem crédito" de "não consegui conferir", que pedem conselhos opostos · **PASS** (`lib/instalacao/prova-de-credito.test.ts`, `tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.32 | A janela entre cadastrar a chave e ela ser confirmada | MEDIDO percorrendo o wizard: quem colava a chave lia "Não consegui testar o crédito" e "Falta a chave da inteligência artificial" no mesmo segundo — as duas frases mandam cadastrar de novo o que já está lá. A validação roda em SEGUNDO PLANO, então a janela existe sempre; o retrato passou a distinguir confirmada de em-verificação, e a tela espera em vez de acusar · **PASS** (`lib/instalacao/retrato.test.ts` — o arquivo não tinha teste nenhum antes) |
| J1.33 | A verificação em duas etapas deixa de ser imposta | MEDIDO percorrendo o wizard: "Começar a usar" entregava o dono num bloqueador de tela cheia pedindo um aplicativo autenticador — um sétimo passo que a barra de progresso nunca anunciou, e que TODA instalação self-host recebia, porque o `install.sh` cria o dono como platform admin. Agora é escolha: `platform_admins.mfa_required` (que existia e **nunca era lido** — controle decorativo) e `organizations.settings.security.mfa_required`, ambos com padrão não-exigir · **PASS** (`tests/e2e/mfa-opcional.spec.ts`, `lib/auth/politica-mfa.test.ts`) |
| J1.34 | Ligar e desligar a verificação, pela tela | o único ponto de cadastro do produto era o próprio bloqueador — sem um botão em Configurações › Segurança, tornar o cadastro opcional deixaria a proteção INALCANÇÁVEL. E desligar não existia em lugar nenhum: `enrollMfa` só apaga fator não verificado. Desligar o próprio fator exige sessão `aal2`, senão uma sessão roubada desliga a proteção com um clique · **PASS** (`tests/e2e/mfa-opcional.spec.ts`) |
| J1.35 | Cadastrar e PROVAR são perguntas diferentes | `mfaEmDivida()` começava consultando a política, então quem ativasse a verificação por vontade própria teria o fator ignorado na sessão — o mesmo que não ter. Com o cadastro opcional isso viraria o buraco central da mudança. Agora quem TEM fator prova, sempre, qualquer que seja o papel · **PASS** (`tests/unit/require-role-mfa.test.ts` — o caso do manager INVERTEU, e a inversão aperta) |

> **Cobertura em camadas (J1.22/J1.23):** a decisão de *não provisionar* é provada por unitário, porque é uma função pura e roda no gate obrigatório. O caso de tela cobre o caminho visível (CTA → signup com o token → campos certos). O que **não** está coberto ponta a ponta é a volta do link de confirmação de e-mail: exigiria caixa de e-mail no e2e, e a spec que faria isso é a de instalação fresca, que está fora do CI.

> **A jornada J1 passou a ter GATE.** `tests/e2e/wizard-do-funcionario.spec.ts` roda no CI (SPECS_PARTE_1) e cobre o wizard inteiro pela tela — do login ao "Começar a usar" — criando a PRÓPRIA organização, porque o seed compartilhado entrega uma já onboardada e zerá-la mandaria as specs seguintes para dentro do onboarding. Fica de fora só o ensaio com resposta real, que exige chave de IA com saldo. `vps-fresh-onboarding.spec.ts` continua fora do gate (depende de WAHA, Redis e Resend) e segue sendo a prova mais completa, para rodar à mão.

> **Achado ABERTO (não é regressão, é primeira impressão):** percorrendo o wizard inteiro num tenant fresco, o botão "Começar a usar" entrega o dono no Inbox e a PRIMEIRA coisa que ele vê é um modal bloqueante de verificação em duas etapas — um sétimo passo que a barra de progresso do wizard nunca anunciou. O MFA obrigatório para `admin` é decisão de produto e está correto; o que está errado é ele aparecer como surpresa depois de seis passos que se apresentaram como o caminho completo. Conserto natural: virar passo do wizard, ou ao menos ser anunciado na tela final. Fora do escopo da frente do quadro de clientes.

> **J1.21 — FECHADA.** O agente do onboarding nascia `kind='rag_bot'` (o default do banco, de quando o produto só tinha o formato antigo), abria no editor legado — Temperature, Top K, Similarity threshold — e as capacidades que ele recebia ligadas ficavam **invisíveis** para o dono: funcionavam no runtime e não tinham superfície de configuração, que é o invariante 6 do Sistema Vivo quebrado.
>
> O que travava a virada era o editor novo exigir `credential_id`, enquanto instalação pelo kit funciona com a chave de plataforma do `.env` e não tem nenhuma linha em `ai_provider_credentials` — o dono cairia numa tela onde não consegue salvar nada. Resolvido nas duas pontas: `versionShapeSchema` aceita `credential_id: null` (= a chave da instalação), o seletor oferece essa opção, e a rota de versões **recusa** o nulo quando o ambiente não tem chave daquele provedor (falha fechada — senão publicaria um agente que morre em toda mensagem).
>
> MEDIDO na tela, num tenant fresco: o funcionário criado no wizard abre no editor atual, com "Chave de acesso: A chave desta instalação (anthropic)", "12 de 20 capacidades ligadas" e "Vender e mover o funil" ativo.

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
| J3.10 | Escolher o que o agente pode fazer, por jornada de trabalho | 6 pacotes em português, com explicação e contagem — não uma lista de `crm_*` monoespaçado · **PASS** (`tests/e2e/capacidades-do-agente.spec.ts`) |
| J3.11 | Ligar "Atender e responder" NÃO dá direito de mandar WhatsApp | a capacidade de risco crítico fica destacada, exigindo marcação individual; desligar a jornada leva ela junto · **PASS** |
| J3.12 | Modo avançado: ficha por capacidade + nome técnico | o `name` técnico só aparece aqui; fora dele o leigo lê rótulo, o que toca e risco · **PASS** |
| J3.13 | A escolha sobrevive ao salvar e recarregar | o servidor aceita a lista (mesmo teto de 20 da tela) e o estado volta igual · **PASS** |
| J3.14 | Ver se o que está ligado está funcionando (aba Capacidades) | usos, falhas, quantos vieram de teste, última vez — e o que fazer com cada número · **PASS** (números escritos pelo emissor real de audit) |
| J3.15 | Teto de 20 recusa a passagem, explicando em português | **NÃO EXERCITÁVEL HOJE**: com 16 capacidades no catálogo, ligar tudo não chega a 20. Coberto por teste unitário; vira exercitável quando as waves de capacidades entregarem |

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
| J4.22 | **Mensagem de contato desconhecido chega pelo webhook do WAHA** | card nasce no funil de entrada (`is_default`), na primeira etapa aberta, com o NOME de quem escreveu — nunca `@c.us`/`@lid` (executado 2026-08-06 · `conversa-vira-lead.spec.ts`) |
| J4.23 | Timeline do card recém-nascido | diz **"Entrou pelo WhatsApp"** — card que aparece sem explicação destrói a confiança no automatismo (executado 2026-08-06) |
| J4.24 | Segunda mensagem do MESMO contato | **não** abre um segundo card: um lead por demanda, não um por mensagem (executado 2026-08-06) |
| J4.31 | **Marcar em que funis o assistente pode mexer** | nasce FECHADO (a tela explica: "conversa normalmente, mas não mexe em negócio"); a marcação sobrevive ao salvar E RECARREGAR — o defeito do campo que "se desmarca sozinho" (`escopo-de-funil-do-agente.spec.ts`, 2026-08-07) |
| J4.32 | Funil marcado que o assistente não sabe percorrer | a lacuna de tradução aparece AO LADO da marcação, e só no funil marcado — fora do escopo ela não custa nada |
| J4.33 | Funil de ENTRADA fora da marcação | avisa que as conversas novas viram negócio ali e vão se acumular sem que o assistente possa organizá-los |
| J4.34 | O assistente tenta mover card de funil que não é dele | não move, e abre aviso PRÓPRIO na Central ("quis organizar um negócio de um funil que não é dele") — não o aviso de falha, porque nada falhou |
| J4.35 | Uma pessoa desfaz uma movimentação do assistente | vira atividade na timeline com a etapa que a IA escolheu; agregado por etapa responde "onde ele mais erra" |
| J4.28 | **A IA ouve um dado na conversa e o propõe** | a pendência aparece na ficha do contato COM o trecho que a pessoa escreveu; nada é gravado até alguém decidir (`confirmar-dado-do-contato.spec.ts`, executado 2026-08-07) |
| J4.29 | Confirmar a sugestão | o dado entra na ficha, sobrevive ao reload, e a pendência some — não fica botão para o que já foi decidido |
| J4.30 | Descartar a sugestão | some da tela **sem gravar**; a recusa é auditada, porque "vi e decidi não gravar" é sinal de onde a IA erra |
| J4.26 | **Salvar o e-mail de um contato pela tela** | fica salvo, aparece na ficha e sobrevive ao reload. Era **500** até 2026-08-06: o handler escrevia em `email_normalized`, coluna GERADA, e o Postgres abortava o UPDATE inteiro (`contato-salva-email.spec.ts`) |
| J4.27 | Anonimizar um contato (LGPD) | mesma causa da J4.26 na rota `/api/v1/lgpd/anonymize` — **a anonimização não acontecia**. Corrigido; guardado pelo invariante de colunas geradas, ainda **sem prova de tela** |
| J4.25 | ⚠️ O funil de entrada de uma org nova é de **e-commerce** | `fn_seed_default_pipeline_for_org` semeia "Pedidos" com *Carrinho abandonado · Pago · Em separação…*. Numa clínica ou imobiliária, o lead nasce em **"Carrinho abandonado"**. Achado em 2026-08-06 ao provar J4.22; conserto é decisão de produto (spec 17 passo 4) |

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

## J8 — O cliente não morre por falta de resposta `[P1]`

Contexto do código: pacote `reter` do catálogo (IA 360 · wave 2). A demanda esfria, o
agente marca o retorno pela capacidade que o dono ligou na tela, o humano vê e pode
desmarcar, e o agente descobre que desmarcaram. Spec: `tests/e2e/retorno-anti-morte.spec.ts`
(seed pela capacidade REAL — `scripts/seed-e2e-retorno.ts`, nunca INSERT à mão).

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J8.1 | Negócio 5 dias sem movimento com retorno marcado pelo agente | Radar mostra **"Em voo"** e "Assistente retorna em 2d" — não "crítico" | PASS |
| J8.2 | Linha do tempo do negócio após o agendamento | entrada `Retorno agendado — <motivo>`, com o agente nomeado | PASS |
| J8.3 | Fila de acompanhamento mostra a promessa | linha "Promessa" com status **Agendada** e botão Cancelar | PASS |
| J8.4 | Humano desmarca pela fila | diálogo diz o que acontece; status vira **Cancelada** (não "Concluída") | PASS |
| J8.5 | O agente consulta os retornos depois do cancelamento | vê `situacao: cancelado` **com o motivo** — é o que o impede de reagendar | PASS |
| J8.6 | Repetir a jornada | seed reseta o retorno; o teste roda de novo sem intervenção | PASS |

Evidência: `.superpowers/evidence/w2-retorno-{no-radar,na-fila-agendada,dialogo-de-cancelamento,na-fila-cancelada}.png`.

**Sabotagem que confirma que o caso não passa por acaso:** devolvendo `podeCancelar` ao
estado anterior à wave (promessa não cancelável), J8.4 reprova com timeout no clique —
1 failed / 1 passed. Restaurado, 2 passed.
## J8 — Passar o atendimento para uma pessoa, e receber de volta `[P1]`

Contexto do código: o agente abre um chamado (`agent_cases`) quando esbarra num
bloqueio; a passagem em si (`performHumanHandoff` / `triggerHandoff`) liga **três**
travas — `contacts.force_human`, `conversations.bot_silenced_until` e
`assignee_kind='user'`. A volta é `POST /conversations/[id]/reactivate-bot`, hoje
atrás do botão "Devolver ao automático" no cabeçalho da conversa.

Spec: `tests/e2e/escalacao-ciclo.spec.ts`. Seed: `scripts/seed-e2e-escalacao.ts`
(chama as funções REAIS `openCase` e `performHumanHandoff` — um seed que ligasse
as travas com `UPDATE` próprio provaria o teste contra uma cópia da regra).
Evidência: `.superpowers/evidence/ia-360-w3/`.

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J8.1 | O chamado aberto pelo agente aparece em `/app/ai/cases` | linha na fila com o título e o bloqueio | PASS |
| J8.2 | A pessoa escolhe "Concluí" e escreve o que combinou | o chamado fecha (`resolved`) e o texto fica registrado | PASS |
| J8.3 | A conversa DIZ que o automático está pausado | aviso visível no cabeçalho — conversa com o robô calado não pode ter a cara de uma conversa normal | FAIL(BUG-04) → PASS |
| J8.4 | Existe caminho de volta pela tela | botão "Devolver ao automático" | FAIL(BUG-04) → PASS |
| J8.5 | Devolver solta as **três** travas | `force_human=false`, silêncio nulo, dono nulo, `assignee_kind='ai'` | FAIL(BUG-01) → PASS |
| J8.6 | A volta aparece na linha do tempo do negócio | atividade "Voltou para o atendimento automático" | FAIL(BUG-02) → PASS |
| J8.7 | A **ida** aparece na linha do tempo | atividade "Passou para humano" também pelo caminho do harness/casos | FAIL(BUG-05) → PASS |
| J8.8 | O agente retoma **sabendo** o que a pessoa fez | a abertura do turno (`ritualBlocks`) cita a decisão dela, sem apagar o acumulado anterior | PASS |
| J8.9 | Status da conversa escalada em português | o cabeçalho mostrava `pending` cru | FAIL → PASS |

Bugs desta jornada estão detalhados em `HANDOFF-ia-360.md` (BUG-01 a BUG-05).

---

## J9 — Ver o que o follow-up já fez, e intervir sem matá-lo `[P1]`

Contexto do código: o dossiê do enrollment (`/app/ai/followups/enrollments/[id]`,
wave FV-W1-FILA). `followup_enrollment_events` gravava cada passo do motor desde a
0054 e **nenhuma tela lia a tabela**; a única intervenção possível era cancelar.
Spec: `tests/e2e/followup-dossie.spec.ts` — os eventos da timeline são REAIS (o
setup publica um fluxo, cria o enrollment pela API e chama o cron
`followup-flow-worker`, o mesmo caminho de produção; nada de `INSERT` à mão).

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J9.1 | Clicar no contato na aba Fila | abre o dossiê daquele follow-up (rota própria, sobrevive ao F5) | PASS |
| J9.2 | Ler a história depois de dois ticks do motor | "Seguiu em frente" e "Começou a esperar"; **nenhum** `node_advanced` nem `wait-1` na tela | PASS |
| J9.3 | Onde está agora | "Deixa esfriar (Espera — espera 4 horas)" + quando volta a andar | PASS |
| J9.4 | Pausar | status vira "Pausado por uma pessoa"; próximo passo vira "Parado até alguém retomar" | PASS |
| J9.5 | Pausado não oferece adiar/pular | botão que só sabe recusar não aparece | PASS |
| J9.6 | Retomar | volta a andar pelo tempo que FALTAVA (não dispara na hora) | PASS |
| J9.7 | Adiar para uma data escolhida | o próximo disparo passa a ser a data do diálogo | PASS |
| J9.8 | Pular o passo | o follow-up anda para o passo seguinte; com mais de um caminho, a tela PERGUNTA por onde | PASS |
| J9.9 | A intervenção aparece na timeline do NEGÓCIO | as **quatro** linhas no card, com autor humano nomeado ("E2E Manager") e sem colapsar apesar de terem acontecido no mesmo minuto | PASS |
| J9.10 | Viewer | lê o dossiê inteiro, sem coluna de ações; as 4 rotas devolvem 403 `forbidden_role` | PASS |
| J9.11 | O tempo que a IA escolheu, com plano REAL | "esperar 12 horas" + "bateu no seu limite" + **"a IA pediu 3 dias"** + o motivo e a faixa configurada | PASS |
| J9.12 | A história do planejamento em português | "O agente decidiu quanto esperar em cada passo" e "Pediu ao agente para planejar os tempos de espera" — sem `timing_plan_decidido` na tela | FAIL → PASS |

Evidência (uma por passo, na ordem da jornada):
`evidence/followup-dossie/01-dossie-timeline.png` ·
`evidence/followup-dossie/02-pausado.png` ·
`evidence/followup-dossie/03-adiado.png` ·
`evidence/followup-dossie/04-pulado.png` ·
`evidence/followup-dossie/05-timeline-do-negocio.png` ·
`evidence/followup-dossie/06-viewer-so-leitura.png` ·
`evidence/followup-dossie/07-plano-de-tempo.png`.

**J9.11/J9.12 usam plano REAL, não `INSERT` à mão:** o modelo "responde" pelo
seam `completeTurnForEnrollment` — a mesma função que o worker chama depois da
chamada de LLM —, então o clamp, a gravação e o `proposto_ms` são os de
produção. Um jsonb escrito na mão provaria que a tela desenha o que eu inventei.

**O J9.12 nasceu FAIL e é por isso que ele existe:** abrindo o dossiê, a
história mostrava `código: timing_plan_decidido` e anunciava o turno de
planejamento como "escrever a mensagem". Nenhum unitário pegaria — os dois
eventos são do motor novo, e a tela foi o único instrumento que os viu.

**O que o J9.9 mediu e quase passou batido:** as quatro intervenções acontecem
no mesmo minuto e pelo mesmo ator, e a timeline do negócio COLAPSA blocos assim
(`agrupaTimeline`, janela de 60s). Escondidas atrás de um "+", o próximo
atendente abriria o card e não veria que uma pessoa segurou o fluxo — que é a
única razão de a linha existir. Os quatro tipos entraram em `NUNCA_COLAPSA`
pelo critério que já estava escrito lá: decisão humana não colapsa.

---

## J10 — Marca própria: o revendedor põe a cara dele no sistema `[P0]`

Contexto do código: o épico de marca própria (PR #248 e a continuação). São
**duas camadas** que nunca se misturam — a da INSTALAÇÃO, que o dono do servidor
define e vale para todo mundo, inclusive nas telas de acesso de quem ainda não
entrou; e a da ORGANIZAÇÃO, que o admin do tenant define e vale só dentro dela.
Specs: `tests/e2e/marca-logo.spec.ts`; invariantes de banco em
`tests/invariants/marca-{logo,da-instalacao,da-organizacao}.test.ts`.

`[P0]` porque é primeira impressão em dois sentidos: é o que o revendedor mostra
ao cliente dele, e a tela de acesso é a primeira coisa que qualquer usuário vê.

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J10.1 | O dono do servidor sobe o logo da instalação | aparece na barra lateral dele, e a prévia mostra sobre fundo claro E escuro | **NÃO EXECUTADO** |
| J10.2 | Quem NÃO entrou vê o logo do dono na tela de acesso | as 6 telas públicas mostram a marca da instalação, sem sessão | **NÃO EXECUTADO** |
| J10.3 | O logo da EMPRESA troca a barra dela e não vaza | a camada da organização não alcança a tela de acesso, que é da instalação | **NÃO EXECUTADO** |
| J10.4 | SVG renomeado com extensão de imagem comum | recusado **pelos bytes**, não pela extensão, com a razão dita em português — SVG executa código quando aberto direto pelo endereço | **NÃO EXECUTADO** |
| J10.5 | Remover o logo da empresa | devolve o da camada de baixo (a instalação), não "nenhum" | **NÃO EXECUTADO** |
| J10.6 | O instalador pergunta a cor da marca | `APP_ACCENT_HEX` no `install.sh`, com validação — o revendedor não recebe o verde do produto | PASS (`tests/shell/`) |
| J10.7 | Nome com apóstrofo (`Sant'Ana Odontologia`) | o `.env` sobrevive: 18/18 nos três consumidores de compose | PASS |
| J10.8 | Cor escura de marca não quebra o contraste | o anel de foco respeita o piso de 3:1 em ambos os temas | PASS (unit) |

**Bug de produto achado ao executar (2026-08-14), e é o que justifica esta jornada
existir.** O caso J10.1 reprovou no CI, e não por defeito do teste: quem sobe o
logo lia `"Logo atualizado."` e **a tela não mudava**, por até 30 segundos.

A causa não era a que qualquer um chutaria. `lib/branding/instalacao.ts` é
instanciado **duas vezes dentro do mesmo processo** — o Turbopack emite um runtime
de servidor para as 206 rotas de API e outro para as 98 páginas, cada um com o
próprio cache de módulos. A rota de upload invalidava um memo que **nenhuma tela
lê**; a troca só aparecia quando o TTL expirasse sozinho.

O que fecha o diagnóstico é o controle: a server action que troca nome e cor
chama a MESMA função e sempre funcionou, porque é compilada no runtime das
páginas. Mesma função, mesmo processo, resultados opostos — a variável era o
runtime.

Isto é exatamente o que a doutrina de QA Visual existe para pegar: nenhum teste
unitário veria, porque a lógica está certa; o defeito mora em como o bundler
divide o servidor. Só aparece exercitando o produto pela tela.

> ⚠️ **Os cinco `NÃO EXECUTADO` são honestos, não pendências esquecidas.** A spec
> existe, tem 6 casos e está na `SPECS_PARTE_2` do CI — mas nunca rodou: o Docker
> da máquina de desenvolvimento está com o disco da VM corrompido, e o `e2e` do
> CI é a primeira execução dela na vida. Um revisor cético mediu a spec na fonte
> do Playwright e achou 3 defeitos que a reprovariam (testes sem login, e a
> restauração feita como `test` num `describe` serial — que é justamente o que
> não roda quando um caso falha). Corrigidos antes da primeira execução; o
> resultado real entra aqui quando o CI disser.

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
| M3 | ~~README self-host aponta repo/imagem `deskcommcrm/*`; kit usa `melgarafael/*`~~ **CORRIGIDO 2026-08-13** — era um `git clone` de uma org que não existe (404) em `docs/deploy-selfhost/README.md:26`. Uma consultoria externa leu essa string e concluiu que o compose apontava para uma org desvinculada; o compose sempre apontou para `melgarafael`. | explorer webhooks | — |
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
- ~~O autenticador registra o nome fixo "SonghaiCRM", ignorando o `APP_NAME` que o
  instalador vende como marca de toda a interface.~~ **RESOLVIDO em 2026-08-14** — virou o
  caso `M4` da jornada de marca própria (no fim deste arquivo). E a justificativa que estava
  aqui era **falsa em duas metades**: o problema não era "o nome fixo aparece no celular do
  usuário", porque o `friendlyName` **não entra na URI `otpauth://`** (medido contra GoTrue
  v2.188.1, e nenhuma tela do produto renderiza `friendly_name`). O campo que de fato grava no
  aparelho é o `issuer`, que simplesmente **não era passado**. Este item ficou aqui semanas
  descrevendo o defeito certo pelo mecanismo errado — e, enquanto isso, a mesma coisa constava
  como dívida da fase 4 na guarda de marca. O mesmo defeito com duas biografias é como uma
  correção acaba consertando a metade que não importa.
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

---

## A atualização alcança o worker? (2026-08-13)

**Jornada nova, e ela nasceu de um defeito que nenhuma jornada existente cobria.** Todas as
jornadas do mapa exercitam o produto DEPOIS de instalado; nenhuma perguntava se uma correção
entregue numa versão nova chega mesmo a cada peça da VPS.

O serviço `worker` — o runtime do agente de IA — não tinha `image:` no `docker-compose.prod.yml`,
só `build:`. Isso o tornava invisível para `docker compose pull` ("Skipped — No image to be
pulled") e imune a `up -d` sem `--build`. Ele era construído na VPS no dia da instalação e
**nenhum `update.sh` jamais o reconstruiu**. Correções do agente não chegavam a instalação
nenhuma, e nada na tela nem no log dizia isso.

O dossiê desta suíte já tinha registrado o sintoma sem tirar a conclusão: a linha 295 anota,
do QA de instalação real, *"cache de build do Docker zerado (a VPS realmente compila o
worker)"*. O fato estava medido; a pergunta é que faltava.

**Casos desta jornada** (`[P0]` = primeira impressão / parque instalado):

| # | Caso | Estado |
|---|---|---|
| U1 `[P0]` | Instalação nova nasce pinada numa VERSÃO, não em canal móvel | coberto — `self-host-kit/test-validators.sh` roda o `install.sh` contra um remoto local com tags e cobra o `.env` |
| U2 `[P0]` | `update.sh` grava as TRÊS imagens na mesma versão | coberto — `tests/shell/update-guard.test.sh` §4b |
| U3 `[P0]` | Nenhum serviço de produção fica `build:`-only | coberto — `tests/unit/packaging-artefato-do-cliente.test.ts` |
| U4 | O crontab do scheduler não perde rota ao mudar de arquivo | coberto — `tests/shell/scheduler-entrypoint.test.sh` + `tests/unit/cron-routes-scheduled.test.ts` |
| U5 | `/api/v1/health` responde a versão real da imagem | coberto — medido no app real: com `APP_VERSION=9.9.9-teste` responde `9.9.9-teste`; sem ela, `desconhecido` |
| U6 `[P0]` | **Ensaio de atualização numa VPS real, de uma versão anterior para a nova, e o worker passa a rodar o código novo** | **EXECUTADO 2026-08-13** (U6-b, U6-c e **aplicado em produção**) — estado legado reproduzido do commit `ee520110`, worker migrou para a imagem publicada, nada perdido. **Com ressalva:** a 1ª execução do `update.sh` não conserta enquanto o canal `stable` não existir; a 2ª conserta. Evidência e limites em [`../runbooks/remediar-worker-congelado.md`](../runbooks/remediar-worker-congelado.md) §6 |

U6 deixou de ser buraco em 2026-08-13, e o ensaio pagou o próprio custo: revelou que a
primeira execução do `update.sh` não conserta o worker enquanto o canal `stable` não
existir — coisa que nenhum teste do CI podia mostrar, porque não é sobre o que os scripts
fazem, e sim sobre a ORDEM em que o parque encontra as peças.

O que continua fora: o app contra um Supabase real (o ensaio usou Postgres em contêiner),
uma sessão de WhatsApp pareada de verdade (foi um marcador no volume), e o `install.sh`
completo da época (exige projeto Supabase). Segue valendo a régua de `vps-fresh-onboarding`:
o CI prova que os scripts fazem o que dizem, não que a máquina de alguém mudou de estado.

---

## O cliente do revendedor vê a marca de quem o atende? (2026-08-14)

**Jornada nova, e ela cobre a persona que nenhuma outra cobre: o REVENDEDOR.** Todas as
jornadas acima olham a instalação pelos olhos de quem a usa. Esta olha pelos olhos de quem a
**vende** — a agência que instala numa VPS, põe a própria marca e cobra por isso, que é o
modelo de monetização declarado do produto (`docs/white-label.md`).

Ela nasceu de uma frase falsa em documento público. O `white-label.md` prometia, em texto de
venda, que "cores, fontes e tema não são configuráveis" e que "a marca é por instalação, não
por organização" — as duas coisas deixaram de ser verdade no épico de marca própria, e o
documento seguiu vendendo o limite antigo. O oposto também apareceu: o autenticador registrava
o nome fixo do nosso produto, e isso morava numa lista de "aberto para decisão do dono" há
semanas, sem dono.

**Por que quase toda a régua aqui é `[P0]`:** um vazamento de marca não parece um bug para
quem o comete — a tela funciona, o e-mail chega, o teste passa. Ele só existe aos olhos de um
terceiro (o cliente do revendedor) que descobre, no meio de uma conversa de venda, o nome de um
software que ele não contratou. Não há gravidade média nisso.

**Onde o código vive:** `lib/branding/` (resolvedor, rampa, contraste, saída sem DOM),
`app/admin/(protected)/marca/` e `app/app/settings/marca/` (as duas telas),
`self-host-kit/marca-emails.sh` (os e-mails de acesso) e o mapa
[`../architecture/marca-propria.architecture.json`](../architecture/marca-propria.architecture.json).

| # | Caso | Estado |
|---|---|---|
| `M1` `[P0]` | Instalação com a marca do revendedor: a **aba** mostra o nome dele e o **ícone** carrega **deslogado** | **PASS por comportamento** (2026-08-13, build de produção): com `app_name='Vendas Turbo'` e `accent_hex='#f2c94c'` gravados, o ícone virou **V sobre `#6e5c28`** — o accent DERIVADO, não a semente crua — e o título trocou. Spec `tests/e2e/icone-da-marca.spec.ts` no disco **e inscrita** em `SPECS_PARTE_1` (`.github/workflows/e2e.yml:106`). **NÃO medido: a primeira execução dela no CI** |
| `M2` `[P0]` | O **e-mail de confirmação de conta** chega com a marca do revendedor — ou, sem `SUPABASE_ACCESS_TOKEN`, o passo manual é impresso e a instalação segue | **PARCIAL.** O mecanismo foi medido contra a API real num projeto descartável: `PATCH /v1/projects/{ref}/config/auth` com `mailer_templates_*` **é aceito e PERSISTE sem SMTP customizado** (releitura por `GET`, estado restaurado). Achado do rig: **projeto pausado responde 400 "Project is paused."** — modo de falha que um script confiando em 2xx reportaria como sucesso, e por isso `marca-emails.sh` relê o que gravou. **NÃO medido: um e-mail efetivamente entregue numa caixa de entrada** |
| `M3` `[P0]` | **Convite de time**: assunto e corpo com a marca; sem `RESEND_*`, a tela mostra o `accept_url` em vez de falhar calada | **COBERTO POR TESTE, NÃO PROVADO NA TELA.** `tests/unit/email-marca-e-remetente.test.ts` e `tests/unit/branding-saida.test.ts` guardam a resolução e o remetente; `RESEND_FROM_EMAIL` vazio passa a significar `not_configured`, que cai no caminho que já existia (`accept_url` na tela, `pending_review` no worker de LGPD). Falta dirigir o browser num ambiente fresco **sem** `RESEND_API_KEY` |
| `M4` `[P1]` | **Cadastro de MFA**: o app autenticador registra a marca da instalação | **ENTREGUE, PROVA CONTRA GoTrue REAL NÃO LOCALIZADA.** `app/actions/auth/enrollMfa.ts:59` passa `issuer: marca.nome` — o campo que de fato grava no celular (`friendlyName` **não** entra na URI `otpauth://`, medido contra GoTrue v2.188.1). O plano exigia repetir o rig de enroll real antes de fechar; não achei registro dessa execução. **Vale só para quem enrolar depois: trocar o `issuer` não reescreve fator já cadastrado** |
| `M5` `[P1]` | **Export de LGPD**: o PDF nomeia o **controlador** (`legal_name`) e o DPO — **nunca** a marca do revendedor | **COBERTO POR TESTE.** O teste isola o rodapé e exige que o texto entre `Controlador:` e `· Relatório LGPD` seja **exatamente** o `legal_name` (a primeira versão só checava `/deskcomm/i` e teria deixado passar a marca de um revendedor). Vigiado também no mapa de arquitetura, que reprova quem ligar o PDF ao resolvedor de marca. **Armadilha viva:** `legal_name` nasce igual ao nome fantasia — o caso ruim é o valor plausível e errado, e quem resolve é a tela `/app/settings/tenant` |
| `M6` `[P1]` | **Marca por organização**: a cor da org pinta `/app` e **não** vaza para o `/login` | **PASS na tela** (2026-08-13), com admin de tenant PURO — a precondição falhou primeiro e era a armadilha prevista (`e2e-admin` **era** `platform_admin`; medi `count=1`, revoguei, reafirmei `count=0`, só então testei). `#b3261e` no claro, `#f16051` no escuro, persistido no reload, e **ausente** em `/login` sem sessão. Evidência: `evidence/org-1-tela.png`, `evidence/org-2-digitado.png`, `evidence/org-3-salvo.png`, `evidence/org-4-recarregado.png`, `evidence/org-5-login.png` |
| `M7` `[P2]` | Cor inválida: cai para o padrão, o estado fica gravado e a tela **mostra** por quê | **PASS na tela** para a recusa (hex inválido → **Salvar desabilitado**, evidência `evidence/marca-3-invalido.png`). `fallback_at`/`fallback_reason` são gravados por `registrarEstadoDaMarca()` e lidos por `/admin/marca`. **Corrigido em 2026-08-14 (`214f47f0`) o que esta célula dizia:** ela afirmava que o estado "só aparece para quem editar o banco à mão ou vier de um clone com valor legado" — e nenhuma das duas é possível, porque o CHECK `^#[0-9a-f]{6}$` entrou na `create table` da migration 0155 e a coluna nunca existiu sem ele. O caminho que **existe** é o `.env`: `lib/env.ts:201` não valida formato (`z.string().optional().default("")`, e o docblock explica por quê), então `APP_ACCENT_HEX=verde` acende `semente_invalida`. Coberto por `tests/unit/branding-fallback-alcancavel.test.ts`. **NÃO medido pela tela:** forçar esse caminho no browser exigiria subir a stack com `.env` hostil — o teste roda o código real de resolução, não o render |
| `M8` `[P0]` | O revendedor **descobre** que dá para trocar a marca | **PASS estrutural.** `/app/settings/marca` está declarada em `lib/navigation/registry.ts` (grupo Configurações, `sidebar:false` — tarefa de uma vez, o hub e o ⌘K garantem a descoberta), e `tests/unit/navegacao-completude.test.ts` reprova tela sem porta. `/admin/marca` é de platform admin e fica fora dessa varredura por construção |
| `M9` `[P0]` | **Logo por arquivo**: o dono do servidor sobe um PNG e ele aparece na barra lateral E no `/login` **deslogado**; a empresa sobe o dela e a fachada NÃO muda; SVG renomeado é recusado com a razão; remover devolve o logo da camada de baixo | **SPEC ESCRITA, EXECUÇÃO PENDENTE POR INFRA.** `tests/e2e/marca-logo.spec.ts` no disco e inscrita em `SPECS_PARTE_2` (`.github/workflows/e2e.yml:148`, como ÚLTIMA da lista — se a restauração dela falhar, o alcance da contaminação é zero spec), com os 6 casos e as medições por ferramenta (`src` + `naturalWidth`). ⚠️ **A régua desta linha já esteve errada:** ela dizia `getBoundingClientRect().height`, "porque `src` certo com altura 0 é o sintoma de bucket privado". É falso — os `<img>` de marca têm altura fixada por CSS (`h-7`, `h-10`), e o medido em chromium é `boa={"nat":1,"altura":28}` contra `quebrada={"nat":0,"altura":28}`: a altura passava nos dois. Quem prova o download é `naturalWidth`. **NÃO MEDIDO: nenhuma execução da spec.** O daemon do Docker está fora do ar nesta janela (`docker info` pendura >60s), e sem ele não há Supabase local, nem `pnpm test:db`, nem Playwright contra um banco fresco. Prova pendente por infra **não é prova feita**. O que ESTÁ medido é o lado unitário (`tests/unit/branding-logo-arquivo.test.ts`, 19 casos, com 3 sabotagens de contagem prevista) e a estrutura do banco (`tests/invariants/marca-logo.test.ts`, escrito e **não executado**) |

**O que esta jornada ainda NÃO cobre, e é onde eu apostaria o próximo defeito:** a instalação
fresca ponta a ponta com a marca de um revendedor — `install.sh` numa VPS, respondendo
`APP_NAME` com um nome de verdade, e conferindo os **cinco** artefatos que saem dali (aba,
ícone, e-mail de acesso, convite, endereço de suporte). É a mesma lacuna de
`vps-fresh-onboarding`: os testes provam que cada peça faz o que diz, não que a jornada de
quem compra funciona inteira. Os defeitos de marca que mais custam caro moram exatamente aí,
porque são vistos primeiro por um terceiro. **A receita para fechá-la está em J10, abaixo.**

## J10 — Instalação fresca com a marca do revendedor `[P0]` (receita manual)

**Por que isto é receita escrita e não spec.** O lugar natural desses casos seria
`tests/e2e/vps-fresh-onboarding.spec.ts`, e ela é a **única** spec do repo fora do CI —
`.github/workflows/e2e.yml`, bloco `FORA_DO_CI`. Nenhum job a invoca. Acrescentar dois
`expect()` ali produziria asserção que nunca executa, com a aparência de cobertura: pior que
a ausência, porque a ausência pelo menos se vê. Enquanto a spec não tiver quem a rode, o
artefato honesto é o procedimento — com os comandos exatos, para que a execução seja
repetível por outra pessoa e o resultado seja comparável.

**Estado:** `NÃO EXECUTADA`. Quem executar, troque por `PASS`/`FAIL` com data, SHA e as
evidências, e mova os achados para a tabela de defeitos.

**Pré-condição:** VPS limpa com acesso SSH, um domínio apontado para ela, um projeto
Supabase novo (ou `SUPABASE_ACCESS_TOKEN` exportado, para o `install.sh` criar), e uma chave
da Anthropic. **Deliberadamente SEM `RESEND_API_KEY`** — é o estado do primeiro deploy, e é
onde moram os piores defeitos de primeira impressão (`lib/email/resend.ts:94-108` devolve
`{ok:false,"not_configured"}` **em silêncio**).

```bash
# 1. Na VPS, com o kit na pasta corrente
bash install.sh
#    Responda com uma marca que NÃO seja a nossa — é o ponto do teste:
#      APP_NAME        → Vendas Turbo
#      APP_ACCENT_HEX  → #f2c94c   (o instalador valida a forma: # + 6 dígitos)
#      SUPPORT_EMAIL   → suporte@vendasturbo.exemplo
#      RESEND_API_KEY  → (Enter, pule)
#    ⚠️ Até `c8fc877d` o instalador NÃO perguntava a cor (`grep -c APP_ACCENT_HEX
#       install.sh` → 0), e todo revendedor recebia o verde do produto nos e-mails
#       de acesso. Se a pergunta não aparecer na sua execução, é regressão — o
#       caso da VPS limpa em `test-validators.sh` a vigia.

# 2. Confira que o domínio responde 307 (redirect para o login), não 404
curl -s -o /dev/null -w '%{http_code}\n' https://<DOMAIN>/

# 3. Logue como o admin criado pelo install, abra /admin/marca e grave a cor
#    (`#f2c94c` serve). Depois SAIA da sessão.
```

| # | Caso | O que conferir | Como |
|---|---|---|---|
| `J10.1` | **Aba** — quem abre o domínio vê o nome do revendedor | O `<title>` contém `Vendas Turbo` e **não** contém `Deskcomm` | `curl -s https://<DOMAIN>/login \| grep -o '<title>[^<]*</title>'` |
| `J10.2` | **Ícone** — o favicon carrega **deslogado**, na cor do revendedor | `/icon` responde 200 e o SVG tem o accent DERIVADO (não a semente crua) | `curl -s -o /dev/null -w '%{http_code}\n' https://<DOMAIN>/icon` e abrir a aba no browser |
| `J10.3` | **E-mail de acesso** — o "confirme sua conta" do GoTrue chega com a marca | Rodar `bash marca-emails.sh` e conferir na caixa real. **Sem `SUPABASE_ACCESS_TOKEN`, o script imprime o passo manual e a instalação segue** — esse ramo também é PASS, e é o caminho da maioria | caixa de entrada de verdade, não log |
| `J10.4` | **Convite** — sem `RESEND_API_KEY`, a tela mostra o `accept_url` em vez de falhar calada | `/app/team/invite` → convidar → a tela exibe o link | pela tela |
| `J10.5` | **Endereço de suporte** — o cliente do revendedor nunca vê o nosso | `SUPPORT_EMAIL` (resolvido em `lib/branding/saida.ts:238`) aparece em `/app/settings/billing` e em `/account-suspended`; sem ele, o parágrafo some em vez de mostrar um endereço nosso | pela tela, nas duas rotas |

**Armadilha conhecida (mede-se antes de concluir):** o bloco que escreve o `.env` é
truncante (`} > .env`) e reescreve o arquivo a partir de uma **lista fechada de `envq`**.
Chave que o kit não conhece é preservada no fim do arquivo (`PRESERVADAS`, `install.sh:1251`);
chave que a entrevista **pergunta e a lista de `envq` não tem** é respondida e perdida, sem
erro. É por isso que perguntar sem gravar é pior que não perguntar. Antes de dar `FAIL` em
qualquer caso acima, rode `source .env && echo "$APP_NAME|$SUPPORT_EMAIL"` e confirme que o
que você digitou está no arquivo — sintoma de marca ausente costuma ser isto, não o
resolvedor.
