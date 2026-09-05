# Mapa de Jornadas & Testes E2E — Experiência do usuário em VPS fresca

> Fonte da verdade do QA de produto do DeskcommCRM open-source. Cada caso aqui é
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
Wizard: welcome → whatsapp → (nuvemshop se `NUVEMSHOP_ENABLED`) → setup-ai →
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
| J1.6 | Connect WhatsApp: "Pular por enquanto" | avança pro step correto (setup-ai quando Nuvemshop off) |
| J1.7 | Setup IA: criar agente default | `ai_agents` criado **e a versão publicada aponta para o provedor que a instalação escolheu**, com o modelo curado DAQUELE provedor; avança |
| J1.8 | Invite team: enviar convite SEM Resend configurado (realidade da VPS fresca) | UI **não mente**: mostra que email não saiu + oferece `accept_url` copiável |
| J1.9 | Done: "Ir para o Inbox" | seta `onboarded_at`, cai no `/app/inbox` |
| J1.10 | Gate MFA pós-onboarding | blocker aparece; enrolar TOTP + ver/salvar recovery codes funciona de ponta a ponta |
| J1.11 | Abandonar no meio e voltar (fecha browser no step 3) | retoma exatamente no step pendente |
| J1.12 | Tentar `/app/inbox` antes de concluir | redirect pro onboarding, sem loop |
| J1.13 | Reabrir `/onboarding` depois de concluído | redirect pro app (wizard não reabre) |
| J1.14 | Stepper com Nuvemshop desabilitado | numeração/etapas não quebram visualmente |
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

> **A jornada J1 passou a ter GATE.** `tests/e2e/wizard-do-funcionario.spec.ts` roda no CI (SPECS_PARTE_1) e cobre o wizard inteiro pela tela — do login ao "Começar a usar" — criando a PRÓPRIA organização, porque o seed compartilhado entrega uma já onboardada e zerá-la mandaria as specs seguintes para dentro do onboarding. Fica de fora só o ensaio com resposta real, que exige chave de IA com saldo. `vps-fresh-onboarding.spec.ts` continua fora do gate (depende de WAHA, Redis, Resend e Nuvemshop) e segue sendo a prova mais completa, para rodar à mão.

> **Achado ABERTO (não é regressão, é primeira impressão):** percorrendo o wizard inteiro num tenant fresco, o botão "Começar a usar" entrega o dono no Inbox e a PRIMEIRA coisa que ele vê é um modal bloqueante de verificação em duas etapas — um sétimo passo que a barra de progresso do wizard nunca anunciou. O MFA obrigatório para `admin` é decisão de produto e está correto; o que está errado é ele aparecer como surpresa depois de seis passos que se apresentaram como o caminho completo. Conserto natural: virar passo do wizard, ou ao menos ser anunciado na tela final. Fora do escopo da frente do quadro de clientes.

> **J1.21 — FECHADA.** O agente do onboarding nascia `kind='rag_bot'` (o default do banco, de quando o produto só tinha o formato antigo), abria no editor legado — Temperature, Top K, Similarity threshold — e as capacidades que ele recebia ligadas ficavam **invisíveis** para o dono: funcionavam no runtime e não tinham superfície de configuração, que é o invariante 6 do Sistema Vivo quebrado.
>
> O que travava a virada era o editor novo exigir `credential_id`, enquanto instalação pelo kit funciona com a chave de plataforma do `.env` e não tem nenhuma linha em `ai_provider_credentials` — o dono cairia numa tela onde não consegue salvar nada. Resolvido nas duas pontas: `versionShapeSchema` aceita `credential_id: null` (= a chave da instalação), o seletor oferece essa opção, e a rota de versões **recusa** o nulo quando o ambiente não tem chave daquele provedor (falha fechada — senão publicaria um agente que morre em toda mensagem).
>
> MEDIDO na tela, num tenant fresco: o funcionário criado no wizard abre no editor atual, com "Chave de acesso: A chave desta instalação (anthropic)", o pacote "Vender e mover o funil" ativo, e a contagem de capacidades que ele traz. (O número saiu daqui: já dizia 12 quando eram 16, e o teto foi de 20 para 25. Para o valor de hoje: `pnpm exec tsx -e 'import("@/lib/ai/agents/capacidades-padrao").then(m => console.log(m.capacidadesPadraoDoOnboarding().length))'`.)

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
| J3.13 | A escolha sobrevive ao salvar e recarregar | o servidor aceita a lista (o mesmo teto da tela, `TETO_TOOLS_POR_AGENTE`, fonte única) e o estado volta igual · **PASS** |
| J3.14 | Ver se o que está ligado está funcionando (aba Capacidades) | usos, falhas, quantos vieram de teste, última vez — e o que fazer com cada número · **PASS** (números escritos pelo emissor real de audit) |
| J3.15 | O teto recusa a passagem, explicando em português | **PASS** — exercitável desde que o catálogo cresceu (57 capacidades). `capacidades-do-agente.spec.ts` liga "Atender" sobre as 8 do seed e prova a recusa por 1 vaga. A afirmação "não exercitável hoje, com 16 capacidades no catálogo" VENCEU |

## Chaves de acesso à IA `[P0]`

- `[P0]` Colar chave inválida e entender o motivo — `tests/e2e/credenciais-de-ia.spec.ts`. Achados corrigidos em 2026-09-02: lista de modelos colada por vírgula no card; "Validando…" eterno após restart; erro em código (`auth_failed_401`, no card e no toast); diálogo sem dizer quando usar cada provedor nem onde pegar a chave; contagem "em uso" divergente do DELETE. **PASS** — executada de verdade contra browser real (Supabase local pg17 + baseline + Chromium) em 2026-09-02, depois que o Docker da máquina (antes indisponível) voltou. A própria execução achou um SEXTO defeito que a leitura de código não tinha achado: `descreverErroDeValidacao` não classificava `TypeError` (o nome que o `fetch()` do Node usa para falha de rede/DNS) como erro de rede, e o card mostrava "Falha na validação (TypeError)." cru em vez da frase amigável — corrigido em `lib/ai/credenciais/erro-de-validacao.ts`, com caso de teste. Evidência em `.superpowers/evidence/credenciais-de-ia.png`.

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
| J4.36 | **Editar campos do funil pela barra da conversa** | só os customizados (`settings.fields`) aparecem como inputs; título/valor ficam no dossiê. Salvar grava `custom_fields` no mesmo PATCH do quadro e a seção relê · `tests/unit/inbox-campos-lead.test.tsx` |

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
| J6.11 | **Automação com envio que FALHA** (WhatsApp fora do ar) | aba Atividade diz **Falhou**, com a frase que explica o que conferir — nunca "Sucesso". Achado do relato de 2026-08-24: dizia Sucesso com a mensagem em `failed` (`automacao-diz-a-verdade.spec.ts`) |
| J6.12 | Automação adiada pela janela de envio do número | aba Atividade mostra **Aguardando horário** com o instante da nova tentativa — antes não gravava linha nenhuma e a tela ficava vazia |
| J6.13 | Formulário preenchido entra | aba **Leads recebidos** mostra a linha com quem/contato/fonte/quando/origem; o painel traz TODOS os campos, IP, página e UTM (`historico-de-captacao.spec.ts`) |
| J6.14 | **Formulário com campos que o mapeamento não reconhece** | a captação aparece como **Não entrou**, com o motivo em português e os campos crus — antes o site recebia 400 e não sobrava rastro nenhum na tela |
| J6.15 | `viewer` tenta abrir o histórico | redirecionado; a RLS de `webhook_lead_captures` exige `manager` (o formulário é PII) |
| J6.16 | Ação **"Mensagem escrita pela IA"** no ENTÃO | pede agente publicado + número + o contexto do que fazer com os dados; o agente sabe que é abordagem pós-formulário |

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
| J8.10 | **O cliente é AVISADO antes de a IA sair de campo** | mensagem ao lead dizendo que uma pessoa vai assumir, ANTES do silêncio | FAIL(BUG-06) → PASS |
| J8.11 | O aviso respeita o motivo | quem pediu para PARAR recebe confirmação da parada, não oferta de atendente | FAIL(BUG-06) → PASS |
| J8.12 | O aviso respeita a equipe real | conta sem ninguém configurado não recebe promessa de contato | FAIL(BUG-06) → PASS |
| J8.13 | A passagem por SENTIMENTO abre item na Central | `triggerHandoff` não abria nenhum — cliente sem resposta E time sem sinal | FAIL(BUG-07) → PASS |

Bugs desta jornada estão detalhados em `HANDOFF-ia-360.md` (BUG-01 a BUG-05) e em
`HANDOFF-handoff-avisa-o-lead.md` (BUG-06, BUG-07).

### BUG-06 — a passagem para humano era MUDA (2026-08-26)

Achado pelo dono do produto, em duas conversas reais na mesma hora, e a medição
no banco de produção mostrou que **são dois motores, não um**:

```
status  | bot_silenced_until | last_handoff_reason | force_human
open    | infinity           | requested_human     | t     <- performHumanHandoff (motor, pg)
pending | infinity           | low_sentiment       | f     <- triggerHandoff (CRM, supabase-js)
```

O pior caso não foi o pedido explícito: foi o do sentimento. Às 14:50:32 o agente
PERGUNTOU o e-mail do cliente; às 14:51:01 o worker de sentimento disparou o
handoff; às 14:51:27 o e-mail chegou e o turno foi pulado. Ele respondeu uma
pergunta da própria IA para o vazio.

**A ordem é obrigatória:** `performHumanHandoff` grava `force_human`, e o gate 1
da cadeia de envio o relê a cada tentativa — avisar depois é avisar ninguém.
Provado por sabotagem em `evidence/handoff-avisa-antes/sabotagem-ordem-invertida.txt`.

Guardas: `tests/invariants/handoff-avisa-o-lead.test.ts` (turno real contra
Postgres do baseline), `tests/unit/handoff-avisa-o-lead.test.ts` (varredura AST
dos dois motores) e `tests/unit/aviso-ao-lead.test.ts` (o texto).

---

## J11 — Saber quem está no comando da conversa `[P0]`

**Por que P0:** é a leitura que o atendente faz ANTES de qualquer ação, em toda
conversa que abre. J5.5 cobre transferir e J8 cobre a passagem IA↔humano; nenhuma
das duas cobria *ler o estado* — e foi exatamente aí que o dono do produto
relatou as quatro confusões.

**A causa não era de tela.** Medido no HEAD 927dfa51: `lib/agent-engine/` nunca
lê `assignee_kind` nem `assigned_to_user_id` (`grep -rn` → rc=1) e
`fn_conversation_assign` nunca tocava `bot_silenced_until`. Um atendente clicava
"Assumir" e o atendimento automático continuava respondendo o MESMO cliente — ele
só calava por 5 minutos deslizantes quando a pessoa ENVIAVA (`extendBotSilence`).
Nenhum selo de "você está no comando" podia ser verdade enquanto isso valesse.

Spec: `tests/e2e/inbox-quem-manda.spec.ts` (seed próprio, conversa nova a cada
execução). Evidência: `.superpowers/evidence/inbox-quem-manda/`.
Regra na tela: `lib/inbox/comando-da-conversa.ts` (+ 17 casos unitários).
Regra no banco: `tests/invariants/comando-cala-o-automatico.test.ts` (6 casos).

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J11.1 | Conversa normal diz quem manda | selo de comando mostra o automático — não a mesma cara de uma conversa largada na fila | PASS |
| J11.2 | Assumir muda o selo para a PESSOA, com nome | `OwnerBadge` com as iniciais e o nome do atendente | PASS |
| J11.3 | Assumir **para** o automático de verdade | `bot_silenced_until='infinity'` no banco — a tela mudar de cor não prova que o motor parou | PASS |
| J11.4 | O selo diz o PORQUÊ, não só que está pausado | "alguém assumiu" / "pausado para este cliente" / "volta em instantes" pedem ações diferentes e tinham a mesma frase | PASS |
| J11.5 | Existe caminho para DESLIGAR pela tela | botão "Pausar o automático" — antes só existia o de ligar | PASS |
| J11.6 | A volta existe e limpa o silêncio | "Devolver ao automático" → `bot_silenced_until` nulo | PASS |
| J11.7 | A troca de comando aparece na linha do tempo | "Assumiu a conversa" com o NOME de quem agiu, não "Você/time" | PASS |
| J11.8 | O rodízio NÃO cala o automático | `reason='routing'` não mexe no silêncio — senão uma org em round_robin perde a IA inteira | PASS (invariante) |
| J11.9 | Fechar devolve o comando | o silêncio é limpo ao fechar, senão vaza para o próximo episódio (a ingestão reusa a MESMA linha de conversa) | PASS (invariante) |

| J11.10 | A conversa que o automático ESCALOU aparece na Fila | `status='pending'` sem dono entra na aba e é contada pelo badge | FAIL → PASS |
| J11.11 | O número da fila é o MESMO para o cliente e para a equipe | `getQueuePosition` (o "você é o 5º" que o cliente ouve) e `getQueuePositions` (o "3º" da tela) contam os mesmos estados | FAIL → PASS |

**O achado que esta jornada abriu, e como ele cresceu.** A primeira rodada
registrou aqui "a conversa escalada não aparece em aba nenhuma" como pendência de
PR próprio. Ao medir, o defeito era maior e mais barato: a definição de "está na
fila" estava copiada em SEIS sítios que **não concordavam entre si** — o trigger
de roteamento do banco e a função que responde ao cliente contavam `open+pending`;
a aba, o badge, o painel do gerente e a posição mostrada na tela contavam só
`open`. Daí as duas consequências: a conversa que mais precisa de uma pessoa era a
única invisível, e o número de fila prometido ao cliente pelo WhatsApp não batia
com o que a equipe via.

Conserto: `CONVERSATION_QUEUE_STATUSES` (uma definição, quatro consumidores) +
separação entre o vocabulário de LEITURA (7 valores, o do banco) e o de ESCRITA
(5 — quem grava `pending` é o motor, e um cliente REST não pode fingir uma
escalação). Guardado por `tests/unit/fila-tem-uma-definicao-so.test.ts`, que varre
o fonte dos quatro sítios e compara o CONJUNTO do trigger com o da constante.

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

## J12 — A tela diz o que ESTA instalação consegue fazer `[P0]`

**Por que P0:** é primeira impressão pura. **Nenhuma instalação nasce com o par
VAPID** — o `.env.hostgator.example` grava as duas linhas vazias e gerar o par é
um passo opcional que ninguém é obrigado a dar. Ou seja, o estado testado aqui é
o estado em que 100% das instalações começam, e a tela de Notificações tem porta
na navegação (`lib/navigation/registry.ts:470`), então qualquer pessoa chega nela
no primeiro dia.

**O defeito era de tela, e o backend estava certo o tempo todo.**
`GET /api/v1/notifications/push` já devolvia `enabled:false` sem as chaves, e o
`PUT` já recusava com 503 «Web Push não configurado nesta instalação». Quem nunca
perguntou foi `app/app/settings/notifications/page.tsx`, que afirmava «In-app
(toast) e Push (Chrome) já funcionam para as cinco categorias» de forma
incondicional. A sequência que a pessoa vivia:

1. a tela promete Push;
2. ela liga o interruptor e o navegador pede permissão — incômodo real, cobrado dela;
3. ela concede, e `syncPushSubscription()` faz `return` em silêncio
   (`if (!cfg?.data?.enabled || !publicKey) return`);
4. o interruptor fica ligado prometendo o que a instalação não entrega, e **nada
   no produto** conta que faltam duas variáveis no `.env`, nem como consegui-las.

Informação que existe no servidor e não chega a quem decide é o mesmo que
informação ausente.

**O conserto exagerado, recusado de propósito:** desabilitar o interruptor sem
VAPID. Sem as chaves o aviso na bandeja **ainda funciona com a aba aberta** —
é `new Notification()` em `lib/notifications/emit.ts`, que não depende de
inscrição nenhuma. Desabilitar trocaria prometer demais por entregar de menos, e
o segundo não deixa rastro. **J12.5** existe para impedir esse conserto (era
J12.3, no `e2e`, até a medição mostrar que ali ela não era observável — ver
abaixo).

Spec: `tests/e2e/notificacoes-diz-o-que-falta.spec.ts` (estado SEM as chaves —
o do `.env.e2e` e o do primeiro deploy).
Evidência: `.superpowers/evidence/notificacoes-sem-chaves/`.
Os DOIS estados: `tests/unit/notificacoes-tela-diz-o-que-falta.test.tsx` — o
servidor lê `vapidPronto()` uma vez por processo, então provar o estado COM as
chaves pela tela exigiria um segundo `next start` só para trocar duas variáveis,
num job que já leva meia hora.

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J12.1 | Sem VAPID, a tela não fica muda | aviso `push-status-faltando-chaves` visível, e o de «pronto» ausente | PASS |
| J12.2 | Ela diz o que FAZER, não só o que falta | o comando `npx web-push generate-vapid-keys` e as duas chaves, nominalmente | PASS |
| J12.3 | O controle de Push não some, e a tela diz por que está travado | interruptor visível + «o navegador bloqueou as notificações» | PASS |
| J12.5 | VAPID ausente NÃO desabilita o Push | com `granted` e sem chaves, nasce habilitado | PASS (unit) |
| J12.4 | Com VAPID, anuncia a aba fechada | e para de mandar gerar o par que já existe | PASS (unit) |

**Por que J12.5 não é `e2e`, medido e não suposto.** Ela nasceu como asserção
`toBeEnabled()` na spec, e não podia viver lá. Medido no Chromium do Playwright,
contra um servidor HTTP local:

    baseline headless                              -> denied
    grantPermissions(["notifications"]) sem origin -> denied
    grant com origin explícito                     -> denied
    headless:false + grant                         -> granted

`Notification.permission` é **`denied` em headless, sempre**, e o CI roda
headless. Como `_client.tsx` desabilita por `denied || unsupported`, o controle
está travado ali por um motivo que nada tem a ver com VAPID — e nenhuma
permissão concedida muda isso. A asserção passou uma vez só porque ganhava a
corrida contra a hidratação; fechada a janela (`useSyncExternalStore` no hook),
ela passaria a falhar sempre, e com razão.

**NÃO COBERTO, declarado:** a notificação chegando na bandeja do sistema com a
aba fechada. Depende do serviço de push do navegador (FCM), de rede externa e de
um par VAPID real — não é reproduzível num runner, e fingir com mock seria pior
que a ausência declarada. O que está provado é o contrato entre a TELA e o
SERVIDOR. Continua aberto na issue #366.

## J13 — A Agenda como o dono do produto a usou na VPS `[P0]`

**Por que P0:** é a primeira impressão de um módulo que acabou de sair (v1.7.0).
O dono instalou na VPS dele, usou como um cliente usaria, e achou **seis defeitos
em quinze minutos**. Um sétimo aparecia no log de produção a cada cinco minutos e
ninguém tinha visto; um oitavo saiu de varredura. Todo módulo novo tem uma janela
em que ninguém o usou de verdade — esta jornada existe porque ela custou oito.

**O que a suíte não conseguia enxergar, e por quê.** Toda spec até aqui roda com
usuário de UMA organização. O defeito de escopo (D4) é invisível nesse cenário
por construção: sem duas organizações, a RLS e o filtro explícito devolvem
exatamente o mesmo conjunto. `scripts/seed-e2e-duas-organizacoes.ts` monta o
cenário que faltava — o MESMO usuário em duas orgs, com um tipo exclusivo em cada
uma, para a asserção poder ser sobre o CONJUNTO DE NOMES e não sobre a contagem.

| # | Caso | Resultado |
|---|---|---|
| J13.1 | Membro de duas organizações abre a Agenda e vê só os tipos da org ativa; trocar de organização troca a lista | **PASS** — `agenda-escopo-da-organizacao.spec.ts`, contra o app real. Evidência: `evidence/calendario/d4-agenda-escopo-org-b.png` |
| J13.2 | O aviso "você ainda não publicou seus horários" LEVA até onde se publica, e a aba de Atendimento se anuncia como o lugar dos horários | **PASS** — `agenda-caminho-ate-os-horarios.spec.ts`. Evidência: `evidence/calendario/d1-aba-atendimento.png` |
| J13.3 | Endereço de aba desconhecido cai na aba padrão, não numa tela sem conteúdo | **PASS** — mesma spec |
| J13.4 | O tipo de agendamento NASCE com responsável; quem escolhe "Definir depois" é avisado e o aviso ABRE o seletor | **PASS** — `agenda-tipos-de-agendamento.spec.ts`. Evidência: `evidence/calendario/d6-tipo-com-responsavel.png` |
| J13.5 | O dia apagado diz POR QUÊ, e o rótulo genérico antigo não volta | **PASS** — `agenda-kit-visual.spec.ts` |
| J13.6 | O teto de capacidades recusa a passagem explicando quantas vagas faltam | **PASS** — `capacidades-do-agente.spec.ts`, com o teto em 25 |
| J13.7 | A ida ao Google seleciona os pendentes (o filtro antigo devolvia HTTP 400) | **PASS** — medido contra o PostgREST real do ambiente e2e: filtro antigo `400 / 22007`, filtro novo `200` com as linhas pendentes |
| J13.8 | Sincronizar tira a linha da fila, e editar recoloca (o laço dos dois relógios) | **PASS** — medido no Postgres real: `true` → `false` com delta `00:00:00` → `true` |
| J13.9 | A credencial do Google não é servida pelo PostgREST | **PASS** — `anon` recebe `42501 permission denied`; `service_role` recebe 200 (controle positivo) |
| J13.10 | Cadastrar a credencial do Google pela tela do admin | **NÃO EXERCITADO** — a tela e a server action existem e o `next build` passa, mas o ambiente e2e não tem a chave mestra de cifra semeada (`fn_encrypt_oauth` levanta `NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente`), que é justamente o caminho em que a action RECUSA gravar. Falta o caso pela tela com a chave presente |

**Registro honesto do que NÃO foi exercitado:** `pnpm test:db` não rodou nesta
máquina — o daemon do Docker travou depois de o disco encher, e o harness de
invariantes exige contêiner. Os dois invariantes novos
(`agenda-ida-ao-google-termina`, `credencial-do-google-e-server-side`) estão
escritos e a SUBSTÂNCIA deles foi medida à mão contra o Postgres real do
ambiente e2e; falta a passada do harness no CI.

---

## J14 — Marcar um horário, na tela em que o dono marcou `[P0]`

**Por que P0:** os dois defeitos aqui impedem a ação central do módulo — escolher
um horário e chegar até ele. O dono achou os dois usando a v1.8.0 na VPS.

**A crítica que originou esta jornada, e ela é justa:** havia 20 casos Playwright
sobre esta tela (a J13) e nenhum pegou. Todos assertam PRESENÇA (`toBeVisible`,
`toHaveCount`), e **elemento cortado continua presente** — está no DOM, tem
tamanho, e o Playwright o considera visível. A borda que o corta é do PAI.
Presença nunca vai medir isto; só geometria mede.

| # | Caso | Resultado |
|---|---|---|
| J14.1 | A coluna de horários cabe no painel, e o painel no Sheet que o hospeda | **PASS** — `agenda-painel-cabe-na-tela.spec.ts`, por `boundingBox` em cinco larguras. Antes: painel de 982px num Sheet de 768, transbordando 239px |
| J14.2 | A coluna de horários fica dentro da VIEWPORT | **PASS** — antes, só 42 dos 280px apareciam, em 1280, 1440 e 1920 |
| J14.3 | Dá para CLICAR num horário | **PASS** — a geometria é o diagnóstico; a ação é o desfecho. Evidência: `evidence/calendario/d1-painel-cabe-1280.png` |
| J14.4 | Abaixo de `lg` os horários empilham sob o calendário | **PASS** — caso de 900px |
| J14.5 | O limiar de 1024px, onde as 3 colunas passam a valer com 44px de folga | **PASS** — é onde um ajuste de padding estoura primeiro |
| J14.6 | "Ver na agenda" leva até o compromisso, inclusive em outra semana | **PASS** — `agenda-ver-na-agenda.spec.ts`. O botão não tinha `onClick` nenhum. Evidência: `evidence/calendario/d2-ver-na-agenda.png` |

**Duas correções ao diagnóstico inicial, ambas medidas:**
1. O defeito de largura **não sumia em tela grande** — em 1920 o transbordo era
   idêntico, porque o Sheet é fixo em 768px e ancorado à direita.
2. A primeira versão da asserção de geometria media "coluna contra painel" e
   ficava vermelha — mas por medir no meio da transição de `width`. No estado
   estável ela PASSA. Falso vermelho hoje é falso verde amanhã; a spec passou a
   esperar a largura estabilizar, e a régua certa é o painel contra o Sheet.

**Sobre um diagnóstico que a medição derrubou:** ao ver 4 falhas num run de 5
specs juntas, atribuí ao `AUTH_RATE_LIMIT_LOGIN_IP` que o CI define e o ensaio
local não. **Estava errado** — o run seguinte passou 30/30 sem essa variável, e o
seguinte também. A diferença era tempo: 51s contra 11,2min, com um `next build`
disputando CPU. A diferença de ambiente entre ensaio e CI é real e vale saber,
mas não era a causa desta falha.

## J15 — A grade da Agenda como agenda de verdade `[P0]`

**Por que P0:** é a tela que quem atende deixa aberta o dia inteiro, e ela era
**desenho**. Sete colunas, faixas de hora, cards — e nenhum gesto: clicar num
espaço vazio não fazia nada, arrastar um compromisso não fazia nada. Marcar
exigia sair da grade, abrir "Novo agendamento" e reescolher no mini-calendário a
data que a pessoa acabara de apontar com o dedo. Nenhuma spec reprovava, porque
nenhuma spec tentava: as irmãs entram pelo botão e pelo histórico, que são
caminhos que já existiam.

**O jeito errado de consertar, e o que o vigia.** Calcular o horário a partir do
pixel clicado. A tela passaria a oferecer instantes que a disponibilidade
publicada não tem — 422 `agenda_disponibilidade_invalida` na cara de quem
clicou, e a agenda discordando do agente sobre o que está livre. A defesa é de
construção: a grade **pergunta** a `GET /api/v1/agenda/horarios-livres` (a mesma
rota do painel e do agente) e um bloco só é clicável quando existe horário
publicado ali. Ela não tem de onde tirar um instante que a regra não deu.

| # | Caso | Resultado |
|---|---|---|
| J15.1 | Clicar num bloco livre abre a marcação **naquele horário** — a asserção é o horário exibido, não que "algo abriu" | **PASS** — `agenda-grade-interativa.spec.ts`. Evidência: `evidence/calendario/grade-clique-abre-no-horario.png` |
| J15.2 | Bloco fora da disponibilidade não é clicável **e diz por quê** (`disabled` + razão no `aria-label` e no `title`) | **PASS** — mesma spec. Evidência: `evidence/calendario/grade-bloco-recusado-diz-por-que.png` |
| J15.3 | Arrastar um card remarca, e o horário novo é conferido **na API depois do reload** — não só na tela | **PASS** — mesma spec. Evidência: `evidence/calendario/grade-arraste-fantasma.png` e `evidence/calendario/grade-confirma-antes-de-remarcar.png` |
| J15.4 | Arrastar para fora da disponibilidade é recusado com o motivo, **nenhum PATCH sai**, e o card volta ao lugar (medido por `boundingBox`) | **PASS** — mesma spec. Evidência: `evidence/calendario/grade-arraste-recusado.png` |
| J15.5 | Geometria por ferramenta: o topo do card remarcado contra o topo da faixa daquela hora, tolerância de 2px | **PASS** — mesma spec |
| J15.6 | Remarcar pelo **teclado** (`Alt+↑/↓` salta de vaga em vaga, `Enter` confirma, `Esc` desfaz) pelo mesmo mecanismo do arraste | **PASS** — `tests/unit/agenda-grade-aceita-clique.test.tsx` (jsdom — o arraste por ponteiro precisa de geometria real e fica no Playwright) |

**As asserções foram provadas vermelhas antes**, e não só escritas depois:

| Sabotagem | Previsão | Medido |
|---|---|---|
| A camada de blocos vazios volta a não existir (a grade de antes) | 4 vermelhas | **4 vermelhas**, todas em "nenhum bloco livre na semana desenhada" |
| A recusa vira pergunta **e** o destino válido remarca sem confirmar | J15.3 e J15.4 vermelhos, J15.1 e J15.2 verdes | **exatamente isso** — "soltar remarcou sem perguntar" e `remarcacao-recusada` não encontrado |

**Dois defeitos que só apareceram executando** (nenhum apareceria lendo o código):

1. A grade oferecia a disponibilidade de `tiposIniciais[0]` — o primeiro tipo em
   **ordem alfabética**, escolhido por ninguém e sem seletor fora do painel de
   marcação. Numa organização com quatro tipos e jornada publicada em um só, a
   grade inteira travava com "não consegui carregar os horários" **enquanto
   havia vaga**. O tipo ganhou superfície na tela.
2. Card de compromisso **cancelado** cobria o bloco vazio e comia o clique — e
   cancelar é justamente o que devolve o horário (`cancelled` está em
   `SITUACOES_QUE_LIBERAM`). Numa clínica com uma semana de cancelamentos, todo
   horário reaberto ficaria inalcançável pela grade. O card perdeu o ponteiro e
   manteve a presença: é registro, não ação.

---

## J16 — Conectar o Google, e conseguir enxergar que conectou `[P0]`

**Por que P0:** o dono instalou a v1.9.0 e relatou quatro sintomas numa frase só
— "conecto, ELE DESLOGA DA MINHA CONTA, quando logo de novo diz que conectou, mas
nada funciona e o botão Conectar continua lá". Três defeitos independentes, e o
mais humilhante é que **a conexão sempre funcionou**: ninguém conseguia ver.

| # | Caso | Resultado |
|---|---|---|
| J16.1 | Voltar do consentimento não cai no `/login` | **PASS** — `agenda-google-volta-nao-desloga.spec.ts`. Sem o conserto, o usuário logado para em `/login?next=%2Fapp%2Fagenda%3Ferro%3D...`, medido em Chromium |
| J16.2 | O CHECK do banco proíbe o valor que três consultas procuravam | **PASS** — invariante `agenda-conexao-do-google-e-encontrada`, contra Postgres real |
| J16.3 | A conexão que o callback grava é encontrada pelo predicado do worker | **PASS** — mesmo invariante: 1 achada com o valor certo, 0 com o antigo |
| J16.4 | Nenhuma consulta filtra por valor que a coluna proíbe | **PASS** — varredura `consulta-usa-o-vocabulario-do-banco`; previ 3 achados antes de rodar e vieram os 3 |
| J16.5 | A lista de horários rola, e o último horário é clicável | **PASS** — `agenda-painel-cabe-na-tela.spec.ts`, viewport 1280×700. Evidência: `evidence/calendario/d4-lista-rola-1280x700.png` |

**Três correções ao briefing, todas medidas:**
1. A retenção do cookie no segundo salto era **dedução** marcada NÃO MEDIDA. Foi
   observada em navegador: é real, em Chromium. (Firefox não foi medido.)
2. A régua anti-regressão proposta (`body.scrollHeight - innerHeight <= 1`) vinha
   com a nota "já passa hoje". **Não passa** — e o crescimento é idêntico com e
   sem o conserto (1566px nos dois), portanto pré-existente. A régua passou a
   medir o que queria proteger: que o Sheet continua `position: fixed`.
3. A pré-condição de suficiência da lista comparava o conteúdo com a altura da
   JANELA; a régua certa é o espaço abaixo do topo da lista. Da primeira forma
   ela reprovou um cenário suficiente.

**Dívida declarada, não consertada aqui:** com o painel aberto em 1280×700 o body
vai a 1566px contra 700 de janela. É anterior a este PR e misturá-la esconderia
as duas.

---

## J17 — Trocar de organização, incluindo a que não foi configurada `[P0]`

**Por que P0:** o seletor de organização fica no topo de toda tela do produto e
é uma das ações mais banais do cabeçalho — e ela podia terminar num beco sem
saída. `app/app/layout.tsx:51` manda para `/onboarding` toda organização ativa
sem `onboarded_at`; o layout de `/app` sai inteiro da árvore e leva o
`TenantSwitcher` junto. Quem foi convidado para uma organização nova e trocou
para ver o que era **perdia o caminho de volta**: no wizard sobravam "Termos de
Uso", "Política de Privacidade" e um "Continuar" desabilitado — medido no
snapshot de uma falha do CI (run 33164258175), não deduzido. A saída real era
limpar os dados do site.

**Como o defeito apareceu, e por que ele estava escondido:** ele não foi
reportado por ninguém — saiu de uma `main` vermelha. Dois seeds
(`seed-e2e-funis` e `seed-e2e-duas-organizacoes`) inseriam em `organizations`
com o mesmo slug e colunas diferentes, e quem rodasse primeiro vencia. Com a org
de teste chegando sem `onboarded_at`, `agenda-escopo-da-organizacao` reprovava
com `element(s) not found` no seletor. O conserto do harness devolveu o CI ao
verde; o defeito de produto que ele expôs sobrevive a esse conserto, e é o que
esta jornada prende.

| # | Caso | Resultado |
|---|---|---|
| J17.1 | Trocar para uma organização não configurada leva ao wizard — o destino está certo, a organização não foi configurada mesmo | **PASS** — `troca-de-organizacao-tem-volta.spec.ts` |
| J17.2 | O seletor de organização **não** sobrevive ao redirect (é a razão de o wizard precisar de saída própria) | **PASS** — mesma spec, `toHaveCount(0)` |
| J17.3 | O wizard oferece o caminho de volta, e voltar traz para a organização de ANTES (conferido pelo nome, não por "saiu de lá") | **PASS** — mesma spec. Evidência: `evidence/onboarding/troca-de-org-tem-volta.png` |
| J17.4 | Sem outra organização, o controle não existe — prometer ação vazia é o controle decorativo | **PASS** — `tests/unit/onboarding-tem-saida.test.tsx` |
| J17.5 | Trocar **navega**: `setActiveOrg` revalida `/app`, não `/onboarding`, e sem o `replace` o clique pareceria não fazer nada | **PASS** — mesma unit |
| J17.6 | Dois seeds não criam a mesma organização (a classe, não a instância) | **PASS** — `tests/unit/seeds-nao-disputam-organizacao.test.ts`, com controle positivo contra a regex cegar |

**As asserções foram provadas vermelhas antes:**

| Sabotagem | Previsão | Medido |
|---|---|---|
| O layout volta a não montar a saída (o estado de antes) | J17.3 vermelho, `agenda-escopo` verde ao lado | **exatamente isso** — a cerca discrimina, não reage a qualquer estrago |
| A saída nunca renderiza | 3 unit vermelhos | **3** |
| Troca sem navegar | 1 unit vermelho | **1** |
| O slug compartilhado volta ao seed | o gate de seeds reprova nomeando os dois arquivos | **reprovou**, com `e2e-segunda-org ← seed-e2e-duas-organizacoes.ts + seed-e2e-funis.ts` |
| Seed antigo restaurado (`git show HEAD~1`) e re-semeado | `agenda-escopo` reprova como no CI | **reprovou** com `não terminou` + `element(s) not found`, literal |
## J18 — O follow-up anda em hospedagem sem agendador `[P0]`

**Por que P0:** para quem **não tem** o `scheduler` da VPS — o plano gratuito da
Vercel é o caso comum, e é o cenário inteiro do runbook
[`vercel-hobby-relogio.md`](../runbooks/vercel-hobby-relogio.md) — o relógio
externo não é conveniência: é o **único** motor do follow-up. E a falha dele é
silenciosa: os follow-ups não andam, ninguém recebe erro, e a instalação parece
saudável.

**O que existia media TEXTO.** `tests/unit/relogio-hobby-workflow.test.ts`
confere que o `.yml` cita o caminho do tick, a variável e o `exit 1` — ancora o
contrato do arquivo, não prova que uma batida faz alguma coisa. Nenhum teste, em
lugar nenhum, chegava a bater na rota. Era o item 2 da issue #366.

**O emissor é externo de propósito.** `execFileSync("curl", …)` — outro
processo, sem contexto de browser, sem cookie: é literalmente o comando que
`comandoCurlDoRelogio()` gera e que o runbook manda colar no cron-job.org.
`page.request` compartilharia o contexto do teste e provaria menos, já que a
rota está em `PUBLIC_PATHS` justamente porque quem a chama não tem sessão.

Spec: `tests/e2e/relogio-http-cron-externo.spec.ts` (`SPECS_PARTE_1`).

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J18.1 | Segredo errado é recusado | 403 **e** o enrollment não se move | PASS |
| J18.2 | 1ª batida executa o `wait` | agenda a espera para o futuro, `steps_taken` sobe | PASS |
| J18.3 | 2ª batida, vencido o prazo, avança | `current_node_id` chega ao nó final | PASS |

**Duas batidas, e não uma — medido.** A primeira versão do caso esperava avanço
numa batida só, e o run devolveu `{claimed:1, advanced:0, scheduled:1}`: um
enrollment vencido *parado* num nó `wait` significa "chegou a hora de EXECUTAR o
wait", e executar um wait é **agendar** a espera. O avanço só vem na batida
depois do prazo — que é exatamente o que um cron externo faz, batendo de poucos
em poucos minutos. O relógio do fixture é adiantado entre as duas porque o
mínimo do `wait` é 5 min por regra de produto (`graph-schema.ts` recusa
`duration_ms` abaixo de `300000`; com `1` o tick devolve `failed: 1`).

**Sabotado, com a previsão declarada antes de rodar:**

    auth aceita qualquer segredo   -> caso 1 vermelho, casos 2/3 verdes
    tick responde 200 e não acha
      o que avançar (claim vazio)  -> caso 1 verde, casos 2/3 vermelhos
    restaurado                     -> 2 de 2

**NÃO COBERTO, declarado:** o `.github/workflows/relogio.yml` em si — ele nasce
desligado (`RELOGIO_LIGADO`) e quem o exercitaria é o Actions de um fork, não
este job. O que está provado é que **a batida faz efeito**; que o agendador do
GitHub dispara no horário é do GitHub.

---

## J20 — A IA só atende quem tem origem elegível (gate opt-in por canal) `[P0]`

**Por que P0:** achado pelo dono do produto num número que é também o WhatsApp
pessoal/comercial dele — a IA respondeu automaticamente para cliente atual, dono
de incorporadora, contato pessoal, fornecedor e conversa antiga. O
DeskcommCRM responde `allow by default` (publicou agente para a sessão → atende
todo inbound); num número compartilhado com gente isso é a IA assumindo conversa
que não era dela.

**Contexto do código:** gate OPT-IN por canal —
`channel_sessions.metadata.ai_gate = 'allowlist'` (ausente / `'open'` =
comportamento de hoje). Com o gate, a IA só responde quando
`contacts.ai_authorized_at` está setado (por uma origem elegível) e dentro da
janela `AI_ALLOWLIST_TTL_DAYS`. A decisão é `lib/ai/elegibilidade/gate.ts`
(pura), consultada pelo drain (`lib/agent-engine/edge/crm/drain.ts`, decide
enfileirar) e pelo turno (`lib/agent-engine/agent/inbound-turn.ts`, decide
rodar). Origens que autorizam: webhook do Respondi
(`app/api/v1/webhooks/in/[token]`), match de campanha na ingestão
(`lib/channels/pos-entrada.ts` × `organizations.settings.campanhas_whatsapp`),
ação `send_ai_message`, retomada manual (`lib/escalacao/retomada.ts`).

| # | Caso | Expectativa | Cobertura |
|---|---|---|---|
| J20.1 | Cliente atual manda "boa noite" (gate allowlist, contato não autorizado) | IA NÃO responde; conversa fica humana | **UNIT** — `gate.test.ts` "teste 1/3/4/9", `drain.test.ts` "gate allowlist + contato NÃO autorizado" |
| J20.2 | Cliente atual com conversa aberta, não autorizado | IA NÃO responde (estado da conversa não pesa) | **UNIT** — `gate.test.ts` "teste 2" |
| J20.3 | Contato pessoal manda mensagem | IA NÃO responde | **UNIT** — coberto por J20.1 (mesma regra) |
| J20.4 | Fornecedor manda proposta comercial | IA NÃO responde automaticamente | **UNIT** — coberto por J20.1 |
| J20.5 | Conversa antiga de 3 dias; publicar agente | publicar NÃO dispara nada (`ai_agent.published` não tem consumidor) + o drain pula evento superado por inbound mais recente | **UNIT** — `drain.test.ts` "evento superado por inbound mais recente"; **CÓDIGO** — grep: zero consumidor de `ai_agent.published` |
| J20.6 | Nova submissão Respondi → o contato fica elegível | IA pode responder o retorno do lead | **UNIT** — webhook seta `ai_authorized_reason='respondi:<form>:<sub>'`; **E2E** — `tests/e2e/j20-elegibilidade-respondi.spec.ts` (submissão real na URL da fonte → `ai_authorized_at` carimbado → o retorno pelo WhatsApp gera `job_queue` `inbound_turn`; CONTROLE: número sem Respondi no mesmo canal → evento `done` sem job) |
| J20.7 | Segundo turno do Respondi (dias depois, conversa viva) | IA continua atendendo (keep-alive renova o carimbo) | **UNIT** — `gate.test.ts` "teste 6/7"; keep-alive em `inbound-turn.ts` |
| J20.8 | Nova mensagem de campanha com identificador autorizado | IA pode assumir | **UNIT** — `campanha.test.ts` "teste 8" |
| J20.9 | Nova mensagem genérica "oi" | IA NÃO responde | **UNIT** — `campanha.test.ts` "teste 9" + `gate.test.ts` |
| J20.10 | Conversa marcada human_only (`force_human`) | IA nunca responde até reativação explícita | **UNIT** — `gate.test.ts` "teste 10", `drain.test.ts` "force_human" |
| J20.11 | Follow-up em lead Respondi elegível | funciona | **CÓDIGO** — silence-sweep só barra quem o gate barra |
| J20.12 | Follow-up em cliente atual (não autorizado, gate allowlist) | NÃO enrola | **CÓDIGO** — `silence-sweep.ts` `loadSilentContactIds` pula `gateAllowlist && !autorizado`; **E2E** — `tests/e2e/j20-elegibilidade-followup.spec.ts` (fluxo de silêncio publicado pela API + cron real: silencioso autorizado → nasce `followup_enrollments`; silencioso NÃO autorizado, mesmo canal → nenhum enrollment) |
| J20.13 | Reinício do worker com backlog de eventos pending | zero disparos: cada evento cujo inbound já foi superado vira `done` sem job | **UNIT** — `drain.test.ts` "evento superado por inbound mais recente" |
| J20.14 | Submissão antiga (fora do TTL) | NÃO reativa a IA sozinha | **UNIT** — `gate.test.ts` "submissão antiga (fora da janela)", `drain.test.ts` "autorização EXPIRADA" |
| J20.15 | Org SEM versão de agente publicada (caminho legado `ai-response-worker`), gate allowlist, contato não autorizado | IA NÃO responde por este caminho tampouco | **UNIT** — `ai-response-worker-elegibilidade.test.ts` (skip `nao_elegivel_para_ia` antes de ler mensagem/agente; fail-closed em erro de leitura) |
| J20.16 | Follow-up de TEXTO FIXO drenado inline (`enviarTextoFixoPendente`, sem worker), contato não autorizado | NÃO envia; job vira `done` | **UNIT** — `enviar-texto-fixo.test.ts` "conversa NÃO elegível" (+ fail-closed volta pra `pending`) |
| J20.17 | Cliente antigo irritado (gate allowlist, não autorizado) → worker de sentimento dispara `low_sentiment` | `triggerHandoff` NÃO dispara: sem "um humano vai te atender", sem mexer no estado da conversa | **UNIT** — `handoff-orchestrator-elegibilidade.test.ts` (`bloqueioPorAllowlist` e `conversa_silenciada` barram; fail-closed em erro) |
| J20.18 | Eu respondo o cliente à mão pelo meu WhatsApp numa conversa autorizada | IA para naquela conversa por um PRAZO (`PRAZO_DO_SILENCIO_MS`, 60 min) renovado a cada nova fala humana, SEM apagar `ai_authorized_at`; volta sozinha quando o prazo vence, ou antes por "devolver ao automático" | **UNIT** — `atendimento-manual.test.ts` (as duas pontas do prazo medidas pelo motor real `decidirElegibilidade`, renovação, e o que NUNCA encurta: `'infinity'` do handoff formal e janela mais longa) + `waha-ingest-atendimento-manual.test.ts` (via `dispatchWahaEvent` real; eco do próprio envio NÃO pausa) + guarda de fonte no Zernio + fiação em `handoff-fernando-fiacao.test.ts`; **E2E** — `tests/e2e/j20-elegibilidade-atendimento-manual.spec.ts` (webhook `fromMe` genuíno → `bot_silenced_until` finito e futuro, nunca `'infinity'`, + rastro; `ai_authorized_at` intacto; 2ª mensagem RENOVA o prazo; tela mostra o selo; "devolver ao automático" solta a trava e a autorização continua) |
| J20.19 | Worker parado acorda com backlog; dois inbound antigos com o MESMO `sent_at` | a "última inbound" é a mais RECENTE (por `created_at`), nunca a de maior uuid — o evento antigo é pulado | **INVARIANTE** — `tests/invariants/drain-recencia-inbound.test.ts` (Postgres real) + `drain.test.ts` guarda a cláusula `coalesce(sent_at, created_at)` |

**Sabotagem que confirma:** removendo o veto `sem_autorizacao` de
`decidirElegibilidade`, `gate.test.ts` e `drain.test.ts` reprovam; restaurado,
verde. Para J20.19: `order by id desc` sozinho elege a mensagem ANTIGA — o
próprio invariante prova isso na asserção de sanidade.

**Cobertura de caminhos de envio (R1 — nenhum atalho):** o gate
(`lib/ai/elegibilidade/gate.ts`, regra pura) é consultado por TODOS os produtores
de resposta automática: drain + turno do agent-engine (`consulta-pg.ts`),
`ai-response-worker` legado, `enviarTextoFixoPendente`, `runAgent` legado
(`lib/ai/runtime/agent.ts`), `triggerHandoff` e o worker de sentimento
(`consulta-supabase.ts`). `send_ai_message` é origem elegível (autoriza e então
envia). Todos fail-closed: erro de leitura da elegibilidade → não responde.

**E2E (ambiente fresco estilo VPS):** J20.6, J20.12 e J20.18 têm spec própria
(`tests/e2e/j20-elegibilidade-*.spec.ts`), rodando no job `e2e` do CI. Seed
compartilhado `scripts/seed-e2e-elegibilidade.ts` (canal com `ai_gate='allowlist'`
+ credencial validada + fonte de captação); helpers de SQL cru
`scripts/e2e-elegibilidade-helpers.ts` (roda 1 tick do `drainTick` real — a suíte
não sobe worker —, lê `job_queue`/`event_log`/`followup_enrollments`, semeia os
dois estados de partida do gate). A submissão do Respondi e as mensagens do WAHA
entram pelas rotas REAIS do app (`/api/v1/webhooks/in/:token`,
`/api/v1/webhooks/waha/:token`). O agente publicado é SETUP via helper porque
`POST /api/v1/ai/agents` exige role `admin`/MFA e o agente não é o que está sob
teste.

**A tela do knob `ai_gate` e do editor de `campanhas_whatsapp` ainda não existe**
— hoje se liga por script/SQL (`scripts/ativar-gate-elegibilidade-ia.ts`), como o
`roteamento_de_formulario`. É a dívida declarada desta entrega.

**Dívida no `campanhas_whatsapp`:** o campo `agent_id` de uma campanha é aceito
no schema mas **NÃO é roteado** — o match só torna o contato elegível
(`ai_authorized_reason = campanha:<id>`); quem assume o turno é sempre o
roteador / agente publicado da sessão. Encaminhar por campanha exige levar
`agent_id` no payload de `ai_agent.dispatch_requested` e o `resolve-turn-agent`
respeitá-lo. `label`/`segmento` são display-only (dependem da tela).

---

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
- ~~O autenticador registra o nome fixo "DeskcommCRM", ignorando o `APP_NAME` que o
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

## Acervo de conhecimento — o acervo é da organização (2026-08-26)

> **O que o CI NÃO prova aqui.** `tests/e2e/acervo-de-conhecimento.spec.ts` tem 6
> casos, e **4 deles pulam no CI** por falta de `OPENAI_API_KEY_E2E` — chave paga,
> que não vai para segredo de repositório público. Medido, não suposto: a parte 2
> do `e2e` era `73 passed / 0 skipped` na main sem a spec e virou `75 passed /
> 4 skipped` com ela. O CI prova que a tela DIZ que falta chave e que o material
> sem chave fica esperando; **que o material vira trecho buscável — o produto — só
> é provado rodando a spec com a chave**, e essa rodada está em
> `evidence/acervo-de-conhecimento/`. Mesmo formato do aviso que a doutrina já dá
> sobre `vps-fresh-onboarding`: um `skip` silencioso é indistinguível de um `pass`
> no placar agregado.

**A afirmação de 2026-07-30 abaixo ("implementado e provado") era verdadeira para
UM caminho e falsa para o produto.** O que estava provado era: FAQ colada, pelo
agente padrão, numa organização com a chave no `.env`. Fora disso, medido agora:

| # | Achado | O que a pessoa via |
|---|---|---|
| 1 | 🔴 **O indexador resolvia o agente pela ORGANIZAÇÃO** (`resolveAgent(organizationId)` → `is_default desc, created_at asc, limit 1`) e ignorava o `agent_id` que os três emissores mandavam no payload | com dois assistentes, o material do segundo nunca virava trecho. Sem erro, sem estado, sem nada na tela |
| 2 | 🔴 **A tela de conhecimento era presa a `is_default = true`** — e todo agente criado pela interface nasce `is_default: false` | o acervo de qualquer assistente que você criasse era inalcançável |
| 3 | 🔴 **Cadastrar a chave da OpenAI pela tela não habilitava nada.** `lib/ai/embed.ts` lia só `process.env`, enquanto `lib/ai/pontos/provedores.ts` promete na tela que a OpenAI é "necessária para indexar o seu material" | a pessoa cadastrava a chave em IA › Credenciais e o material continuava parado |
| 4 | 🔴 **Sem chave, o evento era consumido para sempre.** O worker devolvia `skipped`, e `drain.ts` conta `skipped` como sucesso | cadastrar a chave depois não recuperava o que ficou para trás |
| 5 | 🔴 **Upload de arquivo extraía o texto e DESCARTAVA** (`ingestPolicyFile` devolvia `{ chunkCount }` sem persistir), e a rota não tinha chamador nenhum na interface | o PDF subia e o agente nunca sabia o que estava nele |
| 6 | 🔴 **Preparar um material derrubava o outro**: a ingestão de conversas e a de FAQ competiam pelo único `active_kb_version_id` do agente | quem indexasse por último apagava o acervo do outro |
| 7 | 🔴 **Debounce sem timeout travava o evento para SEMPRE.** Com o Redis configurado e inalcançável — VPS com o contêiner caído —, `redis.set()` não voltava; `drainEventLog` marca `processing` ANTES do handler e **nada devolvia a linha** (o `job_queue` tem reaper, o `event_log` não tinha) | material cadastrado, nada acontece, e nem tentar de novo resolve |
| 8 | 🟠 **Arquivar não liberava o espaço** — nenhuma linha do repo jamais escreveu `is_active = false` | não dava para criar outro material do mesmo tipo, nunca mais |
| 9 | 🟠 **O limiar do código (0.72) vencia o calibrado (0.40)** em três sítios | paráfrase descartada: "posso trocar se não servir?" não achava a resposta escrita |
| 10 | 🟠 **Duplicar assistente perdia `pipeline_ids`**, e três INSERTs aceitavam `operator_*`/`pipeline_ids` no corpo e os descartavam | a cópia nascia sem escopo, com 201 dizendo que deu certo |
| 11 | 🔴 **Segurança**: as 4 tabelas do acervo aceitavam escrita de `viewer` pelo PostgREST | qualquer membro apagava a base de conhecimento da organização |
| 12 | 🟠 **O diálogo de cadastro não cabia na tela** — o botão "Adicionar ao acervo" ficava fora da viewport em 720px | o formulário existia e não se enviava (achado pela prova de tela) |

**Prova**: `tests/e2e/acervo-de-conhecimento.spec.ts` (6 casos, jornada inteira
pela tela) + `tests/invariants/rag-acervo-da-organizacao.test.ts` (recorte da
busca, versões legadas, imutabilidade do escopo, RBAC das 4 tabelas) +
`tests/unit/dreno-nao-perde-evento.test.ts`.

**NÃO MEDIDO**: o comportamento com acervo grande (milhares de trechos). O índice
vetorial `ivfflat` existe e o planner não o escolhe com o recorte de tenant — a
busca é exata e linear, correta e sem teto de recall. Vira issue.

---

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
| U1 `[P0]` | Instalação nova nasce pinada numa VERSÃO, não em canal móvel | coberto — `hostgator-setup-kit/test-validators.sh` roda o `install.sh` contra um remoto local com tags e cobra o `.env` |
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
`hostgator-setup-kit/marca-emails.sh` (os e-mails de acesso) e o mapa
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

---

## Por que uma IA publicada não responde — seis causas medidas numa VPS real (2026-08-18/19)

Investigação dirigida pela tela numa instalação EasyPanel com WhatsApp real,
agente publicado e o dono relatando "a IA não responde". Nenhuma das seis causas
aparecia como erro para quem operava: a conversa mostrava **"IA atendendo"** o
tempo todo. É a jornada `J3`/`J8` vista de perto, e o padrão é sempre o mesmo —
**um lugar que engole a resposta e devolve sucesso**.

| # | Onde | Defeito | Como foi provado | Correção |
|---|---|---|---|---|
| 1 | `edge/crm/session-watchdog.ts` | Hold `go_live` (número novo) mandava **todo `inbound_turn`** para `run_after='infinity'` — não só o disparo proativo. O único sinal era um item de Central `info` falando de "outbound" | item aberto na Central + zero `llm_calls` para a conversa | hold reason-aware: `go_live` retém só `followup_turn` |
| 2 | `resolve-turn-agent.ts` | Roteador **ativo com zero membros e sem fallback** derrubava a sessão inteira no agente genérico, que caía em `settings.llm` sem credencial → `LlmNotConfiguredError` → 5 tentativas → job morto | `GET /api/v1/ai/routers` (`member_count: 0`) + aviso `Job descartado após esgotar tentativas` | sem fallback, atende o agente publicado da sessão |
| 3 | `agent/inbound-turn.ts` | Fora da **janela anti-ban** (7h–22h) o veto do `pacingGate` virava erro de ensino ao modelo: turno terminava `ok`, sem envio e sem reagendamento | run `agent_turn` `ok` às 22:56 e **zero outbound** na conversa | reagenda o job para a abertura (doutrina `restricao-de-canal.md` §2) |
| 4 | `agent/agent-config.ts` | **Horário de funcionamento** da versão publicada (08:00–18:00 seg–sex) não era lido por ninguém vivo — só pelo dispatcher legado, hoje NO-OP | agente respondendo 21:55 de uma terça | janela lida no turno; fora dela, adia |
| 5 | `followup/node-handlers.ts` | Enrollment morria com `action_turn_never_completed` em ~25 min esperando a janela abrir | enrollment `dead` no nó de abertura com o worker vivo | backoff + orçamento de ~11h |
| 6 | `ai/log-invocation.ts` + card do agente | Duas telas mentindo: `erro_legado` no lugar de `limite_ou_saldo` (chave sem saldo), e o card anunciando o modelo da **criação** (`claude-sonnet-5`) enquanto o motor rodava o da **versão publicada** (`nvidia/nemotron-…:free`) | `/app/ai/runs` + `GET /versions` | `normalizarErro` no caminho legado; card lê a versão publicada |

**Lição para o mapa:** nenhum desses casos falha com tela vermelha. Todos falham
com **status verde e mensagem ausente**. Um caso de jornada que só verifica "a
tela não deu erro" passa em todos os seis — a prova precisa ser sempre *a
mensagem chegou no WhatsApp do lead*.
## O sistema cabe num telefone de 390px? (2026-08-20)

Origem: issue #203 — em 390px o shell reservava a faixa do sidebar de desktop
(`ml-60`/`ml-16`) e o header vazava para fora, medido `scrollWidth=462` contra
`clientWidth=390`. O usuário leigo abre o CRM no celular; barra horizontal na
primeira tela é a primeira impressão.

| caso | prioridade | estado |
|---|---|---|
| Em 390×844, o sidebar de desktop sai da árvore acessível e a navegação vira gaveta | `[P1]` | **PASS**, medido por ferramenta em `tests/e2e/navegacao.spec.ts` (bloco `mobile`): `documentElement.scrollWidth <= clientWidth + 1` depois do login, com a gaveta aberta, e depois de navegar por ela. Evidência em `.superpowers/evidence/nav-mobile-390-drawer-aberta.png` — a captura é apoio, quem afirma é a medida |
| `/admin` em 390px | — | **NÃO COBERTO.** `components/admin/AdminSidebar.tsx:58` é `w-60` sem prefixo responsivo: o mesmo defeito da #203, instância não consertada. Público é só platform admin, por isso ficou como issue e não como bloqueio |
| Estouro DENTRO do `<main>` | — | **NÃO COBERTO.** `AppShell.tsx` dá `overflow-auto` ao `<main>`, que é contêiner de rolagem próprio: conteúdo largo rola lá dentro sem aumentar `documentElement.scrollWidth`. A sonda é fiel ao sintoma da #203 e não prova que as telas densas (Kanban, Inbox) são usáveis em 390px |

**Armadilha que custou dois testes verdes:** `loginComoAdmin` espera a virada da
janela TOTP entre logins consecutivos (o servidor recusa código repetido), e
essa espera sozinha estoura o teto global de 30 s do `playwright.config.ts`.
Toda spec que usa o helper sobe o teto (240 s em quatro delas, 90 s em uma) —
isso não está escrito em lugar nenhum, e quem adota o helper sem subir o teto vê
dois testes alheios estourarem sem call log de locator. Se você for adotar o
helper numa spec nova: `test.describe.configure({ timeout: 120_000 })`.

## O menu inteiro cabe na dobra de um notebook? (2026-09-04)

Origem: PR #546 pôs a tela de **Tarefas** no grupo CRM e o menu passou a rolar.
Medido pela tela, 1280×900, logado como admin: `nav.scrollHeight` **776** contra
**763** de altura útil — **13px** de excesso, 19 links, 5 grupos. Nenhum título
de grupo caía fora da dobra; o que quebrava era o `rola`.

A resposta NÃO foi raspar densidade: o comentário de `components/shell/Sidebar.tsx`
já dizia, desde a vez em que Produtos estourou a dobra por uma linha, que "quando
o quinto destino de CRM aparecer, é hub que se cria, não mais 4px que se raspa".
Tarefas foi o quinto. Criou-se `/app/crm` — o mesmo mecanismo (`group.hub`) que o
grupo IA já usava.

| caso | prioridade | estado |
|---|---|---|
| Em 1280×900 o menu inteiro cabe sem rolar | `[P1]` | **PASS**, medido por ferramenta em `tests/e2e/navegacao.spec.ts`: `scrollHeight` **763** = altura **763**, excesso **0**, 18 links. A folga real — distância entre o fim do último grupo e o fim da caixa de conteúdo da `<nav>`, que o `scrollHeight` grampeado NÃO revela — é **19px** |
| Etapas do funil continua alcançável pelo CRM, não por Configurações | `[P1]` | **PASS**, e o caminho é percorrido inteiro: sidebar → "Ver tudo em CRM" → `/app/crm` → card → `settings/tenant/pipelines`. Evidência em `.superpowers/evidence/nav-hub-crm.png` |
| Produtos, que saiu do menu, continua tendo porta (DoD 14) | `[P1]` | **PASS**, caso próprio na mesma spec: o link não existe no sidebar (`toHaveCount(0)`) e existe no hub |
| A folga de 19px é real | — | **PROVADO POR SABOTAGEM.** Um sexto destino de CRM com `sidebar: true` devolve o excesso a exatamente **+13px** e reprova o mesmo caso — previsto antes de rodar, e batido |
| 19px é menos de uma linha (28px + 4px de intervalo = 32px) | — | **ACEITO, com a saída declarada.** O próximo item de sidebar volta a estourar. Só que CRM, IA e Organização têm hub: tela nova em qualquer um dos três não pressiona mais o menu. Quem ainda pressiona é grupo SEM hub — Atendimento (4), Canais (3), Análise (3) —, e para eles a resposta escrita é a mesma: cria-se o hub |

**O que a medição do `scrollHeight` NÃO responde:** quando o conteúdo cabe, ele é
grampeado no `clientHeight`, então "excesso 0" e "sobra 200px" dão o MESMO número.
Quem quiser saber quanta folga restou tem de medir o `bottom` do último filho
contra a caixa de conteúdo da `<nav>` — foi assim que os 19px saíram.

## O inbox em tempo real — o defeito que veio de fora (2026-08-24)

**Sintoma relatado pelo dono:** *"Recebemos mensagem e só reflete no inbox (na
UI) se atualizarmos a página."*

**Causa raiz, medida no socket — não estava em nenhuma linha nossa.** O cookie
de sessão é httpOnly, então o supabase-js do browser não enxerga a sessão. Nesse
caso a callback `accessToken` PADRÃO do `SupabaseClient` termina em
`?? this.supabaseKey`: **o socket do Realtime assinava com a anon key**. Canal
anônimo responde `SUBSCRIBED`, a RLS filtra do outro lado, e ele nunca entrega
nada — em silêncio, com todo sinal disponível dizendo "saudável".

O repo já corrigia isto chamando `supabase.realtime.setAuth(token)`. **Aquilo
parou de funcionar num bump de dependência**, sem uma linha nossa mudar: a
partir do realtime-js 2.112.x a callback vence o token manual, o que a própria
biblioteca documenta em `setAuth` — *"the callback is the source of truth (…)
even after a bootstrap/override `setAuth(token)` call"*.

**Como foi medido** (ligando o `logger` do realtime-js e instrumentando
`setAuth`, com dois canais no mesmo socket — que é o que o inbox faz, lista +
conversa aberta):

| Sonda | O que assinou | Entregas |
|---|---|---|
| tabela de controle sozinha, policy `using(true)` | 1 canal | **entregou** |
| `conversations` sozinha | 1 canal | **entregou** |
| controle **+** `conversations` no mesmo socket | 2 canais | 1º entregou, **2º zero** |

O `phx_join` do 1º levava `{"iss":"…/auth/v1"}` (JWT do usuário); o do 2º levava
`{"iss":"supabase-demo","role":"anon"}`. Instrumentando `setAuth`: o token do
usuário durava ~2ms antes de `_setAuthSafely` o trocar, e o heartbeat (~30s)
refazia a troca para sempre.

**O que a tabela de controle provou, e por que ela importa.** Sem ela, "zero
entregas" seria indistinguível de instrumento quebrado — que devolve zero do
mesmo jeito. Ela é o controle positivo que valida a sonda.

**Conserto:** fonte ÚNICA de token, na callback `realtime.accessToken` de
`lib/supabase/browser.ts`. Ela é melhor que o `setAuth` por uma razão que
independe do bug: o socket a chama de novo a cada heartbeat e em cada reconexão,
então o token de 1h deixa de ser bomba-relógio para quem fica com o inbox
aberto. Sai do `useRealtimeChannel` toda a dança de auth — mantê-la seria manter
duas fontes, que era o defeito.

**Segundo achado, do mesmo puxão:** o inbox era **a única tela viva sem rede de
segurança**. Board (`useBoard`) e linha do tempo (`useLeadTimeline`) já usavam
`useRefetchDeSeguranca`; o inbox tinha só `refetchOnWindowFocus`, que exige
TROCAR DE ABA. E o inbox é a tela em que se fica parado olhando: com o canal
morto e a aba em foco, a lista ficava congelada indefinidamente num passado que
parece presente. Agora as duas pontas (lista e conversa) têm a rede.

**Por que os testes estavam verdes o tempo todo** — a lição que vale além deste
bug: eles exercitavam `authenticateRealtime` contra um cliente FAKE
(`{ realtime: { setAuth: vi.fn() } }`) e afirmavam que `setAuth` fora CHAMADO. O
que quebrou foi o EFEITO de chamá-lo. **Teste que guarda a chamada em vez do
comportamento não vermelhece quando o comportamento morre.**

| # | Caso | Prova |
|---|------|-------|
| JR.1 | Mensagem chega na conversa ABERTA, sem reload | `tests/e2e/inbox-tempo-real.spec.ts` (dirige a tela; nenhum `reload()` depois de abrir o inbox) |
| JR.2 | A LISTA reage à mesma mensagem | mesmo spec — é o 2º canal do socket, o que ficava anônimo |
| JR.3 | A callback é a fonte do token, e nunca a anon key | `tests/unit/realtime-token-do-socket.test.ts` |
| JR.4 | O hook não autentica por conta própria (fonte única) | idem |
| JR.5 | Token perto de vencer é renovado; token válido vem do cache | idem |
| JR.6 | As duas pontas do inbox têm rede de segurança | `tests/unit/realtime-reconecta.test.ts` |

**Sabotagens que confirmam que os testes vigiam** (rodadas em 2026-08-24, com o
conserto já commitado):

| Sabotagem | Reprovações |
|---|---|
| remover a callback de `browser.ts` | 6 de 7 |
| a callback devolve a anon key (o que a PADRÃO fazia) | 3, incluindo *"devolve o token da sessão — NUNCA a anon key"* |
| tirar a rede de segurança da lista de conversas | 1, apontando a lista |

**A prova que fecha o caso — o mesmo teste dos dois lados** (2026-08-24, build de
produção contra o Supabase local, banco semeado pelos scripts do repo):

| Código sob teste | Resultado |
|---|---|
| com o conserto | `1 passed` — a mensagem apareceu na tela sem reload |
| revertido ao da `main` (`git checkout main -- lib/supabase/browser.ts hooks/realtime/useRealtimeChannel.ts`) | `1 failed` — *element(s) not found*, 25 s |

Reverter **só o fonte**, mantendo o teste, é o que separa "o teste vigia" de "o
teste passa". Um verde sozinho não distingue as duas coisas.

⚠️ **Achado de ambiente, não do repo:** o build morria com
`'node_modules/node_modules' is a symlink causes that causes an infinite loop!` —
um symlink auto-referente de 2026-08-13, resíduo de sessão anterior (nenhum
script do repo o cria). E o primeiro build parecia ter passado porque
`pnpm e2e:build 2>&1 | tail -20` devolve o exit do `tail`, não o do build
([[feedback-pipe-tail-mascara-exit]]). Confira `.next/BUILD_ID`, nunca o exit de
um pipe.

### Vai escrever uma spec que depende de tempo real? Leia isto primeiro

**No CI, o Realtime sobe ANTES de as tabelas entrarem na publication.** O `e2e.yml` faz
`supabase start` (que sobe o Realtime) e só depois aplica o `baseline.sql`, que é quem
adiciona `messages`, `conversations`, `crm_leads` e as demais à publication
`supabase_realtime`. O Realtime já subiu sem elas e não as reconhece depois: **assina,
responde `SUBSCRIBED` e nunca entrega**.

Custou três rodadas de CI de 15 minutos para achar, porque o sintoma é idêntico ao do canal
anônimo — os dois respondem `SUBSCRIBED` e calam. O que separou os dois foi cruzar o log do
script (`[e2e-chega-mensagem] entregue em 6f5fd1f2…`) com o snapshot da página no mesmo
instante (`"Nenhuma mensagem nesta conversa."`): gravado no banco, nunca entregue à tela.

Há um passo no `e2e.yml` que reinicia o Realtime depois do baseline e resolve isso. **Ele
existe desde o PR #327 — confira que continua lá antes de culpar o seu código:**

```bash
grep -c "Reiniciar o Realtime" .github/workflows/e2e.yml   # 1 = está lá
```

Na VPS o problema não existe: o `install.sh` aplica o baseline e só então o compose sobe os
serviços. É o CI que inverte a ordem.

⚠️ **Uma spec que navega com `page.goto()` antes de cada asserção NÃO exercita o canal** —
ela refaz o fetch e passaria mesmo com o tempo real morto. `inbox-quem-manda.spec.ts` é assim
(medido: `goto` nas linhas 174 e 272, asserções depois), e por isso ela não foi afetada pelo
defeito acima. Se a sua spec existe para provar tempo real, ela não pode recarregar depois de
abrir a tela — e vale afirmar `data-realtime-status="subscribed"` **antes** de provocar o
evento, senão um canal que suba tarde passa igual.

**A `degradacao-silenciosa.spec.ts` provavelmente está reprovando em silêncio hoje — e é
uma PREDIÇÃO, não uma medição.** Achado do QA nesta revisão, verificado por mim na fonte:

- Ela mata o socket de propósito (`routeWebSocket`, linha 113) e tem uma **pré-condição**
  antes da asserção que interessa (linhas 156-164): `expect(engolidos).toBeGreaterThan(0)`,
  cuja razão escrita é "se nenhum quadro de dados foi engolido, a entrega não foi morta e o
  teste não mediu degradação nenhuma".
- Mas ela é `test.fail()`, e o próprio arquivo avisa (linhas 89-92) que isso **esconde QUAL
  asserção falhou**: "uma cerca que falha na PRÉ-CONDIÇÃO parece idêntica a uma que falha no
  ponto certo". O escape é `CERCA_CRUA=1`.

Junte as duas com o defeito da publication: se o canal já não entrega nada, não há quadro de
entrega para engolir → `engolidos` fica 0 → a pré-condição reprova → e o `test.fail()` diz
"falhou como esperado". **A cerca estaria quebrada sem sinal.**

**O mecanismo foi FECHADO por leitura (QA, 2026-08-25) — cada elo é uma linha, nenhum é
inferência.** Verificado na fonte por mim:

```
ehEntrega()                        → só true se q[3] === "postgres_changes"
if (ehEntrega(...)) { engolidos++ }  ← é o ÚNICO lugar que incrementa
expect(engolidos).toBeGreaterThan(0) ← a pré-condição, antes da asserção que interessa
```

⚠️ **Sem número de linha, de propósito.** A primeira versão deste bloco citava `:105`, `:149`
e `:159` — e estava certa na branch onde foi escrita e errada na `main`, porque o próprio
cabeçalho que documenta isto empurrou o arquivo 31 linhas. O registro mudou o objeto que ele
descreve. Ache por `grep -n "function ehEntrega" tests/e2e/degradacao-silenciosa.spec.ts`.

Com a publication sem as tabelas, o servidor **nunca emite** quadro `postgres_changes` — emite
`join`, `phx_reply` e `heartbeat`, que são justamente os que o proxy deixa passar de propósito.
Logo `ehEntrega` nunca devolve true, `engolidos` fica 0, a pré-condição reprova, e o
`test.fail()` mostra "falhou como esperado".

**E a consequência é mais interessante que o bug** (formulação do QA): se a predição se
confirmar, aquela cerca esteve quebrada desde que o defeito da publication existe, e ninguém
podia ver — não por descuido, mas porque **o mecanismo que a protege de virar teatro (o
`test.fail()`) é o mesmo que escondeu que ela virou**. É uma cerca cujo desenho de segurança
criou o próprio ponto cego.

Como confirmar (ninguém mediu ainda): rodar `CERCA_CRUA=1 pnpm exec playwright test
degradacao-silenciosa.spec.ts` no CI antes e depois do passo de restart. Se antes ela falha na
pré-condição e depois no ponto certo, a predição se confirma — e o conserto do CI terá tirado
essa spec de um estado em que ela não provava nada.

**O que continua faltando nela, e não é o mesmo que a pré-condição:** não há controle
positivo estrito — nenhum caso com o canal VIVO afirmando que a tela **não** mostra o aviso.
A pré-condição garante que a sabotagem funcionou; ela não garante que o aviso é consequência
da sabotagem. Se o aviso fosse incondicional, a spec passaria idêntica. O QA estimou cinco
linhas para fechar isso, e a dívida é dele por escrito — não foi feita aqui porque a spec não
é deste PR.

**Registro de dívida, apontado pelo QA na revisão desta entrega:** enquanto o passo do
restart estiver só na branch do #327 e não na `main`, toda spec nova de tempo real nasce
quebrada no CI pelo motivo acima — e quem a escrever vai perder as mesmas horas.

**Evidência visual:** `evidence/inbox-tempo-real/mensagem-sem-reload.png` — a
conversa aberta com as mensagens das rodadas, cada uma entregue sem recarregar.

## O gate de CHANGELOG que falta — desenho combinado (2026-08-25)

**Nada no repo cobra que mudança de comportamento tenha entrada no CHANGELOG.** Esquecer é de
graça, e aconteceu duas vezes num dia: o PR #326 entrou na `main` sem linha nenhuma (a
normalização do Respondi altera dado do cliente em silêncio — telefone sem DDI vira
brasileiro), e o conserto do tempo real do inbox só não saiu pelo mesmo buraco porque o dono
mandou reconciliar com o time.

O QA (`Assistente e Testes`) vai escrever o gate. Desenho combinado numa revisão cruzada, com
as armadilhas já medidas — está aqui porque a conversa bateu no teto anti-loop do Espaço antes
do último ponto ser entregue.

**A armadilha que matou o primeiro desenho:** um teste em `tests/unit` que faça
`git diff origin/main...HEAD` **nasce cego**. O `actions/checkout` do `ci.yml` não tem
`fetch-depth`, então o clone traz UM commit e não há `origin/main` contra o que comparar — o
gate passaria vazio, verde sempre. *Gate que nasce cego é pior que gate ausente, porque
ninguém procura o que já tem cerca.*

**Forma acordada:**

| peça | o quê |
|---|---|
| `scripts/gate-changelog.ts` | a lógica; recebe a lista de arquivos tocados como argumento |
| `pnpm gate:changelog` | uso local, alimentado por `git diff --name-only origin/main...HEAD` (local TEM o histórico) |
| passo no workflow | alimentado por `github.event.pull_request.base.sha`, que o Actions dá de graça |
| o que cobra | **entrada em `[Não lançado]`**, nunca "o arquivo foi tocado" — um cobra o efeito, o outro o gesto |
| allowlist | **nomeada e travada por `toEqual([...])`**, como `tests/unit/branding.test.ts` — travar por contagem deixa trocar uma dívida por outra em silêncio |

**O ponto que ficou sem resposta, e a proposta:** como separar "mudou comportamento" de
"refactor puro" sem virar imposto. A ideia de cobrar só de quem toca `app/api` ou `app/app`
**falha no primeiro caso real** — medido: o PR #327 não toca nenhum dos dois (mexe em `lib/`,
`hooks/inbox`, `components/inbox`) e é a mudança mais visível ao usuário daquele dia. Falso
negativo silencioso.

Proposta alternativa: **inverter o ônus em vez de adivinhar**. Todo PR que toca código de
produto exige entrada; quem acha que não precisa **declara** (uma linha no corpo do PR ou no
commit, com o motivo) e o gate lê a declaração. Três ganhos: não há falso negativo silencioso
(não ter entrada passa a exigir ato consciente); a decisão fica **escrita e auditável**; e não
vira imposto, porque uma linha de declaração custa menos que uma linha vazia de changelog —
que é o risco real, já que ela polui a tela de produto do operador. Não é convenção nova: o
`tests/unit/navegacao-completude.test.ts` já aceita exceção **com justificativa escrita**.

## J19 — Quem instala em espanhol usa o sistema em espanhol? `[P0]` (2026-08-27)

Primeira impressão de quem instala fora do Brasil, que é o público do
espanhol: a pessoa escolhe o idioma na instalação e abre o produto. Se a tela
vier em português, ela conclui que a opção não funciona — e ela teria razão,
porque até este passe o seletor da organização era gravado no banco e **não era
lido por ninguém**.

**Como foi provado.** Supabase local pg17 com o `baseline.sql` (o que o
`install.sh` aplica, não a cadeia de migrations, que não sobe do zero), `next
build` + `next start` de produção, login com conta de teste real, cinco telas
percorridas pelo browser. Spec: `tests/e2e/i18n-espanhol-na-tela.spec.ts`.
Evidência: `evidence/i18n-es/01-inbox-em-espanhol.png` e
`evidence/i18n-es/02-inbox-de-volta-em-portugues.png`.

**Achados, todos consertados neste mesmo passe:**

1. **A troca se desfazia sozinha na primeira navegação.** O `revalidatePath`
   invalida o cache do servidor; o Router Cache do cliente guarda o layout de
   `/app`, que é quem monta o provider de idioma. Logo após o clique a tela
   mostrava o idioma novo, ao navegar voltava ao antigo, e só um reload
   acertava. `router.refresh()` melhora e não resolve — medido: a primeira
   navegação ainda vinha antiga, só a segunda vinha certa.
2. **Os rótulos do Índice de Atrito** (`lib/metrics/atrito.ts`) chegavam à tela
   sem passar por `t()`. São montados em lógica pura, e o guarda estático não
   os alcança porque `{par.titulo}` é expressão, não literal.
3. **"Atendente" e "Funil" crus** em `/app/metrics` — o guarda estático não os
   viu porque a régua dele é ortográfica (ç, ã, õ, lh/nh) e nenhuma das duas
   palavras tem acento. É o falso negativo assumido dele, e é a razão de os
   dois guardas existirem: o estático alcança todo arquivo, o e2e alcança o que
   a régua do estático não distingue.

**A data, que a primeira versão desta jornada declarava como não coberta,
passou a ser medida aqui.** Existe `lib/i18n/datas.ts`, e a spec reprova se
achar mês ou dia da semana em português com a interface em espanhol.

⚠️ Essa asserção nasceu VACUOSA, e o registro do porquê vale mais que ela: as
telas percorridas não imprimiam data por extenso naquele banco, então a régua
não tinha o que achar — sabotei a camada de idioma e o teste passou VERDE.
Hoje ela tem um **controle positivo** (exige achar data em português no retrato
inicial, senão falha dizendo que o problema é o teste) e uma **fixture** que
garante o dado: `ContactsTable` só escreve a data por extenso quando é de hoje
ou ontem, e fora disso imprime `dd/MM/yyyy` — idêntico nos dois idiomas.

**O que segue fora:** e-mail e o PDF de LGPD, com o motivo escrito em
`tests/unit/i18n-a-data-segue-o-idioma.test.ts`.

## A migração para o Tailwind 4 mudou 252 classes que ninguém sabia estarem mortas (2026-08-26)

Origem: subir `tailwindcss` de 3.4 para 4, com o config saindo do
`tailwind.config.ts` (deletado) para um `@theme inline` em `app/globals.css`.

**O achado que a migração destapou.** No v3, um modificador de opacidade sobre
cor declarada como `var(--…)` sem o marcador `<alpha-value>` fazia o Tailwind
**não emitir a regra** — a classe simplesmente não existia no CSS, em silêncio.
Todo token deste produto é `var(--color-*)`, então **62 classes distintas em 252
usos** eram letra morta: `bg-destructive/10` num aviso de erro não pintava fundo
nenhum, `border-destructive/30` caía na cor neutra da regra global de borda,
`text-muted-foreground/60` herdava a cor do pai. O v4 resolve opacidade por
`color-mix()`, que funciona com qualquer cor — então **as 252 passaram a pintar
o que quem escreveu queria desde o começo**.

Medido com o v3 real, e não deduzido: um `tailwindcss@3.4.19` de descarte,
alimentado com 7 classes, emitiu **4** — nenhuma das 3 com barra.

| caso | prioridade | estado |
|---|---|---|
| Tokens resolvem em claro e escuro depois do `@theme inline` | `[P0]` | **PASS**, medido por `getComputedStyle` em `tests/sonda-tailwind-4.ts`: `--color-bg` = `#faf9f6` claro / `#161510` escuro, e `body` acompanha |
| A auto-referência do `@theme inline` (`--color-bg: var(--color-bg)`) não vence o `:root` autoral | `[P0]` | **PASS.** A teoria é de cascata (sem layer vence layer); a medida é a linha acima. Congelado em `tests/unit/tailwind-tokens.test.ts`, que reprova se alguém embrulhar `:root` num `@layer` |
| `class="border"` sem cor continua na cor de borda do produto, e não em `currentColor` | `[P0]` | **PASS**: `rgb(231,227,218)` (claro) e `rgb(51,49,42)` (escuro) — os dois são o `--color-border` do tema |
| As classes de opacidade revividas pintam de verdade | `[P1]` | **PASS parcial**: `bg-muted/40` medido em elemento real do onboarding, com alfa `0.4` nos dois temas. O antes/depois confirma 25 bordas e 8 fundos que passaram de cor chapada / transparente para cor com alfa. As demais estão no CSS construído, mas **não foram medidas uma a uma na tela** |
| Onboarding completo (6 passos) em claro e escuro, instalação fresca | `[P0]` | **PASS**, 0 erro de console. Capturas em `evidence/tailwind-4/` |
| **ANTES/DEPOIS**: as duas versões contra o MESMO banco, comparadas elemento a elemento | `[P0]` | **PASS**. `tests/sonda-tailwind-4-antes-depois.ts` sobe v3 em `:3002` e v4 em `:3001`, casa cada elemento pelo **caminho estrutural no DOM** (não pelo `className`, que a migração renomeou) e reporta todo estilo computado que divergiu, mais o diff de pixel. Pares em `evidence/tailwind-4/{antes,depois}/`, números em `antes-depois.json` |
| Telas internas (`/app`, kanban, inbox, contatos) | — | **NÃO COBERTO.** Numa instalação fresca todas redirecionam para `/onboarding/welcome`; alcançá-las pede concluir o onboarding, o que pede WAHA e chave de IA. A sonda registra o redirecionamento em vez de fingir cobertura |
| O efeito visual das 252 revividas foi *revisto por um designer* | — | **NÃO MEDIDO.** A migração provou que passaram a pintar; não provou que cada uma pinta o que a tela precisa. Onde a intenção original estava errada, o erro agora está visível |

### O defeito que só o antes/depois encontrou: o rótulo colado no campo

O `space-*` inverteu o lado da margem — e isso não é cosmético:

```
v3:  .space-y-2 > :not([hidden]) ~ :not([hidden])   { margin-top }      ← filho SEGUINTE
v4:  :where(.space-y-2 > :not(:last-child))         { margin-block-end } ← filho ANTERIOR
```

Num grupo `<Label>` + campo, o filho anterior é o **rótulo**. E `<label>` nasce
`display: inline`, que **ignora margem vertical** — a margem do grupo evaporava.
Medido: todo grupo de formulário perdia exatamente um `--space-N`, e a tela de
boas-vindas ficava 24px mais curta, com rótulo colado no campo. Zero erro, zero
teste vermelho, no meio de 91 arquivos alterados.

Conserto em `components/ui/label.tsx`: `inline-block` na classe base. Não é
`block` porque medi os dois — `inline-block` preserva a largura shrink-to-fit que
o `inline` dava e fica a **4px** do que o v3 rendia, contra 10px do `block`.

| caso | prioridade | estado |
|---|---|---|
| O respiro entre rótulo e campo sobrevive à migração | `[P0]` | **PASS**, medido: 8px nos dois lados |
| Rótulo inline não volta | `[P0]` | **PASS**, `tests/unit/tailwind-tokens.test.ts` — e provado por sabotagem: revertendo a classe, o teste reprova |
| O `<label>` CRU tem o mesmo defeito, e o componente consertado não o alcança | `[P0]` | **PASS.** A sonda achou 1 na tela; a varredura estática achou **10** em 3 arquivos (`app/app/audit`, `webhooks/CapturasTab`, `onboarding/funil`), todos primeiro filho de `space-y-*`. Corrigidos, e a varredura virou teste — também provado por sabotagem. Confirmado depois na tela: **zero** filhos inline em container `space-*` nas 7 telas provadas |
| Diferença residual de 4px por grupo | — | **CONHECIDA e não fechada.** É o `leading-none` da própria classe do rótulo finalmente valendo — enquanto ele era `inline`, quem mandava na altura da linha era o strut do pai. Fechar exige tirar o `leading-none`: decisão de design, não de migração |
| `<option>` de `<select>` nativo perde 2px de `padding-left` e o fundo branco do popup | — | **MEDIDO, impacto visual NÃO PROVADO.** O preflight do v4 zera `padding` em `*` (o v3 não zerava). São 10 `<select>` no produto; o popup é desenhado pelo SO, então o Playwright não o captura |
| `outline-none` → `outline-hidden` muda `outlineStyle` de `solid` para `none` em 2 campos | — | **ESPERADO, não é regressão.** O v3 punha contorno transparente SEMPRE; o v4 só sob `forced-colors`. O indicador de foco visível sempre foi o `ring`, e a regra `forced-colors` do `globals.css` cobre o resto |
| Paleta default (amber, emerald) muda de sRGB para oklch | — | **NÃO MEDIDO** se o desvio é perceptível. São ~20 elementos, todos de aviso/estado |
| Telas internas (`/app`, kanban, inbox, contatos) | — | **NÃO COBERTO**, mesmo motivo de antes: instalação fresca redireciona para o onboarding |

### O risco que o dono do projeto nomeou antes da migração, medido

Na issue #239 o mantenedor deixou um aviso específico: uma varredura de "tokens
sem consumidor" apontaria `duration-fast/base/slow` como mortos, e deletar o
bloco `transitionDuration` **apagaria a transição de todo botão, input, textarea
e badge do produto** — em silêncio, com `typecheck`, `lint`, `test:unit`,
`invariants` e `build-and-size` verdes, porque `grep -rn toHaveScreenshot tests/`
devolve zero.

No Tailwind 4 o risco é maior que no 3, e por um motivo novo: **não existe espaço
de tema `--duration-*`**. Um `@theme inline` não tem onde declará-los, e a
tradução ingênua do config os perderia sem erro nenhum. Aqui eles viraram
`@utility` explícito em `app/globals.css`.

| caso | prioridade | estado |
|---|---|---|
| Botão e campo mantêm a duração de transição | `[P0]` | **PASS**, medido em elemento real nas duas versões ao mesmo tempo: `transitionDuration` = `0.12s` no `<button type="submit">` e no `<input type="email">` do login, idêntico em v3 e v4 |
| `duration-base` / `duration-slow` não aparecem no CSS construído | — | **ESPERADO, não é regressão.** Nenhum arquivo os usa, e o Tailwind só emite classe usada — no v3 era igual. O `--duration-slow` que o `.card-pulse` consome é a **variável**, não a classe, e continua no `:root` |

### As provas versionadas

Só os quatro pares que sustentam uma afirmação — o resto das capturas é artefato
de execução e não entra no repositório (a regra é de
`tests/unit/evidencia-citada.test.ts`, e ela reprovou esta entrega antes de eu
podar). Para regerar todas: suba as duas versões e rode
`tests/sonda-tailwind-4-antes-depois.ts`.

| par | o que ele prova |
|---|---|
| `tailwind-4/antes/02-onboarding-welcome-claro.png` → `tailwind-4/depois/02-onboarding-welcome-claro.png` | O respiro entre rótulo e campo. É aqui que o defeito do `<label>` inline aparecia: a página inteira 24px mais curta, três grupos colados |
| `tailwind-4/antes/02-onboarding-welcome-escuro.png` → `tailwind-4/depois/02-onboarding-welcome-escuro.png` | O tema escuro sobrevive à troca do `@theme inline` — mesma tela, tokens escuros resolvendo |
| `tailwind-4/antes/05-onboarding-ia-escuro.png` → `tailwind-4/depois/05-onboarding-ia-escuro.png` | O cartão de aviso âmbar, que concentra as classes de opacidade revividas e a paleta default que passou a oklch |
| `tailwind-4/antes/01-login-claro.png` → `tailwind-4/depois/01-login-claro.png` | A tela mais simples do produto, com borda, foco e anel — o controle: se algo básico tivesse quebrado, quebraria aqui |

**Armadilha que custou duas medições falsas.** Sonda que injeta `<div
class="p-7">` por JavaScript não mede nada: a classe nunca esteve na fonte, o
scanner nunca a viu, e o zero medido é artefato da sonda. Pelo mesmo motivo, o
primeiro elemento com `class="border"` da tela de login é o `<input>`
autofocado — ele casa `focus-visible:border-accent-500` e devolve a cor do
foco. A sonda só mede elemento real, e pula elemento em foco e elemento que já
traga classe de cor própria.

---

## O campo que oferecia hoje e o servidor recusava (2026-09-03)

Achado de varredura adversarial contra o PR #496, no SHA `f700f3e1`. Mesma tela
do #496 — **Conexões › Proteção de envio** —, campo ao lado do que ele acabara
de consertar, e o mesmo desfecho para quem opera: a ficha inteira deixa de
salvar.

`<input type="date">` fala em dia LOCAL; `AntiBanSheet` encaixa o dia escolhido
às 12h UTC (meia-noite viraria o dia anterior a oeste); e a guarda do schema
comparava esse encaixe com `Date.now()` — um DIA contra um RELÓGIO.

| régua | recusa começa | recusa para | quem sente |
|---|---|---|---|
| dia que a tela mostra (`America/Sao_Paulo`, UTC−3) | 03:00 UTC | 12:00 UTC | 00:00 às 09:00 no relógio de quem opera |
| dia UTC (o que o `max` do campo oferecia, vindo de `toISOString()`) | 00:00 UTC | 12:00 UTC | as primeiras 12 horas UTC do dia |

Medido varrendo as 48 meias-horas do dia com relógio falso, chamando o schema
real com a carga exata que a tela monta — não pela tela: **NÃO MEDIDO** pelo
browser num ambiente fresco estilo VPS. O que a varredura de horas prova é a
fronteira; o que ela não prova é o que o operador vê quando ela dispara.

**A lição, e ela não é sobre fusos.** O produto oferece o dia num campo e o
recusa no servidor: a mesma classe do controle decorativo, ao contrário — não é
o controle que não faz nada, é o limite do campo que promete o que a outra ponta
nega. Toda validação de data merece a pergunta *"as duas pontas falam do mesmo
dia, ou uma delas fala de instante?"*.

**Onde mais essa pergunta cabe** (levantado, **não medido**, e fora do escopo do
conserto): `lib/kanban/filters.ts` e `lib/automation/throttle.ts` derivam "hoje"
de `toISOString().slice(0, 10)`, que é o dia UTC. Se algum deles compara com dia
local, é a mesma classe.
## J21 — Uma loja no México escolhe sua moeda `[P0]` (2026-09-04)

Migration 0208 dá a `organizations` uma coluna `currency`; o resto do frente
(seletor, herança no catálogo, formatação) não valia nada sem provar pela tela
que a escolha sobrevive e que o preço sai do jeito certo — a mesma armadilha
que o seletor de idioma do perfil já teve antes desta feature: campo que
aceita clique e não muda nada.

Banco: `supabase/baseline.sql` reaplicado no Supabase local (idempotente —
`add column if not exists`, confirmado sem perda de dado na única organização
que já existia). `pnpm e2e:build && pnpm test:e2e -- moeda-da-organizacao`,
Chromium real, login com MFA real.

| Caso | Prioridade | Resultado |
|---|---|---|
| Trocar para peso mexicano em Configurações › Organização e RECARREGAR a página | `[P0]` | **PASS.** `#currency` mostra `MXN` depois do `page.reload()` — não só depois de salvar. Evidência: `evidence/moeda-da-organizacao/moeda-01-antes.png`, `evidence/moeda-da-organizacao/moeda-02-mxn-salvo.png`, `evidence/moeda-da-organizacao/moeda-03-mxn-apos-reload.png` |
| Produto cadastrado com a organização em MXN mostra o preço na convenção mexicana | `[P0]` | **PASS.** `$249.90` — ponto decimal, cifrão na frente. **Não** `MXN 249,90`, que era o que `comoMoeda()` (removida neste PR) mostrava: a asserção nega esse texto explicitamente, porque uma spec que só checasse "o preço apareceu" teria passado verde com o defeito antigo. Evidência: `evidence/moeda-da-organizacao/moeda-04-produto-mxn.png` |

**Achado de infraestrutura, não desta feature:** `pnpm e2e:build` falhou na
primeira tentativa com `Cannot find module '@tailwindcss/postcss'` — o merge de
`upstream/main` trouxe a migração para Tailwind 4 (`package.json` já
declarava a dependência), mas `pnpm install` não tinha rodado depois. `pnpm
install` + `pnpm build` (exit 0) resolveram antes de tentar o e2e de novo.

**Achado de doutrina, não desta feature:** o piso de Postgres mudou de pg17
para pg15 no mesmo merge (PR #422, `tests/unit/baseline-no-piso-do-postgres.test.ts`
novo). Conferido: a migration 0208 não usa nada exclusivo de pg17 (só `ADD
COLUMN`, `UPDATE`, `ALTER COLUMN`, um bloco `DO` com `pg_constraint`), e
`scripts/test-db.sh` já sobe `pgvector/pgvector:pg15` — os `pnpm test:db`
anteriores desta sessão já corriam contra o piso certo, mesmo antes deste
achado.
