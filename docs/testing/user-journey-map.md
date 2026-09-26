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
| J1.7 | Setup IA: criar agente default | `ai_agents` criado **e a versão publicada aponta para o provedor que a instalação escolheu**, com o modelo curado DAQUELE provedor; avança. **Sem chave de IA** (o `install.sh` deixa pular, e é o ambiente da VPS fresca no CI): o agente nasce rascunho, sem versão, o aviso nomeia o provedor e "Continuar sem publicar" avança para "Onde ele organiza" (`tests/e2e/vps-fresh-onboarding.spec.ts`) |
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
| J1.26 | O quadro de clientes deixa de nascer de e-commerce | passo novo entre treinar e ver ele atender. `trg_seed_default_pipeline_for_org` semeia "Carrinho abandonado / Em separação / Enviado" em TODA organização, e a clínica abria o quadro dela e lia isso. A sugestão sai do MESMO modelo que vai atender — se ela falha, o dono descobre agora e não com o primeiro cliente · **PASS** (`tests/e2e/wizard-do-funcionario.spec.ts`, `lib/onboarding/proposta-de-funil.test.ts`; sem chave de IA, na VPS fresca: `tests/e2e/vps-fresh-onboarding.spec.ts` — o aviso "ainda não está no ar" + modelo pronto, e o que a tela mostra é o que se grava) |
| J1.27 | O quadro **ensina o funcionário a percorrê-lo** | MEDIDO em 2026-08-13: **312 etapas em 43 funis, 4 com `agent_stage_hint`** — e as 4 de organizações de teste. Toda instalação real nascia com `coberturaDoFunil()` devolvendo `mudo: true`: o assistente tinha o funil no escopo (J1.20) e não sabia o que significava nenhuma coluna. Aqui uma coluna é NOME + DESTINO indissociáveis · **PASS** (`tests/invariants/quadro-do-onboarding.test.ts`, 7 casos contra o Postgres do baseline) |
| J1.28 | Sem chave de IA, o passo ainda entrega quadro | falha ABERTA na informação, FECHADA na ação: seis quadros prontos por ramo, escolhidos pelo que o dono escreveu no passo 1, e a tela DIZ que a sugestão não veio. Devolver erro deixaria a pessoa com o funil de e-commerce, que é o defeito que o passo existe para consertar · **PASS** (`lib/onboarding/sugerir-funil.test.ts`, `tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.29 | O passo 1 pergunta **o que o negócio faz** | era o dado que faltava no produto inteiro: sem ele os três modelos de prompt diziam "loja online" e o quadro nascia de e-commerce — os dois defeitos vinham da mesma origem, uma instalação que nunca pergunta em que ramo entrou · **PASS** (`tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.30 | Sem chave da IA, o passo de treinar PEDE a chave | o passo 1 media e escrevia "Falta a chave da inteligência artificial" — diagnóstico certo, saída nenhuma: a pessoa teria de descobrir sozinha que existe uma tela de credenciais, e onde. Agora ela cola a chave no passo em que a chave passa a importar, um clique antes de o funcionário nascer com ela · **PASS** (`tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.31 | A chave é testada com uma GERAÇÃO, não com uma listagem | "Validada" nunca significou "funciona": o validador bate em `GET /v1/models`, que responde 200 com a conta zerada. `provarSaldo` existia e **nenhuma tela a chamava** (evento sem consumer, anti-pattern nº 3 do CLAUDE.md). Agora o passo de treinar confere e diz o resultado — e distingue "sem crédito" de "não consegui conferir", que pedem conselhos opostos · **PASS** (`lib/instalacao/prova-de-credito.test.ts`, `tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.32 | A janela entre cadastrar a chave e ela ser confirmada | MEDIDO percorrendo o wizard: quem colava a chave lia "Não consegui testar o crédito" e "Falta a chave da inteligência artificial" no mesmo segundo — as duas frases mandam cadastrar de novo o que já está lá. A validação roda em SEGUNDO PLANO, então a janela existe sempre; o retrato passou a distinguir confirmada de em-verificação, e a tela espera em vez de acusar · **PASS** (`lib/instalacao/retrato.test.ts` — o arquivo não tinha teste nenhum antes) |
| J1.33 | A verificação em duas etapas deixa de ser imposta | MEDIDO percorrendo o wizard: "Começar a usar" entregava o dono num bloqueador de tela cheia pedindo um aplicativo autenticador — um sétimo passo que a barra de progresso nunca anunciou, e que TODA instalação self-host recebia, porque o `install.sh` cria o dono como platform admin. Agora é escolha: `platform_admins.mfa_required` (que existia e **nunca era lido** — controle decorativo) e `organizations.settings.security.mfa_required`, ambos com padrão não-exigir · **PASS** (`tests/e2e/mfa-opcional.spec.ts`, `lib/auth/politica-mfa.test.ts`) |
| J1.34 | Ligar e desligar a verificação, pela tela | o único ponto de cadastro do produto era o próprio bloqueador — sem um botão em Configurações › Segurança, tornar o cadastro opcional deixaria a proteção INALCANÇÁVEL. E desligar não existia em lugar nenhum: `enrollMfa` só apaga fator não verificado. Desligar o próprio fator exige sessão `aal2`, senão uma sessão roubada desliga a proteção com um clique · **PASS** (`tests/e2e/mfa-opcional.spec.ts`) |
| J1.35 | Cadastrar e PROVAR são perguntas diferentes | `mfaEmDivida()` começava consultando a política, então quem ativasse a verificação por vontade própria teria o fator ignorado na sessão — o mesmo que não ter. Com o cadastro opcional isso viraria o buraco central da mudança. Agora quem TEM fator prova, sempre, qualquer que seja o papel · **PASS** (`tests/unit/require-role-mfa.test.ts` — o caso do manager INVERTEU, e a inversão aperta) |
| J1.36 | A prova de crédito não reprova chave boa por causa do modelo de raciocínio | MEDIDO numa instalação fresca (2026-09-26, `baseline.sql` + `bootstrap-owner.ts`) com chave OpenAI válida e **com crédito**: o modelo curado padrão gasta o único token pensando e a API responde 400 "max_tokens or model output limit was reached" — que é a prova DANDO CERTO, porque chave recusada é 401 e modelo inexistente é 404. Lido como falha, a tela dizia que o teste não passou, com o **corpo cru do provedor** e a sugestão falsa de falta de crédito (a publicação do atendente não depende desta prova: ela exige WhatsApp conectado, `first-publication.ts:114`). Agora esse 400 conta como sucesso, e a tela diz em português o que fazer, por balde de erro · **PASS** (`lib/instalacao/prova-de-credito.test.ts`); a prova pela TELA não foi feita — exigiria chave real de um modelo de raciocínio, e é o que falta para fechar o caso. Evidência do #1697 (mesmo classificador, superado por este): `provarSaldo("openai", <chave real>, "gpt-5.6-terra")` → `{ ok: true }`, e a tela numa instalação fresca mostrou "Testei agora: a chave respondeu e tem crédito." — o caminho de SUCESSO; as frases novas de falha seguem sem prova em tela |

> **Cobertura em camadas (J1.22/J1.23):** a decisão de *não provisionar* é provada por unitário, porque é uma função pura e roda no gate obrigatório. O caso de tela cobre o caminho visível (CTA → signup com o token → campos certos). O que **não** está coberto ponta a ponta é a volta do link de confirmação de e-mail: exigiria caixa de e-mail no e2e, e a spec que faria isso é a de instalação fresca, que está fora do CI.

> **A jornada J1 passou a ter GATE.** `tests/e2e/wizard-do-funcionario.spec.ts` roda no CI (SPECS_PARTE_1) e cobre o wizard inteiro pela tela — do login ao "Começar a usar" — criando a PRÓPRIA organização, porque o seed compartilhado entrega uma já onboardada e zerá-la mandaria as specs seguintes para dentro do onboarding. Fica de fora só o ensaio com resposta real, que exige chave de IA com saldo. `vps-fresh-onboarding.spec.ts` **também passou a ter gate** — o PR #983 subiu WAHA e Redis de verdade no CI e a pôs na `SPECS_PARTE_4`; esta linha dizia o contrário, e quem quiser o estado de hoje pergunta ao workflow: `git show origin/main:.github/workflows/e2e.yml | grep -A4 'FORA_DO_CI:'`. Ela segue sendo a prova mais completa da instalação fresca, e ter gate não a dispensa de rodar numa VPS de verdade: o CI aplica o `baseline.sql` e o `scripts/bootstrap-owner.ts`, não o `install.sh` inteiro.

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

- Orçamento do E2E: 60 s para login com MFA, validação e limpeza; o polling da validação continua limitado a 15 s. Na execução CI `36079389278` do PR #1566, o trace registrou 24,6 s aguardando a próxima janela TOTP, consumindo quase todo o antigo limite global de 30 s. A nova execução do E2E deve confirmar o ajuste.

- `[P0]` Colar chave inválida e entender o motivo — `tests/e2e/credenciais-de-ia.spec.ts`. Achados corrigidos em 2026-09-02: lista de modelos colada por vírgula no card; "Validando…" eterno após restart; erro em código (`auth_failed_401`, no card e no toast); diálogo sem dizer quando usar cada provedor nem onde pegar a chave; contagem "em uso" divergente do DELETE. **PASS** — executada de verdade contra browser real (Supabase local pg17 + baseline + Chromium) em 2026-09-02, depois que o Docker da máquina (antes indisponível) voltou. A própria execução achou um SEXTO defeito que a leitura de código não tinha achado: `descreverErroDeValidacao` não classificava `TypeError` (o nome que o `fetch()` do Node usa para falha de rede/DNS) como erro de rede, e o card mostrava "Falha na validação (TypeError)." cru em vez da frase amigável — corrigido em `lib/ai/credenciais/erro-de-validacao.ts`, com caso de teste. Evidência em `.superpowers/evidence/credenciais-de-ia.png`.

## J32 — Ligar o Jev para perceber o cliente irritado `[P1]` (2026-09-23)

O Jev (System One, da TypeSafe AI) mede o clima de cada mensagem do cliente,
geralmente em menos de um segundo, no lugar ou ao lado da IA de sempre. Nasce desligado;
ligar manda cada mensagem dos clientes aos EUA, uma de cada vez e sem o resto da
conversa, então pede o aceite de quem administra. É `[P1]` e não `[P0]`: nada dele está no caminho de quem acabou de
instalar.

Specs: `tests/e2e/jev-decisoes-rapidas.spec.ts` (parte 5 do `e2e`, contra o dublê
HTTP `scripts/duble-jev-e2e.mjs`, que grava cada chamada num arquivo que a spec lê) e
`tests/e2e/jev-chave-real.spec.ts` (fora do CI: exige a chave paga; pula sem ela).

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J32.1 | Procurar "jev" no ⌘K | a busca leva a Provedores, onde está o cartão | **PASS** — `jev-decisoes-rapidas.spec.ts` verde em 2026-09-24 (bancada fresca: pg15 + `baseline.sql` + `bootstrap-owner.ts`, build de produção, dublê) e na prova manual em campo com a chave REAL (Chromium dirigido como leigo, clínica recém-instalada): ⌘K "Jev" → Provedores |
| J32.2 | Cartão sem chave | diz o que o Jev é, leva à TypeSafe para pegar a chave e abre o diálogo de colar já no Jev (formato `apikey_…`) | **PASS** — `jev-decisoes-rapidas.spec.ts` verde em 2026-09-24 (bancada fresca: pg15 + `baseline.sql` + `bootstrap-owner.ts`, build de produção, dublê) e na prova manual em campo com a chave REAL (Chromium dirigido como leigo, clínica recém-instalada) |
| J32.3 | Colar a chave | o teste da chave passa (o dublê recebeu o `GET /v1/models` com a chave certa) e o cartão fica pronto para ligar | **PASS** — `jev-decisoes-rapidas.spec.ts` verde em 2026-09-24 (bancada fresca: pg15 + `baseline.sql` + `bootstrap-owner.ts`, build de produção, dublê) e na prova manual em campo com a chave REAL (Chromium dirigido como leigo, clínica recém-instalada): validada na TypeSafe real |
| J32.4 | Chave validada, Jev desligado, e uma mensagem do cliente chega e é drenada | nenhuma pergunta sai para o fornecedor (D6). O controle positivo é a J32.7: mesmo cliente, mesma conversa, só o interruptor muda | **PASS** — `jev-decisoes-rapidas.spec.ts` verde em 2026-09-24 (bancada fresca: pg15 + `baseline.sql` + `bootstrap-owner.ts`, build de produção, dublê); na prova de campo, desligado: 4 chamadas ao Jev antes, 4 depois |
| J32.5 | Ligar sem marcar o aceite | o botão fica travado; a rota recusa com `jev_exige_aceite` (provado em `app/api/v1/ai/jev/route.test.ts`) | **PASS** em tela (prova de campo: "Ligar o Jev" desabilitado até marcar o aceite) e na rota (unit) |
| J32.6 | Ligar com o aceite, e deixar o Jev decidir | observando (com IA de sempre), com o bloco de concordância na tela — o laço de retorno da observação — → **diálogo de confirmação da tarefa** (o efeito dela em produção e "Dá para voltar a só observar quando quiser"; cancelar não muda nada; pausar e voltar a observar não pedem confirmação) → decidindo; sozinho quando a empresa não tem a IA de sempre. O NÚMERO da concordância (acima de zero) não se alcança pela tela neste ambiente: a IA de sempre tem chave falsa; ele é provado em `CartaoDoJev.test.tsx` e `app/api/v1/ai/jev/route.test.ts` | **PASS** — `jev-decisoes-rapidas.spec.ts` verde em 2026-09-24 (bancada fresca: pg15 + `baseline.sql` + `bootstrap-owner.ts`, build de produção, dublê) (bloco de concordância em observação); "Decidindo sozinho" **PASS** em tela com a chave real. O diálogo de confirmação (prova em tela da onda 2 pediu: o clique decidia sem explicação): **PASS em unit/jsdom** (`CartaoDoJev.test.tsx`, as três tarefas e o cancelar); a spec (`helpers/jev.ts › ligarOJev`) passou a confirmar pelo diálogo, **sem ter sido executada depois do ajuste**. O NÚMERO da concordância acima de zero segue provado só em unit (sem IA de sempre real neste ambiente) |
| J32.7 | Segunda mensagem do mesmo cliente pelo webhook do WhatsApp | o dublê recebe a pergunta do clima com a chave colada, a versão `jev-1.13.0` e SÓ a última mensagem (sem a da J32.4, que está na mesma conversa), com telefone e e-mail trocados por `[PHONE]`/`[EMAIL]` | **PASS** — `jev-decisoes-rapidas.spec.ts` verde em 2026-09-24 (bancada fresca: pg15 + `baseline.sql` + `bootstrap-owner.ts`, build de produção, dublê); com a chave real, a TypeSafe mediu irritada=0,0025 e feliz=0,745 (323/751 ms) |
| J32.8 | IA › Execuções, "Ver as decisões do Jev" | a medição aparece com "Jev (TypeSafe AI)", o modelo devolvido e sem "falhou"; o filtro "Só o Jev" vem marcado | **PASS** — `jev-decisoes-rapidas.spec.ts` verde em 2026-09-24 (bancada fresca: pg15 + `baseline.sql` + `bootstrap-owner.ts`, build de produção, dublê) e na prova manual em campo com a chave REAL (Chromium dirigido como leigo, clínica recém-instalada): "Mostrando só o Jev" e "O Jev decidiu." |
| J32.9 | O cartão depois da medição | "Mensagens medidas" sobe ao menos 1 (a nossa; outra que tenha voltado à fila depois do escoamento também conta — a prova de que foi a NOSSA é a do dublê, na J32.7) | **PASS** — `jev-decisoes-rapidas.spec.ts` verde em 2026-09-24 (bancada fresca: pg15 + `baseline.sql` + `bootstrap-owner.ts`, build de produção, dublê) e na prova manual em campo com a chave REAL (Chromium dirigido como leigo, clínica recém-instalada): mensagens medidas, **clientes irritados percebidos**, custo e tempo |
| J32.10 | O Jev como IA que conversa | ausente do "Modelo padrão", do seletor do ponto "Medir o clima da conversa" e do seletor de IA do agente novo | **PASS** — `jev-decisoes-rapidas.spec.ts` verde em 2026-09-24 (bancada fresca: pg15 + `baseline.sql` + `bootstrap-owner.ts`, build de produção, dublê); derivação **PASS** (`tests/unit/provedores-de-decisao-catraca.test.ts`) |
| J32.11 | O Jev no "Qual você contratou" do onboarding | ausente | **PASS** em tela — prova de campo numa instalação fresca SEM chave: "Qual você contratou" lista Anthropic, OpenAI, Google, OpenRouter e DeepSeek, sem o Jev |
| J32.12 | Desligar | volta a pronto para ligar, e religar não pede o aceite de novo | **PASS** — `jev-decisoes-rapidas.spec.ts` verde em 2026-09-24 (bancada fresca: pg15 + `baseline.sql` + `bootstrap-owner.ts`, build de produção, dublê) e na prova manual em campo com a chave REAL (Chromium dirigido como leigo, clínica recém-instalada): "Envio aceito pela empresa em …", religar sem novo aceite |
| J32.13 | A mesma jornada contra a API de verdade | a chave paga passa no teste, a versão fixada responde e a medição aparece em Execuções | **PASS** local em 2026-09-24 (`jev-chave-real.spec.ts`, 7,5 s, chave do dono) — segue **FORA DO CI** (exige `JEV_API_KEY`) |
| J32.14 | Falha que pede ação (chave recusada, sem crédito) | aviso na Central dizendo o que fazer e se a IA de sempre de fato mediu; atualizado quando o desfecho piora; fechado sozinho quando o Jev volta a medir | **PASS** em tela na prova de campo: a TypeSafe real recusou a chave → aviso crítico na Central ("O Jev parou de medir o clima das conversas…") → chave certa colada pela tela → aviso fechado sozinho, com `resolved_at` |
| J32.15 | Irritação percebida pelo Jev | a passagem para humano diz "(percebido pelo Jev)" só no que a equipe lê | **PASS** em tela na prova de campo: título e resumo da passagem dizem "(percebido pelo Jev)"; a mensagem ao cliente não cita o Jev |
| J32.16 | A segunda tarefa: "Perceber tentativa de manipulação" (onda 2, bloco 2.1) | com o Jev ligado no aceite de cada mensagem, ela aparece no cartão com o selo "Nova" e a frase do que isso quer dizer, **observando sozinha** (R7), com os botões dela — inclusive "Pausar esta tarefa", a saída de quem não a quer sem desligar o Jev inteiro, e "Manter só observando", que tira o selo sem mudar nada; "Deixar o Jev decidir" do clima não muda a dela; a concordância dela ("deram o mesmo alerta (nenhum, leve ou forte) em X de Y", mais "só o Jev daria o alerta forte em N") sai de `jev_observacoes`; o cartão do ponto diz que o Jev SOMA quando ela decide; com a verificação "Detectar tentativa de manipular o assistente" desligada (aba "Confere antes de enviar" de qualquer agente, que o cartão nomeia e liga por link), a tarefa diz "Não roda" (sem comparação, sem "Deixar o Jev decidir", sem fazer o cartão "observar") e sai do "Usada em" da chave — e a Segurança passa a dizer que a verificação vem LIGADA do servidor, que é o que o worker faz | **PASS em unit/jsdom** (`CartaoDoJev.test.tsx`, `PainelDeProvedores.test.tsx`, `app/api/v1/ai/jev/route.test.ts`). **NÃO provado em tela**: o e2e do CI não sobe o agent-worker, e esta rodada não fez `next build`. A spec do CI foi ajustada para clicar o "Deixar o Jev decidir" DO CLIMA (com duas tarefas observando, o botão no cartão inteiro seriam dois), sem ter sido executada depois do ajuste |
| J32.17 | O Jev no turno do agente (a camada anti-manipulação) | camada ligada, fora da prévia e no turno da mensagem nova (`inbound_turn`): o Jev recebe SÓ o que o cliente digitou na última mensagem — mídia não sai, nem a transcrição/texto lido dela nem a moldura do agente (achado da verificação 2.1: o `skillSignal` levava um laudo inteiro) — e a linha em `jev_observacoes` + `llm_calls` sai amarrada ao job, uma por mensagem (o retry não duplica); observando vale a IA de sempre; decidindo, o maior dos dois (nunca rebaixa o "high"); sem a IA de sempre, "nenhum sinal"; chave recusada vira linha de erro em Execuções (a "Última falha" do cartão, por tarefa) com origem `jev_observacao` — a tela NÃO afirma consequência nem "não havia outra IA", porque a IA de sempre decidiu (achado da verificação r2); o teto de gasto que derruba a IA de sempre não perde o custo do Jev já chamado (R8); camada desligada, tarefa desligada e prévia não chamam o Jev | **PASS** no `test:db` pelo emissor de produção (`tests/invariants/jev-manipulacao-no-turno.test.ts`, 12 casos: handler real do `inbound_turn` e `runAgentPreview`, Postgres real, `fetch` dublê do Jev). Sabotagem medida (r3, `3 failed \| 9 passed`): sem gravar o Jev no `LlmBudgetExceededError` reprova "o teto de gasto…"; a origem `jev` na linha de erro reprova "chave recusada: a linha de erro diz que a IA de sempre decidiu…"; tirar as DUAS guardas da prévia (`!preview` e `job?.kind === 'inbound_turn'`) reprova "a prévia não grava". Tirar SÓ `!preview` não reprova nada: a prévia roda com `job = null`, e a guarda do `inbound_turn` já a barra — `!preview` fica como defesa redundante, sem caso que a isole. A guarda de camada foi vista reprovar na verificação r2. A linha de Execuções: `app/api/v1/ai/runs/route.test.ts`. Sem prova e2e (o CI não sobe o agent-worker) |
| J32.18 | A terceira tarefa: "Escolher qual agente atende" (onda 2, bloco 2.2), vista pela tela | com o Jev ligado no aceite de cada mensagem, ela aparece no cartão com o selo "Nova", **observando sozinha** (R7) — numa empresa sem roteador de intenção ativo com 1 a 254 intenções, "Não roda" com o link para os roteadores, sem comparação nem "Deixar o Jev decidir", e fora do "Usada em" da chave; em **Testar classificação** do roteador, "Sua IA escolheu … · O Jev escolheu … (X%)" lado a lado, com o AGENTE de cada um e o mínimo de confiança aplicado aos dois; o "Agente que atenderia" só vira o do Jev quando ele decide E a sua IA respondeu (R2); o clique não grava observação (R5), mas o custo dele entra em `llm_calls` (R8) | **Spec escrita, NÃO executada nesta rodada** (`tests/e2e/jev-roteador.spec.ts`, na `SPECS_PARTE_5`: cartão com as três tarefas + Testar classificação contra o dublê, com a escolha do Jev forçada por `DUBLE_JEV_RESPOSTAS`; a regra da rodada proibiu `next build`). **PASS em unit/jsdom**: `app/app/ai/routers/[id]/_client.test.tsx` (lado a lado, R2 na tela), `app/api/v1/ai/routers/[id]/test/route.test.ts` (sem observação, com custo; decide só com a IA respondendo), `CartaoDoJev.test.tsx` e `app/api/v1/ai/jev/route.test.ts` ("Não roda" sem roteador ativo) |
| J32.19 | O Jev no roteamento do turno | com roteador ativo e mensagem nova: o Jev recebe SÓ a última mensagem (sem o contexto das 4 anteriores que a IA de sempre lê), passada pelo `scrubMessage`, numa chamada só dele, com as intenções do roteador (1 a 254) + "nenhuma"; **observando, o turno não espera por ele** e o par (agente dele × agente da IA de sempre, amarrado a `job_id` e `message_id`) é gravado quando ele responde — concordância = MESMO AGENTE FINAL (duas intenções do mesmo agente concordam); decidindo, vale a escolha dele com o `min_confidence` sobre a probabilidade dele, e a IA de sempre cobre quando ele não responde (a busca da chave e a pergunta a ele têm, juntas, o teto de 1,5 s — `decidirNoPonto`; a leitura do estado vai pelo banco do turno, como as demais consultas dele); **sem a IA de sempre, a regra de hoje (sticky ou o de reserva), nunca o Jev (R2)** — e a saída dela que não é resposta (sem JSON, intenção inventada) conta como sem ela; decidindo, a cobertura da IA de sempre vira linha em `llm_calls` com `reserva_do_jev` (o cartão a conta); conversa com lead em handoff ou não elegível para a IA não sai para o Jev nem para a IA de sempre (as travas vêm antes de escolher o agente); o retry sobre a mesma mensagem não conta em dobro | **PASS** no `test:db` pelo caminho do turno (`tests/invariants/jev-roteador-no-turno.test.ts`, 8 casos: `resolveConversationTurn` com Postgres real, roteador, membros e agentes publicados de verdade, o Jev num `fetch` dublê e a IA de sempre num `classifyIntent` dublê — o verdadeiro sairia para a rede pelo registry padrão). Sabotagem medida: o turno esperar o Jev observando reprova o caso "observando" (timeout); tirar a guarda `verdict !== null` reprova os dois casos de R2; comparar por intenção em vez de agente reprova 5 casos. A fiação do handler (`deps.jev` chega ao roteador): `tests/unit/autonomia-routing-selection.test.ts`. A saída ilegível como falha, a linha de cobertura e as travas antes da escolha: **PASS só em unit** (`resolve-turn-agent.test.ts`, `roteador.test.ts`, `autonomia-routing-selection.test.ts` — a última com sabotagem medida: o handler de antes reprova 5 casos), sem caso no `test:db`. Sem prova e2e (o CI não sobe o agent-worker) |

**Achados da execução em campo (2026-09-24), todos consertados antes do PR:** a spec do CI
recarregava a página com o POST da chave em voo e o salvamento morria (status `-1` no trace);
aviso da Central fechado sem `resolved_at`; "Usada em" sumia depois de editar a chave; "Nome"
obrigatório barrava quem só colava a chave; ⌘K com a descrição do resultado selecionado em
**1,20:1** de contraste e cortando a palavra "Jev"; cartão espremido e custo fora da borda a
375 px; aviso "falta a IA principal" dentro do cartão com o Jev funcionando; nenhum número de
VALOR no cartão (entrou "Clientes irritados percebidos"); "Close" em inglês nos diálogos.
Evidência (capturas numeradas, chave mascarada) na bancada local da sessão.

"ESCRITA, NÃO EXECUTADA" quer dizer isso mesmo: a spec existe e passa pelas cercas
estáticas (`e2e-cobertura-completa` e as irmãs), mas ninguém a rodou contra um app
buildado ainda. Esta linha muda quando a primeira rodada da parte 5 medir.

### Achados da integração (cada um com commit próprio)

1. **O redator de segredo nunca apagou chave nenhuma** (`de7236805`). O padrão de
   `redigirMensagemDoProvedor` tinha um byte de backspace onde devia estar `\b`, desde
   2026-08-08: `sk-…`, `AIza…` e `Bearer …` chegavam inteiros à tela de Execuções.
   Apareceu ao escrever o caso da chave do Jev.
2. **O clima da conversa não media com a chave colada pela tela** (`3c3d4ccf5`). Um
   portão olhava só as variáveis do `.env`; quem pulou a chave no `install.sh` e a
   cadastrou depois ficava sem passagem por irritação, sem aviso nenhum.
3. **Cadastrar a chave do Jev já mandava as mensagens para fora** (`87332b348`), antes
   de alguém ligar ou aceitar. A guarda passou para onde toda chamada passa.
4. **O `scrubMessage` não apagava telefone como se escreve no Brasil** (`625f895a6`):
   `(11) 98765-4321` passava inteiro — para o Sentry e para a frase de aceite do Jev,
   que prometia o contrário.
5. **O aviso "falta a chave da sua IA principal" era falso** quando a chave estava no
   `.env` (`65b8078c6`).
6. **O filtro `?provider=` de Execuções** era afirmado no cabeçalho da rota e não
   existia (`4a38195fc`).

### Achados da prova em campo (2026-09-23, instalação zerada, chave real do Jev)

Dirigida pela tela como leigo; capturas fora do repo (bancada do coordenador). Os
consertos estão em commits próprios desta branch — procure pelas palavras abaixo em
`git log main..HEAD`.

1. **A spec abortava o próprio cadastro da chave** — recarregava a página logo depois
   de "Salvar e validar", e o `POST` saía com status -1. Agora espera a resposta e o
   cartão mudar sozinho.
2. **Aviso do Jev fechado sem `resolved_at`**, fora da convenção da Central.
3. **"Usada em" sumia depois de trocar a chave** até recarregar: vinha de uma foto
   tirada no servidor com a chave nova ainda em teste. Hoje sai da lista viva.
4. **O "Nome" obrigatório barrava quem colava só a chave.** Opcional; vazio vira o
   nome do provedor.
5. **⌘K ilegível no item destacado** (cinza sobre verde, 1,20:1) e a descrição de
   Provedores cortada antes do "Jev". O "X" dos diálogos se anunciava "Close".
6. **Cartão**: aviso de "falta a IA principal" repetido com o Jev funcionando, nada
   dizendo que a chave foi conferida, sem número de valor ("Clientes irritados
   percebidos"), um zero de reserva que nunca muda sem IA de sempre, cabeçalho e
   números espremidos a 375 px, link com 20 px de alvo.
7. **Execuções não dizia se o Jev decidiu ou observou**, e o motivo da passagem no
   Inbox só atribuía ao Jev no resumo, não na frase em destaque.

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
| J4.37 | **Marcar como perdido oferece os motivos do FUNIL** (#918) | a janela lista `settings.lost_reasons` do funil do card, recusa em "Outro" o texto que o trigger negaria (22023) e diz onde se cadastra um motivo novo; confirmar grava o motivo com o texto do operador · `tests/e2e/motivos-de-perda-do-funil.spec.ts` (SPECS_PARTE_1) + `tests/unit/kanban-motivos-de-perda-do-funil.test.tsx` (9 casos). Evidência: `evidence/motivos-de-perda-do-funil/` |
| J4.40 | ✅ **"Motivos de perda extras" da ORGANIZAÇÃO saiu da tela** | O campo gravava `organizations.settings.lost_reasons_extra`, que ninguém lia: `fn_validate_lost_reason_required` aceita canônico ∪ `crm_pipelines.settings.lost_reasons`, e a janela de perder lê o funil pelo `useMotivosDePerdaDoFunil`. Das duas saídas que este item registrava — o trigger unir organização ∪ funil, ou o campo sair —, tomou-se a segunda: manter dois campos quase homônimos, um que vale e um que não, custa mais do que o alcance por organização entrega, e o motivo de perda é vocabulário do FUNIL (é nele que o relatório de perdas agrupa). O dado já gravado fica na linha, intocado, e volta a ser alcançável se a outra saída for escolhida um dia |
| J4.39 | **Tag em lote oferece as tags que já existem** (#852, item 3) | o menu "Tag…" lista até 10 tags dos leads do quadro e digitar filtra. ⚠️ Defeito achado NA TRIAGEM e medido em jsdom: o typeahead do menu do Radix roubava o foco do campo na primeira tecla (digitar "goo" deixava "g" no campo) e o Enter aplicava a tag do MENU a todos os selecionados · `tests/unit/tag-em-lote-mostra-existentes.test.tsx` (4 casos, um deles no ponto de uso). **Falta prova de tela**: abrir o quadro com ≥12 tags distintas, selecionar 2 cards, digitar uma tag nova que comece como uma existente e conferir o texto inteiro no campo |
| J4.38 | **Excluir um card pelo menu do próprio card, inclusive no toque** (#910) | o botão de ações é visível sem hover em aparelho de toque (opacidade COMPUTADA, não a string do `className`) e o menu traz "Excluir", que abre o `AlertDialog` da doutrina destrutiva · `tests/e2e/lote-no-quadro-do-funil.spec.ts` (bloco de toque) + `tests/unit/kanban-card-excluir.test.tsx` (5 casos). Evidência: `evidence/excluir-card-no-toque/` |
| J4.42 | **O funil arquivado tem porta de volta** (#979) | a gaveta "Funis arquivados (N)" nasce FECHADA na tela de Funis, abre com um clique, e de lá o funil volta para a lista viva (sobrevivendo ao reload) ou é excluído de vez com painel de confirmação. As duas asserções que impedem a regressão: o arquivado **não** aparece na lista de trabalho **nem no seletor de destino da importação** (o vazamento que os PRs #941/#944 tiraram de outras telas), e quem é `agent` não vê a gaveta nem o nome do funil arquivado. `tests/e2e/funil-arquivado-volta-pela-tela.spec.ts` (SPECS_PARTE_4) + `tests/unit/funil-arquivado-caminho-de-volta.test.ts` (4 casos, a regra da rota). A spec grava medidas (`getBoundingClientRect`) e capturas em `.superpowers/evidence/funil-arquivado-volta/`. ⚠️ **ESCRITA NESTA ENTREGA E AINDA NÃO EXECUTADA** — nenhum job a invocou até aqui, e verde local também não existe; quem decide é a primeira rodada do `e2e`. Se reprovar por ambiente, o lugar dela é o `FORA_DO_CI` COM o motivo medido, nunca uma exclusão preventiva |
| J4.41 | **Arrastar o mesmo card duas vezes seguidas** (#916, PR #919) | o segundo arrasto, feito logo depois do primeiro e com o refetch do quadro segurado (a rede lenta de uma VPS distante), responde `200` e o card chega à terceira etapa, sem o aviso "modificado por outro usuário" e sem recarregar a página; o banco guarda a etapa final. `tests/e2e/kanban-owner-filter.spec.ts`, funil próprio, arrasto pelo teclado do `@hello-pangea/dnd` (executado 2026-09-16, ambiente fresco do `baseline.sql`). Evidência: `evidence/arrastar-duas-vezes/01-depois-do-primeiro.png` (o card na segunda etapa, depois do primeiro arrasto) e `evidence/arrastar-duas-vezes/02-depois-do-segundo.png` (na terceira, depois do segundo) |

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
| J5.10 `[P0]` | Convite pendente aparece na aba **Membros** | seção "Convites" lista e-mail, papel, interface, status (Pendente/Aceito/Expirado/Revogado), data de envio e de expiração, quem convidou · antes só existia numa lista efêmera dentro do modal "Convidar membros" · `lib/team/convite-status.test.ts` + `tests/e2e/invite-lifecycle.spec.ts` casos 13–16 |
| J5.11 `[P0]` | E-mail do convite **não saiu** (VPS sem Resend) | a linha mostra "Não saiu" + botão **Copiar link** ali mesmo (usa `team_invites.email_dispatched`, antes só legível no `api_audit_log`) — o admin não fica achando que enviou |
| J5.12 | Admin **revoga** um convite pendente | `POST /api/v1/team/invites/[id]/revoke` marca `revoked_at`; o aceite passa a recusar o token mesmo dentro da validade; audita `member.invite_revoked` |
| J5.13 | Admin **reenvia** um convite | `POST /api/v1/team/invites/[id]/resend` re-assina o mesmo `invite_id`, renova 24h, audita `member.invited`; reconvidar o mesmo e-mail pendente pela tela de convite RENOVA a linha (índice único parcial) |
| J5.14 | Manager vê a lista, mas não as ações | leitura é `team_invites_select` (manager+); reenviar/revogar são admin-only (403) |

### J5.15 `[P0]` — Convite SMTP em Docker com hostname curto

Falha observada na release 1.48.0: conexão e autenticação SMTP passavam, mas seis
convites aceitos pelo servidor foram classificados como `filtered` pelo router
HostGator `fightspamHG`. O Nodemailer, sem `name` explícito e com hostname Docker
curto, usava EHLO `[127.0.0.1]`. `email_dispatched=true` atesta aceitação SMTP,
não entrega na caixa de entrada.

Correção: `lib/email/smtp.ts` identifica envio e verificação com o hostname de
`env.NEXT_PUBLIC_APP_URL`, já configurado pelo instalador. A opção é lida do
ambiente validado em runtime; não exige novo campo nem ajuste de compose.
`tests/unit/smtp-identifica-a-instalacao.test.ts` usa Nodemailer real e receptor
TCP local: mede EHLO, envio de mensagem, verificação sem envio, URL com porta/caminho,
literais IPv4/IPv6, fallback local, cache e ausência de configuração.

**Evidência externa em 25/09/2026:** teste controlado com FQDN recebeu `success` no
rastreamento do provedor e confirmação de recebimento pelo destinatário. Após o
workaround equivalente de hostname no contêiner da instalação, quatro convites
reenviados pelo endpoint oficial tiveram `success` no gateway. Isso valida o
mecanismo; o patch de código deste PR foi exercitado no receptor local. **Não medido:**
entrega desses quatro convites nas caixas finais, todos os provedores e uma nova
jornada Playwright em instalação fresca. Nenhum endereço ou token real é necessário
para reproduzir o teste local.

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

## J31 — A clínica sai do zero em follow-up sem desenhar um grafo `[P0]`

Contexto do código: o motor de follow-up está inteiro desde a 0054, e mesmo assim
uma instalação nova não tem fluxo NENHUM — ter o primeiro exigia abrir o
construtor e desenhar nó, ramo e prazo de graça, além de escrever os textos. É
primeira impressão (`[P0]`) por isso: a tela vazia promete "sem depender de
alguém lembrar de mandar mensagem" e não entrega nada. `lib/followup/modelos/`
traz as quatro jornadas de clínica (consulta, exame, cirurgia, falta) e a
galeria instala uma delas como RASCUNHO, com o gatilho já armado.

Spec: `tests/e2e/followup-modelos-de-clinica.spec.ts` — dirige a tela; o grafo
que aparece no construtor é o do catálogo, gravado pela rota real
(`POST /api/v1/ai/followup-flows/from-model`), sem `INSERT` à mão.

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J31.1 | Tela vazia de Follow-ups | "Começar de um modelo" aparece ANTES de "Novo fluxo" | **NÃO MEDIDO EM TELA** — o ambiente e2e (stack Supabase local + seed de credenciais) não foi levantado nesta sessão; coberto por unit + rota |
| J31.2 | Abrir a galeria | as 4 jornadas, cada uma com nº de mensagens, horizonte e o que dispara | **NÃO MEDIDO EM TELA** |
| J31.3 | Instalar o modelo de falta | cria o fluxo e abre o construtor com o grafo desenhado | **NÃO MEDIDO EM TELA** |
| J31.4 | O fluxo recém-instalado na lista | badge "Rascunho" — instalar não manda mensagem a paciente nenhum | **NÃO MEDIDO EM TELA**; garantido por `from-model/route.test.ts` ("nasce RASCUNHO") |
| J31.5 | Modelo de etapa sem etapa escolhida | botão "Instalar" travado; a rota recusa com `trigger_stage_missing` | **UNIT/ROTA PASS**, tela **NÃO MEDIDA** |
| J31.6 | Instalar o mesmo modelo duas vezes | selo "Já instalado"; a rota responde 409 nomeando o fluxo existente | **UNIT/ROTA PASS**, tela **NÃO MEDIDA** |
| J31.7 | Viewer na tela | não vê a galeria (`canWrite`) | **NÃO MEDIDO EM TELA** |
| J31.8 | Todo modelo do catálogo é publicável | `validateFlowForPublish` aprova os 4 sem erro | **PASS** — `lib/followup/modelos/modelos.test.ts` |

⚠️ **O que a galeria NÃO faz, e a tela diz:** publicar e armar o fluxo no agente
continuam sendo atos de gente. Sem um agente PUBLICADO com o ponteiro em
`followup.flow_pointer_ids`, gatilho automático não enrolla ninguém
(`agent-followup-gate.ts`) — fluxo com cara de vivo. A linha está no rodapé do
diálogo e é asserida na spec.

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J31.9 | Fluxo automático publicado que nenhum agente arma | a Central abre um aviso nomeando o fluxo e quando ele dispararia | **PASS (unit)** — `app/api/v1/cron/followup-sem-agente/route.test.ts`; tela **NÃO MEDIDA** |
| J31.10 | O mesmo fluxo depois de ligado no agente | o aviso é FECHADO pelo próprio cron, sem ninguém tocar nele | **PASS (unit)** |
| J31.11 | Fluxo manual ou de webhook sem agente | nenhum aviso — eles funcionam sem agente, e o alarme seria falso | **PASS (unit)** |
| J31.12 | Rodada do cron que não mudou nada | não audita (CLAUDE.md §Audit log) | **PASS (unit)** |

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
| J10.9 | Dois logos, um por tema, com remoção independente | arte escura sem moldura na prévia, menu e login; remover apenas a escura preserva o padrão com a proteção anterior | `tests/e2e/logo-moldura-no-tema-escuro.spec.ts`, caso (7); ver evidência da execução no PR |

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
| J13.10 | Cadastrar a credencial do Google pela tela do admin | **PASS** (issue #370) — `admin-credencial-google.spec.ts`, contra o app real. O CI grava a chave mestra de cifra no ambiente do e2e desde `.github/workflows/e2e.yml` (o que faltava quando esta linha foi escrita "NÃO EXERCITADO"). Prova: dono cadastra em `/admin/google`, o `client_secret` NÃO volta ao navegador nem recarregando nem no HTML servido, o cartão da Agenda para de pedir SSH e passa a oferecer "Conectar Google", e admin de tenant é barrado (`redirect` para `/admin/forbidden` antes da página rodar). Evidência: `evidence/admin-credencial-google/1-nao-cadastrada.png`, `evidence/admin-credencial-google/2-cadastrada-segredo-nao-volta.png`, `evidence/admin-credencial-google/3-cartao-da-agenda-oferece-conectar.png` |
| J13.11 | Compromisso do Google que começa antes do período desenhado aparece na grade, fatiado na borda | **NÃO COBERTO** — medido só por unidade sobre dublê do cliente Supabase (`tests/unit/agenda-recorte-do-google-atravessa-o-limite.test.ts`); falta prova pela tela num ambiente com Google conectado. ⚠️ O conserto morde na BORDA do período que a tela desenha (virada da semana na visão Semana, do mês na visão Mês, meia-noite na visão Dia). Dentro do período desenhado a grade continua atribuindo o bloco só à coluna do dia em que ele COMEÇA (`components/agenda/GradeDaAgenda.tsx`, `isSameDay(comeca, dia)`) — essa metade é item próprio |
| J13.12 | Agendamento INTERNO que atravessa a meia-noite aparece na janela do dia seguinte | **NÃO COBERTO, e o defeito é conhecido** — `listaAgendamentos` recorta por começo e não por interseção (`lib/agenda/consulta.ts`, `.gte("starts_at", de).lt("starts_at", ate)`), enquanto `coletaOQueOcupa` no mesmo arquivo já usa interseção: mesma discordância tela↔motor da #525, do lado interno. Não consertado junto porque `listaAgendamentos` também alimenta a ferramenta MCP do agente (`lib/mcp/tools/agendamento.ts`) — mudar o recorte muda o que o agente enxerga, e isso é decisão de contrato
| J13.13 | ⚠️ **`viewer`/`agent` continuam sem ver a ocupação do Google do COLEGA na grade** | **NÃO COBERTO, e o defeito é conhecido** — a leitura da tela é pela SESSÃO, com o embed `calendar_connections!inner` (`lib/agenda/ocupacao-externa.ts`), e a RLS `calendar_connections_dono_ou_manager_read` (`supabase/baseline.sql`) só libera `user_id = auth.uid()` ou `fn_role_at_least(org,'manager')`. O motor (`fn_agenda_ocupacao_google_do_dono`, migration 0260) é `security definer` e entrega a ocupação a TODO membro: para esses dois papéis a tela desenha livre todo compromisso do colega enquanto a marcação recusa. É a metade da #525 que o #915 **não** fecha — ele fecha a FRONTEIRA do recorte, não o PAPEL de quem olha (resíduo da #879). O dublê de `tests/unit/agenda-recorte-do-google-atravessa-o-limite.test.ts` não modela papel nem RLS, então a suíte não pode enxergar isto. Fechar é decisão de produto sobre QUEM vê |

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
| J14.7 | Em janela larga e BAIXA (1024×560, 1280×500) o formulário rola com a roda do mouse até o Confirmar, e a marcação grava; 390×700 é o controle empilhado | **NÃO MEDIDO em tela local** — caso novo em `agenda-painel-cabe-na-tela.spec.ts` (roda do mouse, botão inteiro na viewport, teste de oclusão, `POST /api/v1/agenda/agendamentos` 2xx e "Marcado."); a prova é o `e2e` do CI. A forma é vigiada por `tests/unit/agenda-confirmar-alcancavel.test.ts`. Antes: Sheet com `lg:overflow-hidden` e painel em `lg:flex-1 lg:min-h-0`, com o formulário acima (vínculo, tipos, convidado, endereço, observação) comendo quase toda a altura — a conta das alturas deixa o painel com uma fresta em 1024×560 e sem espaço em 1280×500 |

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
| J16.6 | A ida ao Google pede o SELETOR de contas, e só SUGERE a do login | **PASS** — `agenda-google-connect-route.test.ts`, caso "manda para o consentimento do Google…", sobre o header `Location` de verdade: `accounts.google.com/o/oauth2/v2/auth`, `prompt` = {`consent`,`select_account`}, `login_hint` = o e-mail de quem clicou. A regra pura tem o par em `agenda-google-oauth.test.ts`, casos "pede acesso offline…" (inclusive a forma no fio, `prompt=consent+select_account`) e "deixa escolher OUTRA conta…" |
| J16.7 | O botão da tela leva à rota que produz essa ida | **PASS** — `agenda-cartao-conexao-google.test.tsx`, `href` do `conectar-google`. Era o único elo da corrente tela→Google que nenhum teste segurava |

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

**Duas dívidas do lote 12 (grupo G4, PRs #931/#933), declaradas e não pagas:**

1. **Ninguém abriu a tela do Google com duas contas logadas.** J16.6 mede o que o
   CRM ENVIA, que é o que nos cabe; que o Google DESENHE o seletor com as duas
   contas é dedução a partir da documentação dele, não observação. Provar exige
   conta Google de teste com consentimento pré-aprovado — o mesmo bloqueio que
   mantém o caso 2 de `agenda-conectar-google.spec.ts` em `test.skip`.
2. **Trocar a conta escolhida por engano tem saída, mas a conta certa nasce sem
   agenda de destino.** Com o seletor de volta, escolher a conta errada virou um
   clique. A saída existe: "Desconectar" some com ela, e a tela devolve o botão
   "Conectar Google" porque só lista conexão com `status` diferente de
   `disconnected` (`app/app/agenda/page.tsx`). Só que `fn_google_catalog` marca o
   calendário primário como destino apenas quando a pessoa tem UMA linha em
   `calendar_connections` — e a desconectada continua contando. Resultado: o
   compromisso seguinte não é reservado no Google e grava "Escolha uma agenda de
   destino nas configurações." (que a escolha manual ali o destrave NÃO foi
   medido). Medido em
   Postgres descartável com o `baseline.sql` aplicado, chamando as funções do
   banco (`fn_google_catalog`, `fn_google_appointment`) — controle: conta única
   vira destino; conta errada desconectada + conta certa conectada: a certa sem
   destino e o aviso gravado.
   Controle da própria medição: invertidas as duas previsões, as duas ficaram
   vermelhas com os valores reais. Consertar é migration, fora deste grupo.

   Uma porta "Conectar outra conta" (sem desconectar a errada) foi escrita e
   desfeita neste mesmo lote, e o motivo é medido na mesma rodada: com a errada
   de pé, a certa entra sem destino, o compromisso vai para a agenda da ERRADA,
   e ela só sai derrubando as duas.

---

## J22 — Cadastrar o App da Meta pela tela, e colar na Meta o token que vale `[P0]`

**Por que P0:** é a primeira coisa que o dono faz para receber pelo número
oficial. Até a tela `/admin/meta` existir, isso exigia editar o `.env` na VPS
(issue #850); a migration 0257 (PR #861) guardou a credencial no banco, mas
nenhuma tela a gravava.

| # | Caso | Resultado |
|---|---|---|
| J22.1 | Admin Plataforma › API Oficial (Meta) aparece no menu e abre a tela | **PROVADO EM TELA** (2026-09-15, `33ece762a`) — pelo seletor de organização › Gerenciar organizações › menu, sem digitar URL. Evidência: `evidence/triagem-15set-l8/861-02-menu-admin-api-oficial.png` |
| J22.2 | Primeiro save com a chave secreta mostra o token gerado, com Copiar | **PROVADO EM TELA** — campo esvazia, placeholder "(já cadastrada)", Copiar põe o token na área de transferência (lido de volta). `evidence/triagem-15set-l8/861-04-token-gerado-copie-agora.png` |
| J22.3 | Recarregar a página: o token some, a tela diz "Gerado em …" | **PROVADO EM TELA** — o token não está nem no HTML servido. `evidence/triagem-15set-l8/861-07-recarregado-token-some.png` |
| J22.4 | Gerar novo token pede confirmação com o efeito, e mostra o novo | **PROVADO EM TELA** — cancelar não muda `verify_token_created_at`; confirmar mostra token diferente. `evidence/triagem-15set-l8/861-08-confirmacao-novo-token.png`, `evidence/triagem-15set-l8/861-09-novo-token-diferente.png` |
| J22.5 | Handshake da Meta (`GET …/webhooks/meta/<token>?hub.verify_token=`) passa com o token da tela e recusa o antigo | **PROVADO POR CURL** (diagnóstico) — sessão `meta_cloud` inserida por SQL (conectar exige Graph real): token da tela `200 x`, anterior `403`, inclusive 99 ms após a rotação |
| J22.6 | Conexões › API Oficial (Meta) não mostra token do `.env` quando vale o da instalação, e oferece o link da tela ao platform admin | **PROVADO EM TELA** — dono vê "Já cadastrado…" e o link (leva a `/admin/meta`); admin de tenant vê o aviso sem o link. `evidence/triagem-15set-l8/861-13-400px-escuro-conexoes-token-na-instalacao.png`, `evidence/triagem-15set-l8/861-15-admin-de-tenant-conexoes-sem-link.png` |
| J22.7 | Instalação sem `.env` de Meta (estado real de VPS nova): nenhuma tela manda "configurar no servidor" | **PROVADO EM TELA** — `/admin/meta` abre "Nunca configurado por aqui." sem aviso de `.env`; Conexões com canal não tem "defina no servidor" (contagem 0). `evidence/triagem-15set-l8/861-03-tela-nunca-configurada.png` |
| J22.8 | Admin de organização que não é platform admin não abre `/admin/meta` | **PROVADO EM TELA** — termina em `/admin/forbidden`, formulário não renderiza, o seletor não oferece "Gerenciar organizações". `evidence/triagem-15set-l8/861-14-admin-de-tenant-nao-abre-admin-meta.png` |
| J22.9 | 400px e tema escuro | **PROVADO POR MEDIDA** — `scrollWidth` 400 = `clientWidth` 400 em repouso, na confirmação e com o token; o token de 43 caracteres rola dentro do campo (342px em 201px). `evidence/triagem-15set-l8/861-10-400px-escuro-repouso.png`, `evidence/triagem-15set-l8/861-11-400px-escuro-confirmacao.png`, `evidence/triagem-15set-l8/861-12-400px-escuro-token-gerado.png` |
| J22.10 | Instalação sem a chave de cifra no banco | **Recusa com motivo, nada gravado** — o texto é técnico ("GUC app.nuvemshop_oauth_key ausente"). O `install.sh` sempre semeia a chave; o prelúdio do e2e não. `evidence/triagem-15set-l8/861-extra-sem-chave-de-cifra-recusa-com-motivo.png` |

**Dois defeitos achados ao ligar a tela, corrigidos antes dela:**
1. O primeiro save sem chave secreta gravava um token SOZINHO e o devolvia para
   copiar. O resolvedor serve o par inteiro ou cai para o `.env`, então o token
   nunca valia e a Meta receberia 403. A action recusa com
   `app_secret_obrigatorio` (a rotação também).
2. `GET /api/v1/channels/official` lia o token do `.env` direto: com o App
   cadastrado pela tela, Conexões mostrava o token errado (ou "defina no
   servidor"). Passou a perguntar ao resolvedor.

---

## Lote 8 da triagem — Agenda e Contatos provados em tela (2026-09-15)

Integração `integracao/triagem-15set-l8` no SHA `33ece762a`, banco do
`baseline.sql` em pg17, dono do `bootstrap-owner.ts`, `next build` + `next start`,
sem Google, sem IA, sem Resend. Evidência e régua de cada caso em
`evidence/triagem-15set-l8/README.md`.

| # | Caso | Resultado |
|---|---|---|
| L8.1 | #860 — Confirmar na aba "Aguardando confirmação" | **PROVADO EM TELA** — a linha sai da aba (2→1), aparece em Próximos, banco `confirmed`. "Exige aprovação" não tem tela: ligado por `PATCH /api/v1/agenda/tipos` com a sessão do dono. `evidence/triagem-15set-l8/860-03-linha-saiu-da-aba-aguardando.png` |
| L8.2 | #860 — Confirmar horário no painel do compromisso | **PROVADO EM TELA** — o pendente vira "Agendado" e o botão some. `evidence/triagem-15set-l8/860-07-painel-confirmou-vira-agendado.png` |
| L8.3 | #858 — Pessoa marca 10:30 numa grade de hora cheia | **PROVADO EM TELA** na porta entregue depois da QA (`triagem/lote-8-encaixe-na-tela`, SHA `0c71973d4`, ambiente fresco próprio): Novo agendamento › segunda › "Outro horário" › 10:30 › Confirmar → `201`, banco `10:30-11:30` `user/ui`, e o card na grade na altura do bloco das 10:30. A grade e o arrastar seguem só com horário publicado, de propósito. **Antes:** FALHOU EM TELA — o painel só listava horas cheias e a rota só era alcançável chamando a API com a sessão (`evidence/triagem-15set-l8/858-02-painel-oferece-so-hora-cheia.png`). `evidence/triagem-15set-l8-encaixe/03-outro-horario-1030-confirmando.png`, `evidence/triagem-15set-l8-encaixe/05-grade-mostra-o-encaixe-1030.png` |
| L8.3a | #858 — Encaixe por cima de outro encaixe | **PROVADO EM TELA** — 10:45 sobre o das 10:30: `422`, a frase da rota acima do Confirmar, painel aberto, campo com 10:45, um compromisso só no banco. `evidence/triagem-15set-l8-encaixe/06-recusa-por-cima-do-encaixe.png` |
| L8.3b | #858 — Encaixe num dia sem horário publicado, e remarcar para fora da grade | **PROVADO EM TELA** — domingo abre direto no campo (`201`, `09:15`); Remarcar abre o mesmo painel (`PATCH` `200`, `11:15`). `evidence/triagem-15set-l8-encaixe/07-domingo-sem-grade-encaixe-0915.png`, `evidence/triagem-15set-l8-encaixe/09-grade-mostra-remarcado-1115.png` |
| L8.3c | #858 — "Outro horário" a 400px no escuro, e escondido de quem só lê | **PROVADO EM TELA** — 400/400 sem elemento fora da tela; papel `viewer` não vê a opção (contagem 0). `evidence/triagem-15set-l8-encaixe/10-400px-escuro-outro-horario.png`, `evidence/triagem-15set-l8-encaixe/12-somente-leitura-sem-outro-horario.png` |
| L8.4 | #858 — Marcar por cima de compromisso existente | **PROVADO EM TELA** — duas abas disputam 17:00; a segunda recebe `422` e o aviso "Este horário já está ocupado na agenda de quem atende — por outro compromisso ou pelo Google Agenda." `evidence/triagem-15set-l8/858-04-recusa-por-cima-de-compromisso-mensagem.png` |
| L8.5 | #858 — Evento do Google Agenda ocupando o encaixe | **NÃO MEDIDO** — sem Google real |
| L8.6 | #859 — Contato com telefone já usado | **PROVADO EM TELA** — `409 contact_exists`, aviso "Já existe um contato com este telefone.", diálogo aberto. `evidence/triagem-15set-l8/859-02-telefone-repetido-diz-o-motivo.png` |
| L8.7 | #859 — O mesmo número sem o nono dígito | **PROVADO EM TELA** — mesmo `409` e mesma frase; uma linha no banco. `evidence/triagem-15set-l8/859-03-mesmo-numero-sem-nono-digito.png` |

**Achado na prova do encaixe, consertado:** o botão Confirmar do painel de marcar
ficava inteiro fora da caixa em 1280×800 e 1366×768, e cortado em 1440×900 — o
painel tem a altura do Sheet, que não rola, e o `overflow-hidden` cortava sem barra.
Valia para toda marcação, não só o encaixe. O corpo do painel passou a rolar a partir
de `lg`; medido depois em seis larguras em
`evidence/triagem-15set-l8-encaixe/README.md`.

**Achado fora do lote:** marcar ou confirmar pela tela não emite o gatilho de
automação da Agenda — o INSERT em `event_log` sai com o cliente da sessão e bate
na RLS (`new row violates row-level security policy`). Toda automação por
`appointment.created`/`appointment.confirmed` fica muda para o que a equipe faz
pela tela. O trecho é igual na `main`. → Consertado no lote 9 (#877), provado abaixo.

---

## Lote 9 da triagem — automações da Agenda, avisos na Central e o seed de demonstração (2026-09-15)

Integração `integracao/triagem-15set-l9` no SHA `cfdb43575`, banco do
`baseline.sql` em pg17, dona do `bootstrap-owner.ts`, chave de cifra semeada como o
`install.sh`, `next build` (exit 0) + `next start`, cron imitado chamando
`/api/v1/cron/event-log-drain` com o `INTERNAL_SECRET` 1×/min. Sem IA, sem Resend,
sem Google, sem Meta. Evidência, régua e o que foi SQL em
`evidence/triagem-15set-l9/README.md`.

| # | Caso | Resultado |
|---|---|---|
| L9.1 | #877 — Regra "Quando um horário for marcado" → "Adicionar tag" dispara quando a dona marca pela Agenda | **PROVADO EM TELA** — `201`, o cron drena no tick seguinte, Atividade "Sucesso · Adicionar tag" e a etiqueta no contato; zero "gatilho de automação não foi emitido" no log do servidor. `evidence/triagem-15set-l9/877-05-atividade-regra-executou-sucesso.png`, `evidence/triagem-15set-l9/877-06-contato-com-a-tag-da-regra.png` |
| L9.1a | #877 — Controle positivo na `main` (`b9bc24cf4`), mesmo banco e mesma regra | **NÃO EXECUTAVA** — `201` e "Marcado.", mas o servidor registra `new row violates row-level security policy for table "event_log"`, nenhum evento nasce, a Atividade fica com a execução anterior e o contato sem etiqueta. `evidence/triagem-15set-l9/877-controle-main-03-atividade-so-a-execucao-da-marina.png`, `evidence/triagem-15set-l9/877-controle-main-04-rui-sem-tag.png` |
| L9.2 | #871 — Evento com handler que esgota as 5 tentativas no dreno do cron abre aviso | **PROVADO EM TELA** — mídia recebida por webhook WAHA assinado, download para um WAHA fora do ar, backoff real (≈30 min): "Um processamento parou de tentar (media.persist_requested)", só "Marcar resolvido", sem "reprocessar". Canal WAHA inserido por SQL. `evidence/triagem-15set-l9/871-01-central-aviso-generico-evento-morto.png` |
| L9.3 | #871/#872 — Com o genérico aberto, o despacho da IA que morre também avisa | **PROVADO EM TELA** — "A IA deixou de responder uma mensagem de cliente" ao lado do genérico ("Abertos (2)"); mais três mortes não abrem outro; resolvido, a próxima morte reabre. Despachos com contato inexistente preparados por SQL; a morte é do worker real. `evidence/triagem-15set-l9/871-02-central-aviso-da-ia-e-generico-coexistem.png`, `evidence/triagem-15set-l9/871-04-depois-de-resolvido-a-proxima-morte-reabre-o-aviso-da-ia.png` |
| L9.3a | #872 — `midia_nao_lida` quando a derivação estoura por exceção | **NÃO MEDIDO** — exige mídia persistida e chamada ao provedor de IA falhando; sem WAHA servindo arquivo e sem IA, sem caminho |
| L9.3b | #871/#872 — Corpo dos avisos legível para quem não programa (`d9a81523e`) | **PROVADO POR TESTE, NÃO EM TELA** — o corpo do `event_dead` (genérico e da IA) e do `midia_nao_lida` da falha permanente começa pelo que aconteceu e pelo que fazer; evento, tentativas e motivo cru vão no fim, depois de "Detalhe técnico, para quem der suporte:". O título genérico ainda leva o nome do evento (um invariante congelado conta avisos por ele). `tests/unit/aviso-de-evento-morto-le-para-leigo.test.ts`, `tests/unit/media-derive-worker.test.ts` |
| L9.4 | #875 — Seed contra URL não-local | **PROVADO POR SONDA** — exit 2 e nenhuma requisição (sonda de `fetch`/`http`/`net`/`dns` no processo); com `--permitir-remoto` a mesma sonda registra `GET` e `POST` para o host `.invalid` |
| L9.5 | #875 — Regras e histórico de demonstração na tela | **PROVADO EM TELA** — três regras ativas; Sucesso, Parcial (`user_not_in_org`) e Falhou (`TypeError: fetch failed`), cada execução com as ações da própria regra; a regra VIP abre no editor com a condição no seletor. `evidence/triagem-15set-l9/875-02-seed-historico-sucesso-parcial-falha.png`, `evidence/triagem-15set-l9/875-03-seed-regra-vip-no-editor.png` |
| L9.6 | #875 — Follow-ups de demonstração | **VISÍVEIS, TRILHA INCOERENTE** — fluxo ativo e as quatro inscrições na Fila; o dossiê diz "Começou 15/09" com passos de 12/09 e 13/09, os passos saem como "código: enrolled"/"código: node_entered" (este último nenhum código emite) e "Aguardando resposta" sem passo de envio. Medido em `cfdb43575`; consertado em L9.6a. `evidence/triagem-15set-l9/875-05-seed-followups-fila-com-as-inscricoes.png`, `evidence/triagem-15set-l9/875-06-seed-followup-dossie-com-trilha.png` |
| L9.6a | #875 — Trilha dos follow-ups de demonstração depois do conserto (`5a83d292a`) | **PROVADO EM TELA** — mesmo dossiê, antes (seed de `e0b68b70f`: "código: enrolled"/"código: node_entered", passos antes do início) e depois: "Começou 13/09 22:28" e seis passos do motor em ordem até "Espera a resposta"; os outros três dossiês lidos pela mesma sonda. A trilha é reencenada com o motor real em `tests/unit/followups-de-demonstracao-sao-possiveis.test.ts`. `evidence/triagem-15set-l9/875-07-dossie-antes-trilha-impossivel.png`, `evidence/triagem-15set-l9/875-08-dossie-depois-trilha-do-motor.png` |
| L9.6b | #875 — Resumo do seed numa rodada repetida | **PROVADO POR SAÍDA** — com 3 regras, 3 execuções e 4 inscrições no banco, diz "3 execuções no histórico (0 criadas nesta rodada)", "4 inscrições (0 criadas nesta rodada)" e manda olhar "Webhooks › abas Automações e Atividade". `evidence/triagem-15set-l9/875-09-seed-resumo-duas-rodadas.txt` |
| L9.7 | Regressão do lote 8 na árvore combinada | **PROVADO EM TELA** — Agenda abre; "Outro horário" 10:45 chega à confirmação com o Confirmar dentro do painel (843–875 em 0–900); `/admin/meta` `200`. `evidence/triagem-15set-l9/l8-regressao-02-outro-horario-1045-confirmando.png`, `evidence/triagem-15set-l9/l8-regressao-03-admin-meta-carrega.png` |

**Ressalva de leitura:** os dois avisos da Central levam no corpo o nome técnico do
evento e o motivo cru (`media_persist_v1: fetch failed`; a frase inglesa da FK do
Postgres no da IA).

---

## Lote 10 da triagem — folga à noite e o Google da dona visto pela Atendente (2026-09-15)

Integração `integracao/triagem-15set-l10` no SHA `ca13073ea`, controle na `main`
`a0c88136a`; banco do `baseline.sql` em pg17, dona do `bootstrap-owner.ts`,
Atendente criada pela tela (convite › criar conta › confirmação por e-mail),
`next build` (exit 0 nas duas árvores) + `next start`, sem Google real, sem IA,
sem Resend. O Google da dona foi semeado por SQL, versionado ao lado das imagens.
Régua e medida de cada caso em `evidence/triagem-15set-l10/README.md`.

| # | Caso | Resultado |
|---|---|---|
| L10.1 | #882 — dia de folga (jornada até 23:00, São Paulo) não oferece horário no painel; o dia seguinte oferece 21:00 | **PROVADO EM TELA** — quinta 17: 0 horários, "Outro horário" aberto (encaixe por desenho); sexta 18: 30 horários com 21:00. **Não discrimina:** a `main` mostra o mesmo, porque o painel pede o mês a partir de agora e a data UTC de `de` já alcança a exceção. `evidence/triagem-15set-l10/882-02-quinta-17-folga-sem-horario.png`, `evidence/triagem-15set-l10/882-03-sexta-18-controle-oferece-21h.png` |
| L10.1a | #882 — a dona abre o painel às 21:05 do próprio dia de folga (o caso que discrimina) | **PROVADO EM TELA** — `main`: 21:30, 22:00 e 22:30 oferecidos na quinta fechada; lote: 0. Relógio do navegador em 17/09 21:05 −03:00, GET com `de=2026-09-18T00:05Z`. `evidence/triagem-15set-l10/main-882-04-quinta-17-folga-aberto-as-2105.png`, `evidence/triagem-15set-l10/882-04-lote-quinta-17-folga-aberto-as-2105.png` |
| L10.2 | #883 — Atendente, na agenda da dona com evento do Google 10:00–11:00: 10:00 não é oferecido | **PROVADO EM TELA** — 10:00 e 10:30 fora da lista (contagem 0). Na `main`, a Atendente via os dois. `evidence/triagem-15set-l10/883-02-atendente-segunda-21-sem-10h.png`, `evidence/triagem-15set-l10/main-883-atendente-segunda-21-oferece-10h.png` |
| L10.2a | #883 — Atendente tenta "Outro horário" às 10:15 | **PROVADO EM TELA** — `422 agenda_horario_indisponivel`, frase legível acima do Confirmar, sem o título do evento. Na `main`: `201` e um compromisso nasce por cima do Google da dona. `evidence/triagem-15set-l10/883-02-atendente-encaixe-1015-recusado.png`, `evidence/triagem-15set-l10/main-883-atendente-encaixe-1015-marcado.png` |
| L10.2b | #883 — a dona recebe a mesma resposta | **PROVADO EM TELA** — 10:00 fora, encaixe 10:15 com o mesmo `422`. `evidence/triagem-15set-l10/883-03-dona-encaixe-1015-recusado.png` |
| L10.3 | #892 — nenhum título do Google da dona aparece nas telas de agenda da Atendente | **PROVADO EM TELA** (texto e HTML, visões Semana, Dia e Mês). Mas a grade dela também não desenha "Ocupado" e explica o bloco travado com "fora dos horários que você publicou". **Diagnóstico por API:** a REST entrega o título a qualquer membro da organização. `evidence/triagem-15set-l10/892-01-atendente-semana-20-26.png`, `evidence/triagem-15set-l10/892-03-atendente-grade-segunda-21-10h.png` |
| L10.4 | Regressão — encaixe livre como dona, e `/admin/meta` | **PROVADO EM TELA** — 11:15 → `201`, `user/ui`; `/admin/meta` `200` sem 5xx (aberta pela URL). `evidence/triagem-15set-l10/regr-01-dona-encaixe-1115-marcado.png`, `evidence/triagem-15set-l10/regr-02-admin-meta-carrega.png` |
| L10.5 | #883 — Google real (OAuth e sincronização), gerente, agente de IA | **NÃO MEDIDO** |

**Achados fora do lote, reportados e não consertados:** (1) para o papel `agent`,
`GET /api/v1/team` responde `403`: ao abrir a Agenda aparece "Você não tem
permissão para esta ação." e o painel diz que o compromisso é com "Você" enquanto
marca na agenda da dona — igual na `main`; (2) a semente da Agenda e `GET
/api/v1/agenda/agendamentos` ainda leem o Google pelo embed
`calendar_connections!inner`, que a RLS esconde da Atendente — a mesma causa do
#879 em leitores que o lote não tocou, e consertar é decidir o que ela pode ver
(#892).

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

**Por que P0:** para quem **não tem** o `scheduler` da VPS — hospedagem sem cron
de minuto, ou instalação em que o serviço não subiu; é o cenário inteiro do
runbook [`relogio-http.md`](../runbooks/relogio-http.md) — o
relógio externo não é conveniência: é o **único** motor do follow-up. E a falha
dele é silenciosa: os follow-ups não andam, ninguém recebe erro, e a instalação
parece saudável.

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
| J20.12 | Follow-up em cliente atual (não autorizado, gate allowlist) | NÃO enrola | **CÓDIGO** — `silence-sweep.ts` `loadSilentContactIds` consulta a regra compartilhada e pula `!permitidoPeloGate`; **E2E** — `tests/e2e/j20-elegibilidade-followup.spec.ts` (fluxo de silêncio publicado pela API + cron real: silencioso autorizado → nasce `followup_enrollments`; silencioso NÃO autorizado, mesmo canal → nenhum enrollment) |
| J20.13 | Reinício do worker com backlog de eventos pending | zero disparos: cada evento cujo inbound já foi superado vira `done` sem job | **UNIT** — `drain.test.ts` "evento superado por inbound mais recente" |
| J20.14 | Submissão antiga (fora do TTL) | NÃO reativa a IA sozinha | **UNIT** — `gate.test.ts` "submissão antiga (fora da janela)", `drain.test.ts` "autorização EXPIRADA" |
| J20.15 | Org SEM versão de agente publicada (caminho legado `ai-response-worker`), gate allowlist, contato não autorizado | IA NÃO responde por este caminho tampouco | **UNIT** — `ai-response-worker-elegibilidade.test.ts` (skip `nao_elegivel_para_ia` antes de ler mensagem/agente; fail-closed em erro de leitura) |
| J20.16 | Follow-up de TEXTO FIXO drenado inline (`enviarTextoFixoPendente`, sem worker), contato não autorizado | NÃO envia; job vira `done` | **UNIT** — `enviar-texto-fixo.test.ts` "conversa NÃO elegível" (+ fail-closed volta pra `pending`) |
| J20.17 | Cliente antigo irritado (gate allowlist, não autorizado) → worker de sentimento dispara `low_sentiment` | `triggerHandoff` NÃO dispara: sem "um humano vai te atender", sem mexer no estado da conversa | **UNIT** — `handoff-orchestrator-elegibilidade.test.ts` (`bloqueioPorAllowlist` e `conversa_silenciada` barram; fail-closed em erro) |
| J20.18 | Eu respondo o cliente à mão pelo meu WhatsApp numa conversa autorizada | IA para naquela conversa por um PRAZO (`PRAZO_DO_SILENCIO_MS`, 60 min) renovado a cada nova fala humana, SEM apagar `ai_authorized_at`; volta sozinha quando o prazo vence, ou antes por "devolver ao automático" | **UNIT** — `atendimento-manual.test.ts` (as duas pontas do prazo medidas pelo motor real `decidirElegibilidade`, renovação, e o que NUNCA encurta: `'infinity'` do handoff formal e janela mais longa) + `waha-ingest-atendimento-manual.test.ts` (via `dispatchWahaEvent` real; eco do próprio envio NÃO pausa) + guarda de fonte no Zernio + fiação em `handoff-fantasma-fiacao.test.ts`; **E2E** — `tests/e2e/j20-elegibilidade-atendimento-manual.spec.ts` (webhook `fromMe` genuíno → `bot_silenced_until` finito e futuro, nunca `'infinity'`, + rastro; `ai_authorized_at` intacto; 2ª mensagem RENOVA o prazo; tela mostra o selo; "devolver ao automático" solta a trava e a autorização continua) |
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

**Modo de teste do canal (issue #573):** Conexões › Configurar acesso da IA
agora expõe pré-go-live por lista de telefones e abertura ao público com
confirmação. Novos canais nascem em teste com lista vazia; os anteriores
preservam o gate. O pré-go-live NÃO aceita autorizações por origem como
substitutas da lista. Contrato em [pre-go-live-whatsapp](../specs/pre-go-live-whatsapp.md).

| # | Caso | Expectativa | Cobertura |
|---|---|---|---|
| J20.20 | Cadastrar testadores antes do primeiro contato | Só o telefone listado é elegível, mesmo que outro contato tenha autorização por origem | `tests/invariants/pre-go-live-canal.test.ts`, `gate.test.ts`, `consulta-supabase.test.ts`, `drain.test.ts` |
| J20.21 | Administrador salva, recarrega, remove, abre e volta ao teste | Lista persistente por canal, lista vazia bloqueia todos, abrir exige confirmação | `tests/e2e/pre-go-live-whatsapp.spec.ts`, auth e banco reais, desktop e móvel |
| J20.22 | Fechar o canal durante geração da resposta | Sink não envia automaticamente; resposta humana continua permitida | `tests/unit/messages-handler-desfechos.test.ts` |
| J20.23 | Remover testador com resposta pendente de reenvio | Watchdog relê a lista e falha a mensagem sem alcançar o transporte; erro de leitura também não envia | `tests/invariants/agent-watchdog.test.ts` com banco e receiver HTTP reais; `session-reconciler.test.ts` |

**Dívida restante:** o editor de `campanhas_whatsapp` e a ativação do allowlist
POR ORIGEM continuam por script/SQL (`scripts/ativar-gate-elegibilidade-ia.ts`).
O painel não converte silenciosamente esse modo legado em teste ou aberto.

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
`tests/e2e/vps-fresh-onboarding.spec.ts`. O argumento escrito aqui era que ninguém a
invocava, então um `expect()` novo ali seria asserção que nunca executa — aparência de
cobertura, pior que a ausência. **Esse argumento morreu:** o PR #983 pôs a spec na
`SPECS_PARTE_4` e ela roda no CI (confira em `.github/workflows/e2e.yml`, ou com
`grep -A4 'FORA_DO_CI:'` no mesmo arquivo, onde ela já não está).

O que sobrou, e é o motivo de a receita continuar existindo, é outro: o CI **não** faz a
instalação que estes casos medem. Ele aplica o `baseline.sql` e roda o
`scripts/bootstrap-owner.ts`, e nenhum job executa o `install.sh` respondendo `APP_NAME`
com o nome de um revendedor. Os cinco artefatos de marca que saem dali (aba, ícone, e-mail
de acesso, convite, endereço de suporte) não têm por onde ser observados numa rodada do
`e2e`. Enquanto isso valer, o artefato honesto é o procedimento — com os comandos exatos,
para que a execução seja repetível por outra pessoa e o resultado seja comparável.

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

**Complemento medido na Task2 (2026-09-05):** no SDK 2.112.4, o primeiro
subscribe pode emitir join antes de resolver a callback. O hook agora aguarda
o bootstrap da MESMA fonte e setAuth antes de criar o canal; a callback segue
renovando. Epoch/cancelamento impedem resposta tardia de contexto anterior.
A jornada de suporte em múltiplas abas exige todos os joins authenticated e
evento postgres_changes real antes de aceitar a atualização B. Nenhum EXECUTE
foi concedido a anon.

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

### O que a linha "NÃO COBERTO" acima custou: `text-accent-fg` (2026-09-10)

A tabela acima declara, desde 2026-08-26, que as telas internas de `/app` não
foram medidas — porque numa instalação fresca elas redirecionam para o
onboarding, e alcançá-las pede WAHA e chave de IA. **Um defeito morou exatamente
ali por duas semanas, e quem o encontrou foi uma clínica em produção.**

A classe `text-accent-fg` **nunca existiu**. O `@theme inline` faz a ponte com o
nome `--color-accent-foreground`; `--color-accent-fg` é o token do `:root`, e
token do `:root` não vira utilitário sozinho. Escrever `text-accent-fg` não é
erro — é NADA: a regra não é emitida, o elemento não recebe `color`, e o texto
herda a cor da página. Como a mesma `className` trazia `bg-accent`, que existe, o
resultado era fundo da marca com letra da página.

Medido no CSS que o dev server servia: `bg-accent` 24 vezes, `text-accent-fg`
**zero**. Numa instalação com marca escura (`#062b46`, cliente real) isso deu
escuro sobre escuro em 9 lugares de 6 arquivos — aba do histórico, dia de hoje na
grade, dia e horário escolhidos na marcação. Com a paleta Sage padrão o defeito
existia igual, só menos gritante, e por isso ninguém viu.

| caso | prioridade | estado |
|---|---|---|
| Toda classe de cor usada em componente corresponde a chave do `@theme inline` | `[P0]` | **PASS**, congelado em `tests/unit/tailwind-tokens.test.ts`. A guarda deriva a lista de proibidos do próprio CSS (token do `:root` sem ponte), não de lista digitada — no nascimento o conjunto era exatamente um: `accent-fg`. Sabotagem provada nas duas direções |
| A letra sobre `bg-accent` passa no contraste, nos dois temas, com marca de cliente | `[P0]` | **PASS** por medição de token: `#062b46` dá 14.57 no claro e 6.97 no escuro; a auditoria completa da marca deu **0 reprovas** em 18 + 26 pares |
| As telas internas de `/app` medidas na tela, em instalação com marca | `[P0]` | **CONTINUA NÃO COBERTO.** Este defeito foi achado por leitura de CSS e por print de usuário, não por sonda. A lacuna que o produziu segue aberta |

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

### [P0] Organizações: criar, convidar e alternar (comunidade 360)

- Porta: `TenantSwitcher` → **Gerenciar organizações**, inclusive com uma membership, somente platform admin.
- `organizacoes-criacao-convite-e-cache.spec.ts`: organização A única → formulário cria B e vínculo do criador → link copiável e validade sem Resend → inbox A→B→A com contatos distinguíveis e novo documento → responsável aceita convite e chega a B. Seeds exclusivos locais; nenhuma pessoa real recebe mensagem.
- Rodada de correção 1: navegador em produção verde; contatos verificados dentro de `[data-conversation-id]` (o banner de canal não vale como prova da lista). Evidência adicional da falha de troca registrada no relatório local da Task1.
- Recuperação após resposta perdida: três respostas reais pós-commit abortadas, novo clique conserva chave, ID e link; recibo legado forjado é ignorado pelo handler. Falha de rede na troca libera a guarda e mantém cookie, organização e inbox. Proteção do recibo (INSERT/UPDATE/DELETE/TRUNCATE e namespaces LGPD/MCP) coberta em `organizacoes-recibo-confiavel.test.ts`.
- Aceite preserva `invited_by`; replay não regrava papel ativo e convite anterior/legado não desfaz revogação. Prova no banco em `organizacoes-criacao-e-convite.test.ts`; resposta antiga em voo e troca de usuário cobertas em `organizacoes-cache-por-contexto.test.tsx`.
- Recuperação: falha de entrega mantém link; convite vencido pode ser reemitido em Equipe. Troca recusada mostra erro e mantém organização anterior. Onboarding conserva saída para outra organização (spec existente).
- Execução local em produção passou no commit `815f59ea`: criação, cópia real do link, aceite e A→B→A. Guarda de transição medida com `getBoundingClientRect`/`getComputedStyle`; sentinela confirma novo documento. Screenshots em `.superpowers/evidence/comunidade-360/` (`criacao-convite`, `transicao-para-A/B`, `inbox-volta-a`, `aceite-na-org-b`); comandos e limites em `.superpowers/sdd/comunidade-360/task-1-report.md`.


## Acompanhamento administrativo por sessão (Task2, 2026-09-05)

- [P0] Administração → organização B → acompanhamento full → dados B → editar contato → audit do ator real → sair → A sem cache antigo.
- [P0] Somente leitura B, inclusive administrador físico B: inbox navega sem marcar lida/enviar; API comum e administração recusam escrita.
- [P0] Expiração/revogação: nenhuma volta silenciosa a A; saída continua disponível após perder plataforma.
- Duas abas da mesma sessão acompanham início/fim e dados B/A; sessão distinta da mesma pessoa não recebe grant/contexto da observadora.
- [P0] B com onboarding incompleto abre shell com banner/saída em ambos os modos; acesso direto ao wizard retorna ao app, sem concluir setup.
- Receiver HTTP do transporte configurado confirma reconexão full (stop/create/start), readonly sem recepção e outra sessão operando A. Não é prova de envio de mensagem WhatsApp.
- Fonte de prova: `tests/e2e/suporte-temporario.spec.ts`, produção local: jornada ampliada passou em produção local (21,2 s), incluindo zero403 espontâneo, banner medido e screenshot sem toast residual.
- Achado visual: consulta auxiliar de automático exigia agent e gerava toast403 para viewer; hook passou a respeitar permissão efetiva e mantém dado desconhecido, sem ampliar RBAC.
- DB: `tests/invariants/suporte-temporario.test.ts` prova grant,TTL,MFA,restrições DML/RPC e callbacks; não confundir com a jornada frontend.


## Interface por membro e convite — comunidade 360

- [P0] Convite emitido pela tela com interface selecionada antes do aceite; sem serviço de e-mail o link permite entrar na home calculada. Replay do convite preserva ajuste posterior do administrador.
- [P1] Dois membros com mesmo papel veem apresentações diferentes. Outro administrador edita pela Equipe; evento real de Realtime atualiza a navegação sem logout nem perda de formulário aberto.
- [P1] Seleção apenas de destino hub-only mantém porta no desktop/mobile e resultados úteis no ⌘K; sino oculto não monta consulta. URL autorizada oculta continua acessível; endpoint privilegiado continua 403.
- Spec: `tests/e2e/interface-por-vinculo.spec.ts`; imagens/trace locais em `.superpowers/evidence/comunidade-360/`. Resultado executado e limitações ficam no report da Task3.


## Comunidade 360 — encerramento e memória (Task4)

Spec: `tests/e2e/encerramento-atendimento.spec.ts`. Banco Supabase aplicado pelo baseline, frontend de produção e receiver HTTP local. Execução final FIX3-r1: **2 casos passaram em 20,7s**, com traces persistentes em `.superpowers/evidence/comunidade-360/task4-browser-fix3-r1/` e screenshots carregadas inspecionadas.

| Caso | Prioridade | Prova |
|---|---|---|
| Fechar conversa preserva demanda e outro canal | P0 | UI Fechar, consulta estado e screenshot carregada |
| Registrar desfecho explicitamente | P0 | Formulário no painel vigente, revisão CAS |
| Novo inbound volta à fila com demanda nova | P0 | Ingestão persistida, fila, assumir e responder pelo composer |
| Memória mantém fatos e rotula histórico | P1 | Notas duráveis no painel; checkpoint/mensagens antigas fora do contexto corrente em teste DB |
| Trabalho antigo não envia após close/reopen | P0 | Tool e sink canônico contra receiver HTTP real; controle positivo do transporte |
| Concorrência e tenant | P0 | Invariantes DB: inbound simultâneo, CAS, dois tenants e merge com duas conexões |

Limite operacional: a revalidação acontece imediatamente antes do efeito. Um transporte que já aceitou a mensagem não é desfeito pelo encerramento posterior.


Task4 fix1 — `encerramento-atendimento.spec.ts` amplia a prova: formulário conserva seleção durante refetch; histórico de desfecho em ES; resposta a caso antigo registra aviso e referência preservados na Central, sem link cru e com zero envio extra (projeção autorizada de navegação pertence à Task5); silêncio usa mensagem persistida pelo PostgREST (legado/reabertura não autorizam, entrada nova vigente autoriza). Execução final passou; logs/evidência no relatório Task4. A corrida real close/refetch → conversa null → perda do formulário foi corrigida preservando draft e CAS capturada no painel. Troca real de contato/conversa descarta o draft; conflito exige Cancelar/reabrir. Browser aguarda atribuição efetiva (Atendente/Liberar, sem Sem responsável) antes de responder e também prova reabertura/fechamento manual.

Capturas selecionadas: `evidence/comunidade-360/task4-conversa-fechada-demanda-aberta.png`, `evidence/comunidade-360/task4-reaberto-respondido.png`, `evidence/comunidade-360/task4-caso-obsoleto-aviso.png` e `evidence/comunidade-360/task4-historico-es.png`.

### Comunidade 360 — Central de avisos com contexto (Task 5)

[P1] `tests/e2e/central-avisos-destino.spec.ts`: aviso de conversa → contexto real → F5 → Back ainda aberto → resolver → Resolvidos → reabrir; contato e referência removida; links sob RLS em `own`/`own_and_unassigned`, outro responsável e outro tenant; manager/admin/viewer e bearer sem sessão; destino autorizado mesmo oculto no menu; desktop/mobile com medidas e screenshot carregado. Executado em 2026-09-06: quatro cenários passaram no build de produção do QA isolado, incluindo clique que abre o dossiê do negócio no funil certo e mobile em espanhol. Provas selecionadas: `evidence/comunidade-360/task5-desktop.png` e `evidence/comunidade-360/task5-mobile.png`, com medidas JSON ao lado. Comandos, logs e limites em `.superpowers/sdd/comunidade-360/task-5-report.md`.

O link vem da projeção autenticada `lib/ai/inbox-destino.ts`; não muda o status do aviso. Modelos de canal abrem a área de templates de Conexões/Parceiro, e referências técnicas sem tela recebem orientação. O recorte humano do Radar passa a usar a RLS de lead/conversa na Task6, conforme contrato em `docs/architecture/ponte-agendamento-followup.md`.

## Comunidade 360 — Agenda, presença e recuperação (Task6)

Executado em 2026-09-06 no QA isolado, build de produção do produto `bfa2ab2f`, baseline fresco preservado e migrations até0224: **7 casos passaram em1,2min**, um worker e nenhum retry, na spec `tests/e2e/agenda-presenca-recuperacao.spec.ts` (basename registrado no CI). Originais e sete traces permanecem em `.superpowers/evidence/comunidade-360/task6-browser-r3/`; as duas rodadas anteriores não foram sobrescritas.

| Jornada | Prioridade | Prova executada |
|---|---|---|
| Inbox → compromisso → Central → detalhe antigo | P0 | Contato/conversa vinculados pela tela; cron abre aviso; snooze e presença humana com mensagem/ator persistidos |
| Datas PT/ES em navegador inglês/Honolulu | P1 | GET traz São Paulo; intervalo29/08 23h30→30/08 00h30 contrasta com29/08 16h30→17h30 do browser; seletor real troca idioma sem mudar instantes/autoria/revisão |
| Gestão configura prazos e falta recuperável | P0 | Configuração persistida; Faltou → evento pending → cron drain → done/recibo started → UI; replay conserva inscrição e inbound interrompe |
| Ausência de configuração e outro fluxo ativo | P0 | Impedimento terminal legível, sem começar recuperação tardia quando a vaga abre |
| Receiver com inline/daemon e interrupção no preparo | P0 | Nos dois sentidos, um recebimento e um avanço por intenção mesmo após callback indisponível; aquisição antiga não envia;1001 pendências antes do protetor não escondem proteção; PG/Supabase concordam e nenhum envio novo ocorre |
| Radar com RLS real | P0 | Lead fora do pool frio, demanda sem lead com conversa visível, own/own_and_unassigned e gestão/suporte; contagens respeitam acesso |
| Duas sessões e rascunho antigo | P0 | Outra sessão remarca; polling bloqueia cancelamento até descarte/revisão; confirmação atual cancela; cleanup termina sem erro |

Achado visual da primeira rodada: detalhe PT usava idioma/fuso do navegador. FIX4 usa idioma canônico e fuso existente do compromisso, incluindo dia final; três controles de draft/CAS permanecem. As seis capturas carregadas finais foram abertas pelo autor/controlador, e o controlador confirmou ausência de novo defeito no recorte. Painel desktop:384px dentro de viewport1280, scrollWidth=clientWidth=383; mobile:292,5px dentro de390, scrollWidth=clientWidth=292; visibility=visible em todas.

Evidências selecionadas, copiadas sem edição dos originais:

- Presença: `evidence/comunidade-360/task6-presenca-desktop.png` e `evidence/comunidade-360/task6-presenca-mobile.png`.
- Datas em português: `evidence/comunidade-360/task6-datas-pt-BR-desktop.png` e `evidence/comunidade-360/task6-datas-pt-BR-mobile.png`.
- Datas em espanhol: `evidence/comunidade-360/task6-datas-es-desktop.png` e `evidence/comunidade-360/task6-datas-es-mobile.png`.
- Medidas, origem e SHA256 das seis capturas: `evidence/comunidade-360/task6-medidas.json`.

Prova DB integral preservada:166 arquivos/1310 casos passaram, mais1expected fail/1skip, com INSTALL/UPDATE PG15 e teardown. Cobre desfecho/CAS/recibo privado, inbound fora de ordem, transação anterior à confirmação, loop/callback velho, retenção, lease/retry/aviso e isolamento/ACL. Nenhum SQL mudou no FIX4. Receiver HTTP é real e local; não prova pareamento/entrega de WhatsApp real, consentimento Google ou convite entregue. Logs e reconciliação em `.superpowers/sdd/comunidade-360/task-6-report.md`.

## Comunidade 360 — Seleção de agendas e reconciliação Google (Task7)

**Jornada executada:2casos PASS em25,0s,exit0**, output local `task7-browser-r2`, build de produção6726941e e Supabase55431/55432. `tests/e2e/agenda-google-sync.spec.ts` está registrada no CI. Usa sessão real do produto e receiver HTTP controlado, sem conta Google externa. O controlador abriu as nove capturas finais e medidas, sem novo achado visual; validação concluída, aguardando re-review FIX4/aprovação da Task7.

| Jornada | Prioridade | Resultado observado |
|---|---|---|
| Selecionar fontes e destino entre contas | P0 | PASS — salva pela tela e espera PATCH200/refetch; um destino na segunda conta, reader sem escrita. Cartão/10h bloqueados e12h disponível → fonte desmarcada → cartão some,10h abre confirmação e12h/cache permanecem; desktop/mobile medidos |
| Retentar publicação indisponível | P0 | PASS — botão do detalhe → RPC autenticada → mesma consulta de candidatos do cron contra PostgREST, após50 vínculos anonimizados → executor com receiver HTTP → sucesso visível |
| Horários divergentes | P0 | PASS — intenção local usa slot oferecido pela rota canônica; mudança remota gera comparação → escolha pela tela aplica horário Google e conserva título e tupla original, apesar da troca de destino; sem PATCH remoto adicional |

Capturas versionadas, sem edição e idênticas aos originais:

- Fonte ocupada: `evidence/comunidade-360/task7-fonte-ocupada-grade.png` e `evidence/comunidade-360/task7-fonte-ocupada-horarios.png` —12h enquadrado no painel.
- Seleção salva: `evidence/comunidade-360/task7-selecao.png` e `evidence/comunidade-360/task7-selecao-mobile.png`.
- Fonte retirada: `evidence/comunidade-360/task7-fonte-retirada-grade.png` e `evidence/comunidade-360/task7-fonte-retirada-horarios.png` —10h selecionado e12h preservado.
- Publicação e decisão: `evidence/comunidade-360/task7-publicado.png`, `evidence/comunidade-360/task7-conflito.png` e `evidence/comunidade-360/task7-resolvido-mobile.png`.

`evidence/comunidade-360/task7-medidas.json` registra origem, SHA256 e medidas das nove capturas, sem overflow horizontal. O controle12h tem altura44 e interseção integral com a viewport nos dois painéis. A r1 e seus dois diagnósticos de fixture/espera foram preservados, com reconciliação em `.superpowers/sdd/comunidade-360/task-7-report.md`; nenhuma assertion ou regra de produto foi relaxada para fechar a r2.

Gates de produto preservados: unit integral706arquivos/7622PASS+1expected fail; DB integral169arquivos/1348PASS+1expected fail+1skip, INSTALL/UPDATE PG15; typecheck/lint/cercas/build verdes. Claims, callbacks tardios, escrita aceita sem resposta, edição local concorrente, RSVP/412, cursor e redação são exercitados contra banco e receiver. FIX4 passou typecheck/lint da spec e browser no mesmo build. AfterAll e sonda0|0 confirmaram limpeza; app/receiver efêmeros encerrados.0224/0225 aplicadas e imutáveis no QA. Receiver local comprova transporte/estados; não comprova consentimento Google real, pareamento WhatsApp ou convite entregue.

## Comunidade 360 — Google Meet e entrega transacional (Task8)

Browser r3 passou **2 jornadas/30,0s**, appprodução3013, sessão e PostgREST reais no QA55431/55432, com receivers HTTP locais. Produto8539a815 e spec b73cc573. Root abriu e aprovou as nove capturas e suas medidas; os defeitos de consulta de telefone e destino da Central encontrados em r2 foram corrigidos e receberam regressões. Não se alega conta Google real, OAuth, convite externo ou entrega na rede WhatsApp.

| Caminho | Prioridade | Prova atual |
| --- | --- | --- |
| Link pendente, pronto, copiar/abrir e falha/retry | P0 | UI cria por slot oferecido, mostra pending sem URL, recebe ready do executor, expõe href válido e copia para clipboard real; failure/retry chega pela Central e preserva identidade Google |
| Autorização de entrega com destino visível | P0 | UI mostra Maria Meet antes do clique; consumer real entrega ao chat e à sessão da fixture, revision/request observados conferidos. SQL prova owner/ator/org/suporte/MFA negativos, sem ampliar o browser |
| Canal indisponível e replay | P0 | Consumer/gates/ledger/handler/adapter reais com SQL e receiver HTTP local; queued não significa sent; aceite anterior reconcilia mesmo após expirar/remover autorização de IA, sem HTTP novo, enquanto ausência de aceite continua bloqueada |
| Atendimento encerra/reabre | P0 | UI fecha; inbound canônico reabre MESMO UUID; novo clique cria outra intenção/job e segundo POST. Ledger accepted real e job done antigos permanecem byte-equivalentes em seus snapshots; fronteira original preserva no-op |
| Link solicitado por humano em conversa sob controle humano | P0 | UI autoriza e HTTP chega com assignee user, silêncio, force_human e allowlist preservados. Dois payloads medem texto, destinatário e sessão. Booking automático bloqueado e demais negativos seguem medidos em DB |
| Aquisição antiga/cancelamento/redação concorrente | P0 | Reclaim e cancelamento antes do sink barram POST; redação durante POST aceito impede callback reidratar link/prévia |
| Solicitação Google incerta | P0 | POST aceito sem resposta conserva requestId; GET reconhece recibo sem reconhecer remarcação ainda não enviada |
| Acesso LGPD aos novos dados | P0 | Coletor paginado com tenant/titular/referência validada; testes renderizam PDF real, extraem entregas/avisos em múltiplas páginas e preservam controlador/DPO, sem payload/claim/marca |

| Captura inspecionada | Evidência |
| --- | --- |
| Pending desktop | `evidence/comunidade-360/task8-pending-desktop.png` |
| Pending mobile | `evidence/comunidade-360/task8-pending-mobile.png` |
| Ready/copiar desktop | `evidence/comunidade-360/task8-ready-desktop.png` |
| Ready mobile | `evidence/comunidade-360/task8-ready-mobile.png` |
| Envio concluído | `evidence/comunidade-360/task8-sent-desktop.png` |
| Nova autorização após reabrir | `evidence/comunidade-360/task8-reopened-mobile.png` |
| Falha desktop | `evidence/comunidade-360/task8-failure-desktop.png` |
| Falha mobile | `evidence/comunidade-360/task8-failure-mobile.png` |
| Retry concluído mobile | `evidence/comunidade-360/task8-retry-ready-mobile.png` |
| Prévia do PDF LGPD | `evidence/comunidade-360/task8-lgpd-export-preview.png` |

`evidence/comunidade-360/task8-medidas.json` contém origem, hashes e medidas reais. Seção Meet com335px no desktop1440 e243,5px no mobile390; sem overflow horizontal, controles na viewport. A aquisição do job no browser é SQL manual restrita à fixture: prova consumer/ledger/HTTP, não o scheduler completo. Incerteza, opt-out, revogação, claim antigo, cancelamento e redação durante HTTP permanecem nas provas DB/receiver; não são atribuídos às duas jornadas UI.

Testes: `tests/e2e/agenda-google-meet.spec.ts`, `tests/invariants/agenda-meet.test.ts`, `tests/invariants/agenda-meet-export.test.ts`, `tests/unit/agenda-meet*.test.ts*` e `tests/unit/lgpd-pdf-meet.test.ts`. Unit integral710arquivos/7671PASS+1expectedfail; DB integral171arquivos/1386PASS+1expectedfail+1skip, INSTALL/UPDATE PG15. Após o reparo runtime,75casos focados/type/lint e novo build/browser passaram; sem repetição do DB sem delta SQL.0226 aplicada/imutável no QA, junto com0224/0225. Limpeza0organizações/0usuários meet-ui, app/receivers/pools encerrados e namespace demo preservado. Histórico e limites completos em `.superpowers/sdd/comunidade-360/task-8-report.md`.

### Autonomia e revisão de respostas (Task9)

- [P0] Agente sem publicação: salvar versão, testar cenário e ver candidata/propostas sem mensagem operacional. Mesmo ritual de abertura, compactação e fechamento; provedor controlado deve ser identificado como tal.
- [P0] Recuperação do agente legado: escolher canal/modelo/credencial explicitamente; preservar prompt/RAG e qualquer versão humana existente. Falta de configuração mostra reparo, nunca “no ar”.
- [P1] Assistido: inbound gera sugestão; editar/aprovar/rejeitar na conversa. Aprovação autoriza só texto e preserva autonomia/assignment/silêncio; mudanças de contexto tornam a sugestão obsoleta.
- [P1] Pausar e retomar: ponteiro publicado permanece; assistência manual continua. Troca de modo em voo impede efeitos automáticos obsoletos.
- Provas Task9 em preparação: `tests/invariants/autonomia-replies.test.ts`, `lib/agent-engine/agent/preview.test.ts`. Evidência browser será registrada após revisão e aplicação da migration0227 no QA.

## J25 — Instalar e usar uma extensão declarativa publicada após o build `[P0]`

Specs: `tests/e2e/extensoes-declarativas.spec.ts` e `tests/e2e/extensoes-recuperacao.spec.ts`.
Estado: **as duas passaram inteiras em 16/09/2026**, sobre o build `mpuyz81eEv5s9QLf96iqr` gerado do
commit `2bce4b7ec` — a branch já integrada com a `main` —, a principal em 39,1 s e a de recuperação em
16,6 s, rodando sozinhas depois de duas tentativas mortas por ambiente (a fixture recebeu
`Processing this request timed out` com a máquina em load 53; depois o servidor de teste foi morto
com 0,06 GB livres). A primeira vez que passaram inteiras foi em 15/09, sobre o build
`ALAqeLI0VQJi4bpWWFbUL` do commit `5a19ce8fa`. Foram sete
rodadas até lá: quatro defeitos da própria prova (espera por URL que a aba já tinha, seletor
`data-slot` que o Card do repositório não tem, clique no cabeçalho rolado para fora da vista, prazo
de 5 s em asserções que dependem de duas idas ao servidor) e um defeito de produto que só ela achou
(a aba original não recarregava depois que outra aba reconciliava o recibo). Entre `5a19ce8fa` e o
HEAD, `git diff --stat b4b186219..HEAD -- app lib components` só mostra arquivos de voz vindos da
`main`, um comentário e as frases de voz no dicionário — nada do caminho das extensões. A fixture
recusa credenciais fora das portas locais dedicadas, cria usuários e organizações exclusivos,
publica dois pacotes pelo CLI depois de encontrar `.next/BUILD_ID` e inicia o catálogo HTTP real em
`127.0.0.1:56331`, com SQLite e PID próprios.

| Caso | Prioridade | Prova prevista |
|---|---|---|
| Admitir arquivo revisado e instalar pela UI | P0 | Catálogo exportado pelo CLI; origem, revisão, SHA-256, instante e bytes conferidos no SQLite, no HTTP e no banco do CRM |
| Resposta da instalação perdida depois do commit | P0 | `route.fetch()` completa a rota real e só a resposta ao navegador é abortada; o recibo local reconcilia uma única instalação persistida |
| Pacote alterado após exportar o catálogo | P0 | O SQLite troca um byte depois da exportação e antes da admissão pela UI, preservando o tamanho; o HTTP entrega SHA divergente do arquivo admitido, o recibo guarda `extension_digest_mismatch` e nenhuma instalação nasce |
| Storage indisponível antes do pedido | P0 | Falha restrita ao namespace dos recibos bloqueia a UI antes de qualquer POST ou nova operação; após restaurar o Storage e recarregar, a instalação volta a estar disponível |
| Resposta perdida reconciliada em outra aba | P0 | O UUID aparece no namespace ator+organização antes do fetch; outra aba lê a conclusão e remove o mesmo recibo, com um único POST e uma instalação |
| Cancelar durante download real | P0 | A segunda aba vê o recibo `preparing` e cancela enquanto metade do corpo continua aberta; a entrega tardia termina como `cancelled` e não publica instalação |
| Socket interrompido | P0 | O receiver entrega parte dos bytes publicados e encerra o socket; a UI mostra falha e próxima tentativa, o recibo guarda `extension_download_failed` e nenhuma instalação nasce |
| Configurar e ativar somente na organização A | P0 | Densidade compacta e descrição oculta persistem; B não recebe vínculo, card ou acesso direto ao guia |
| Troca concorrente entre abas | P0 | Uma aba carregada em A envia a organização esperada; após outra aba trocar a sessão para B, o salvamento recebe 409, recarrega o contexto e não cria vínculo em B nem altera A |
| Usar o guia até o núcleo | P0 | Card do hub CRM abre o guia; Enter no botão revalidado abre Tarefas; tarefa criada e concluída pela UI pertence somente a A |
| Desativar, revalidar aba antiga e reativar | P0 | URL e ação já abertas passam a recusar; reativação preserva a configuração anterior |
| Trocar A/B pelo seletor e desligar o catálogo | P0 | `tenant-switcher-item-<id>` muda o contexto; conteúdo instalado continua vindo do banco local com o catálogo indisponível |
| Papéis sem gestão | P0 | `agent` e `viewer` veem a tela sem controles de mutação; POST/PUT diretos respondem 403 sem criar operação |
| Desktop, móvel e teclado | P1 | Capturas em `.superpowers/evidence/extensoes-integracao/e2e/`, viewport móvel de 390 px, sem overflow horizontal nem erro de console; trace ligado |
| Tema escuro e espanhol | P1 | Controles reais mudam tema e idioma; tela em espanhol mantém o aviso explícito quando um texto do pacote usa fallback português, sem overflow; capturas complementares ficam em `e2e/recuperacao/` |
| Auditoria visível | P0 | Banco identifica ator e organização nas ações `extension.*`; `/admin/audit` filtra pelos controles canônicos e mostra `extension.configured` |

Limite declarado: esta jornada prova o perfil declarativo e o catálogo local de ensaio. Não prova
marketplace público, autoria criptográfica nem execução de código de pacote. Atualizar, desfazer,
remover e reinstalar são o J26, abaixo. A escrita SQL direta sob RLS pertence à suíte de
invariantes de banco desta integração.


## J26 — Atualizar, desfazer a última troca, remover e reinstalar uma extensão `[P0]`

Spec: `tests/e2e/extensoes-versao.spec.ts`. Fixture: `criarCatalogoDeVersoes` em
`tests/e2e/fixtures/catalogo-extensoes.ts`, que publica a MESMA identidade em 1.0.0 e 1.1.0 depois
de encontrar `.next/BUILD_ID`, serve pelo processo HTTP real em `127.0.0.1:56331` e sabe desligar e
religar o catálogo no meio da jornada. Evidência: `evidence/extensoes/versao/` (oito capturas e o
catálogo daquela rodada).

Estado: **passou inteira em 16/09/2026**, em 28,3 s, sobre o build `mpuyz81eEv5s9QLf96iqr` (do
commit `2bce4b7ec`, a branch já integrada com a `main`), na mesma rodada das duas specs do J25. As
capturas abaixo são dessa rodada. Antes dela: seis rodadas até a primeira vez inteira (sobre o build
`FL9GZvWqPoj8aE9XSY2E_`, commit `213dee0d4`), cujos defeitos da própria prova estão listados abaixo,
e duas repetições mortas por ambiente — uma na fixture com a máquina em load 53, outra com o servidor
de teste morto por falta de memória.

| Caso | Prioridade | Prova |
|---|---|---|
| Admitir o catálogo com as duas versões e instalar a 1.0.0 | P0 | O catálogo oferece "Instalar versão revisada" para a 1.0.0 e "Atualizar para 1.1.0" para a mesma identidade, nunca uma segunda instalação; banco com revisão 1 e sem anterior |
| Ativar em A; B sem nada | P0 | Vínculo de A ativo, revisão 1; B sem vínculo; o bloco "Em todas as organizações" diz "1 organização está com esta extensão ativa." |
| Atualizar para 1.1.0 | P0 | O diálogo diz "1 organização tem esta extensão ativa e continua com ela ativa" (`evidence/extensoes/versao/1-confirmar-atualizacao.png`); banco em 1.1.0, revisão 2, com anterior; o vínculo de A segue ativo e com a mesma revisão; o guia de A mostra o card novo da 1.1.0 e o card estável (`evidence/extensoes/versao/2-guia-na-1.1.0.png`) |
| Desfazer com o catálogo desligado | P0 | O processo do catálogo é encerrado antes; o diálogo nomeia a versão de destino e a contagem; banco volta à 1.0.0, revisão 3, sem nenhum download |
| Aba antiga recusada | P0 | Outra sessão aberta antes do desfazer ainda mostra "volta para 1.0.0"; ao confirmar, recebe "A extensão mudou em outra sessão" e recarrega para "volta para 1.1.0" (`evidence/extensoes/versao/3-aba-antiga-recusada.png`); o banco continua na revisão 3 |
| Remover | P0 | O diálogo diz "1 organização com ela ativa deixa de ver os guias agora" (`evidence/extensoes/versao/4-confirmar-remocao.png`); banco com `removed_at`, vínculo de A desligado com a marca da remoção; o guia aberto de A diz "removeu esta extensão de todas as organizações", sem "desativada nesta organização" e sem "Tentar novamente" (`evidence/extensoes/versao/5-guia-removido.png`); a gestão de A mostra "Removida"; a auditoria de A tem exatamente uma `extension.deactivated_by_removal` com `reason = installation_removed`, visível em `/app/audit` (`evidence/extensoes/versao/6-auditoria-da-organizacao.png`) |
| Religar o catálogo, reinstalar e reativar em A | P0 | O catálogo oferece "Reinstalar versão 1.0.0"; o diálogo diz "1 organização a usava e não volta a vê-la sozinha"; banco sem remoção e sem anterior, revisão 5, na MESMA instalação; o card de A diz "Estava ativa até ser removida… Ative de novo" (`evidence/extensoes/versao/7-reinstalada-por-ativar.png`); ativar apaga a marca |
| Atualização que falha no download | P0 | Com o catálogo desligado, o recibo desta identidade fica "Atualização · Falhou" com o motivo (`evidence/extensoes/versao/8-atualizacao-falhou.png`); banco com `extension_download_failed` e a instalação intacta; um `dispatched` do atualizador do core é aceito em seguida e encerrado na hora |

Defeitos da própria prova, medidos antes de mexer:

- página em segundo plano não anima no Chromium sem janela: depois de abrir o guia em outra página
  do mesmo contexto, o clique na gestão esperava "estável" para sempre;
- gravar o trace de uma jornada longa acontecia depois do corpo e estourava os 30 s globais: o
  contexto da aba antiga passou a fechar no próprio passo, e o arquivo tem prazo próprio;
- com a máquina em carga 100, o aviso de 4 s saía antes de o Playwright olhar: os avisos são
  registrados ao entrar na página e conferidos pelo texto;
- a Atividade recente lista recibos de rodadas anteriores, e um "Atualização · Falhou" antigo
  satisfazia o filtro antes de a falha desta rodada existir: os filtros exigem a identidade;
- com o Supabase sintético sobrecarregado (autenticação em 504, papel em 500), a gestão caía no
  estado "Tentar novamente" e a prova esperava uma aba que só volta com esse clique: ela agora
  clica como uma pessoa faria, registra cada nova tentativa como anotação e desiste depois de três.

Limite declarado: prova o perfil declarativo e o catálogo local de ensaio, com um só responsável
pela instalação. Não prova duas pessoas administrando a instalação ao mesmo tempo (pedido de outro
responsável, cancelamento cruzado); isso está nos testes de unidade da gestão e no invariante de
banco `tests/invariants/extensoes-declarativas.test.ts`.



## Comunidade 360 — aceite integrado de 2026-09-06

Produto `7f1d0f3e`, integrado à main `ca895850`: as dez specs de organizações, suporte, interface por vínculo, encerramento, Central, presença/recuperação, Calendar, Meet, autonomia assistida e roteamento passaram juntas: **22 casos em 3,7 minutos**. A execução usa build de produção `F0cVqvOg8JuwVlWss4ijk`, banco QA local e receivers HTTP controlados; não comprova OAuth externo, WhatsApp pareado ou qualidade de modelo externo.

Evidência local preservada em `.superpowers/evidence/comunidade-360/final-qa-targeted-r4/` e log `.superpowers/sdd/comunidade-360/final-qa-targeted-r4.log`. A rodada inclui atualização concorrente da interface sem perder formulário, sugestão obsoleta sem confirmação antiga de sucesso e encerramento de suporte com retorno ao contexto original.

Validação integral do mesmo produto: 733 arquivos unitários / 7.911 casos aprovados + 1 falha esperada; 184 arquivos de banco / 1.466 casos aprovados + 1 falha esperada e 1 ignorado, com INSTALL e UPDATE; tipos, lint (0 erros, 344 avisos) e build aprovados. `lint:channels`, validadores shell e conferência de release também passaram. Os checks remotos continuam sendo condição do merge pelo revisor da PR #613.

## J23 — Clientes pela agenda: o administrador liga, e quem tem horário vira cliente `[P1]` (2026-09-15)

Contribuição de @423313 (PR #867), com a decisão do dono: a regra nasce
**desligada** em toda organização, e só um administrador a liga, em
Configurações › Tipos de agendamento (migration 0262). A porta secundária é o
rodapé da tela de Funis, que diz onde ligar enquanto estiver desligada.

Spec: `tests/e2e/cliente-pela-agenda.spec.ts` (organização e admin próprios,
criados e apagados pela spec — ligar a regra na organização compartilhada do CI
etiquetaria os contatos das outras specs). Banco: `tests/invariants/cliente-nasce-do-agendamento.test.ts`.

| Caso | Prioridade | Resultado |
|---|---|---|
| J23.1 Marcar horário para um contato PELA AGENDA com a regra desligada: a lista de Contatos não mostra selo "Cliente", a célula Tags da linha não tem "cliente" e a ficha não tem o chip nem "Cliente desde" | `[P1]` | **PASS** — `evidence/cliente-pela-agenda/1-contatos-regra-desligada.png` |
| J23.2 Configurações › Tipos de agendamento (pelo hub) mostra "Desligado: …"; ligar abre a confirmação que diz que religar tira a etiqueta de quem ficou sem horário e que desligar não tira a etiqueta | `[P1]` | **PASS** — `evidence/cliente-pela-agenda/2-regra-desligada.png`, `evidence/cliente-pela-agenda/3-confirmacao.png` |
| J23.3 Confirmar: "1 contato ganhou a etiqueta “cliente”."; o interruptor fica `aria-checked=true`, habilitado e com opacidade 1 (medido por `getComputedStyle`) | `[P1]` | **PASS** — `evidence/cliente-pela-agenda/4-regra-ligada.png` |
| J23.4 Ligada: selo "Cliente" na lista, filtro "cliente" acha o contato, ficha mostra "Cliente desde" com a data do primeiro horário que conta — o dia em que se combinou, ou o dia do atendimento quando ele for mais antigo —, nunca uma data futura, Funis oferece "Funil de clientes" | `[P1]` | **PASS** — `evidence/cliente-pela-agenda/5-contatos-filtro-cliente.png`, `evidence/cliente-pela-agenda/6-ficha-cliente-desde.png` |
| J23.5 Marcar o funil de clientes, RECARREGAR: o selo "Clientes" e o botão "Deixar de ser funil de clientes" continuam | `[P1]` | **PASS** — `evidence/cliente-pela-agenda/7-funis-com-funil-de-clientes.png` |

Execução (2026-09-15): build de produção (`pnpm e2e:build`) da árvore
`f1fa08a19` + a spec, Supabase local próprio com o `baseline.sql` aplicado
(`ON_ERROR_STOP=1`, 0 erros), Chromium real, `next start`. 1 passed.

**Controle da spec:** com o trigger sabotado para ignorar o interruptor (no
banco do teste, restaurado depois), a spec reprova — em J23.3, e não em J23.1
como eu previra: o selo da lista é escondido pela própria regra desligada
(`ActiveOrg.cliente_pela_agenda`), então o contato etiquetado indevidamente só
aparece quando ligar diz "Nenhum contato tinha horário marcado ainda".

**Achado da própria spec, não do produto:** a primeira versão conferia o botão
de Funis com `toContainText`, que não exige visibilidade — passou com a tela
ainda no esqueleto do `loading.tsx` (o conteúdo chega num `<div hidden>` do
streaming), e a evidência capturada era o esqueleto. Agora a spec espera
`toBeVisible` antes do texto. Uma rodada caiu por 504 do GoTrue local sob carga
da máquina (`AuthRetryableFetchError`, média de carga 24); a seguinte passou sem
nenhum 504.

O que a tela NÃO prova, e onde está provado: cancelado e falta não contam, a
etiqueta tirada à mão não volta, o `contact.tag_added` no formato do app, a
classificação do histórico só da organização que liga e sem evento, e quem pode
ligar (admin, MFA, suporte) — todos no invariante acima, contra Postgres real.

**Rodada 2 (2026-09-15), sobre os achados da revisão.** Execução: build de
produção da árvore `88461bda5`, Supabase local próprio (project `fx867-e2e`,
portas 556xx) com o `baseline.sql` aplicado (`ON_ERROR_STOP=1`, 0 erros),
Chromium real, `next start` na 3867. 1 passed (23s). A evidência 6 agora mostra
"Criado em 15/09/2026 · Cliente desde 15/09/2026" — a da rodada 1 mostrava
"Cliente desde 21/09/2026", o dia do horário, que ainda não tinha chegado.

Controles, cada um com a previsão escrita antes:

- **E2E-S1** (o trigger ignora o interruptor, no banco do teste, restaurado
  depois): reprova no **J23.1**, na célula Tags (`toHaveCount(0)`, recebido 1).
  Na rodada 1 esse passo não reprovava, porque só olhava o selo que a tela
  esconde por `ActiveOrg`.
- **E2E-S2** (`/app/kanban` sem `is_client_pipeline` no select, build
  refeito): reprova no **J23.5**, depois do reload ("Funil de clientes" onde
  devia estar "Deixar de ser funil de clientes"). Sem o reload, passava.

Duas rodadas caíram antes da verde por carga da máquina (média 25–42, de outras
sessões): um 502 do Kong em `fn_support_context` (`recv() failed (104:
Connection reset by peer)` do PostgREST), que a rota do funil devolve como 503
`upstream_unavailable`, e 504 do GoTrue em `/auth/v1/user`. Nenhuma das duas
falhas tocou código desta feature; a terceira rodada, com a carga em 12, passou.

**Rodada 3 (2026-09-15), sobre os achados da segunda revisão.** Três defeitos
achados executando, nenhum deles alcançável pela spec atual — e é isso que os
torna interessantes de registrar aqui:

- **A frase da tela sobre a agenda que só tem cancelamento.** Organização cujo
  único contato TEM horário marcado, todos cancelados: o corpo da RPC era
  `{ganharam: 0, perderam: 0, clientes: 0}` — três números idênticos aos de uma
  agenda vazia — e a tela dizia "Nenhum contato tinha horário marcado ainda".
  Numa clínica com cancelamentos é a primeira frase depois de ligar. Provado e
  guardado em `components/agenda/ClientePelaAgenda.test.tsx` (o corpo agora tem
  um quarto número) e no invariante I38. **A spec não alcança**: ela monta uma
  organização com um horário que CONTA, e montar a agenda só de cancelamento
  seria uma segunda organização inteira pela tela.
- **A etiqueta que a equipe repõe à mão.** O sistema a tirava no cancelamento
  seguinte, porque o dono só era reconciliado quando a data mudava. Invariante
  I34 (e I34b, o par). **A spec não alcança**: são quatro edições de etiqueta
  pela tela de Contatos, com um cancelamento no meio.
- **As três colunas gravadas por sessão.** Um `viewer` da própria organização
  gravava `first_service_at = '2019-01-01'` com `UPDATE 1`. Invariante I36 (e
  I37, o par). **A spec não alcança**: nenhuma tela oferece essa escrita — o
  caminho é a API/PostgREST, e o que a fecha é um trigger.

Não houve rodada nova de Playwright nesta rodada 3: nenhuma das três mudanças de
comportamento é alcançável pela jornada da spec, e a única mudança de TEXTO na
tela (a frase nova e a das automações) é medida pelo teste de componente. O que
a rodada 2 provou pela tela continua valendo — a árvore mudou o corpo da RPC,
não o caminho que a spec percorre.

## Lote 11 da triagem, em ambiente fresco estilo VPS (2026-09-15)

QA visual da integração `integracao/triagem-15set-l11` no SHA `d82366250`: os PRs
**#867** ("clientes pela agenda", @423313) e **#897** (o título do compromisso
pessoal do Google sai do alcance do colega, @webtecnica — issue #892). Provas e
receita completa do ambiente em `evidence/triagem-15set-l11/README.md`.

Ambiente: Supabase local pg **17.6** próprio (`qa-l11`, portas 6132x) montado **só
pelo `supabase/baseline.sql`** (`ON_ERROR_STOP=1`, exit 0), chave de cifra semeada
como o kit faz, dona por `scripts/bootstrap-owner.ts`, **onboarding concluído pela
tela**, `pnpm e2e:build` exit 0 (399 s) + `next start`, e **os envs opcionais
ausentes** — sem Resend, sem Google, sem chave de IA, sem Redis. Chromium real em
`America/Sao_Paulo`/`pt-BR`.

Esta rodada é complementar à J23 acima, que exercita a spec `cliente-pela-agenda`
numa organização própria: aqui o banco é o de uma **instalação recém-feita**, e o
que se mede é o que a spec não alcança — o caminho pela navegação, o ciclo
completo da automação com drenagem de cron de verdade, o papel `agent`, 400 px e
tema escuro, e a privacidade do #897 com dois logins distintos.

| Caso | Prioridade | Resultado |
|---|---|---|
| L11.1 O banco recém-instalado pelo baseline já traz as três colunas da 0262, os quatro gatilhos, as três funções, a view **sem** `title` e `has_column_privilege(authenticated, …, title, SELECT) = false` | `[P0]` | **PASS** — tabela no README |
| L11.2 `organizations.settings` de uma organização nova **não tem** `crm.cliente_pela_agenda`: a regra nasce desligada | `[P0]` | **PASS** |
| L11.3 Com a regra desligada, marcar horário pela Agenda para um contato não dá etiqueta, não dá "Cliente desde" e não escreve `first_service_at` | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-01-marcado-com-a-regra-desligada.png`, `evidence/triagem-15set-l11/867-02-ficha-sem-etiqueta-regra-desligada.png` |
| L11.4 Chegar ao interruptor **pela navegação**: barra lateral › Configurações › SUA EMPRESA › Tipos de agendamento | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-04-hub-de-configuracoes-tipos-de-agendamento.png`, `evidence/triagem-15set-l11/867-05-interruptor-nasce-desligado.png` |
| L11.5 Ligar como admin: confirmação antes, "2 contatos ganharam a etiqueta"; quem tinha horário que conta ganha etiqueta e "Cliente desde"; **quem só tinha horário cancelado não ganha** | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-06-confirmacao-antes-de-ligar.png`, `evidence/triagem-15set-l11/867-07-ligado-com-o-resultado.png`, `evidence/triagem-15set-l11/867-08-ficha-marina-cliente-desde.png`, `evidence/triagem-15set-l11/867-09-ficha-bruno-so-cancelado-sem-etiqueta.png` |
| L11.6 A equipe tira a etiqueta à mão e marca **outro** horário: a etiqueta não volta (`client_tag_by_system` vai a `null` e fica) | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-21-tirando-a-etiqueta-a-mao.png`, `evidence/triagem-15set-l11/867-22-helena-sem-a-etiqueta.png`, `evidence/triagem-15set-l11/867-23-a-etiqueta-nao-volta.png` |
| L11.7 Automação criada **pela tela** ("quando um contato ganhar a tag `cliente`, adicionar `recepcao-de-cliente`"), primeiro horário de um contato novo, **drenagem pelo endpoint de cron com o segredo** (`scanned 7, done 7`): a automação executa, aparece no histórico e o efeito chega à ficha | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-14-automacao-quando-ganhar-a-etiqueta.png`, `evidence/triagem-15set-l11/867-16-automacao-ligada.png`, `evidence/triagem-15set-l11/867-19-historico-da-automacao.png`, `evidence/triagem-15set-l11/867-18-diego-com-a-etiqueta-da-automacao.png` |
| L11.8 Desligar não tira etiqueta de ninguém (tabela idêntica antes/depois, sem diálogo); religar não repõe a que a equipe tirou | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-27-desligado-ninguem-perde-a-etiqueta.png`, `evidence/triagem-15set-l11/867-28-religado-a-etiqueta-tirada-a-mao-nao-volta.png` |
| L11.9 `agent` vê a seção mas o interruptor está **desabilitado**, com "Só um administrador pode mudar essa regra."; clique forçado não muda o banco | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-25-atendente-nao-liga-o-interruptor.png` |
| L11.10 A tela do interruptor em **400 px, tema escuro**: `scrollWidth` 400 = `clientWidth` 400, 0 elementos fora da tela | `[P2]` | **PASS** — `evidence/triagem-15set-l11/867-26-interruptor-400px-tema-escuro.png` |
| L11.11 **#897** Atendente criada 100% pela tela (convite › link copiável sem Resend › criar conta › confirmação na caixa local › Inbox) | `[P0]` | **PASS** — `evidence/triagem-15set-l11/897-02-link-do-convite-na-tela.png`, `evidence/triagem-15set-l11/897-06-atendente-dentro-do-sistema.png` |
| L11.12 **#897** Nenhuma tela da Atendente mostra o título do compromisso pessoal da dona — varrido em `innerText` **e** no `outerHTML` inteiro, nas visões Semana, Dia, Mês, na semana do evento e no painel de marcar | `[P0]` | **PASS** — `evidence/triagem-15set-l11/897-07-atendente-agenda-semana.png`, `evidence/triagem-15set-l11/897-08-atendente-semana-do-evento.png`, `evidence/triagem-15set-l11/897-09-atendente-segunda-21-sem-as-10h.png` |
| L11.13 **#897** Pela REST com o token de sessão da Atendente: `title` na tabela → `42501`; `title` na view → `42703`; `select=*` na view → a linha sem título. **Controle positivo**: a chave de serviço lê o título | `[P0]` | **PASS** — tabela no README |
| L11.14 **#897** Para a dona nada quebrou: 1 bloco "Ocupado" na semana, GET com `titulo: "Ocupado"`, painel sem 10:00/10:30 — e ela também não alcança o `title` | `[P1]` | **PASS** — `evidence/triagem-15set-l11/897-11-dona-semana-do-evento.png`, `evidence/triagem-15set-l11/897-12-dona-segunda-21-sem-as-10h.png` |
| L11.15 Regressão do lote 10: a Atendente não recebe 10:00/10:30 e o encaixe 10:15 é recusado com `422 agenda_horario_indisponivel`, sem citar o título | `[P1]` | **PASS** — `evidence/triagem-15set-l11/897-10-atendente-encaixe-1015-recusado.png` |
| L11.16 Regressão: "Outro horário" num encaixe livre (`201`, "Marcado.") e `/admin/meta` abre (`200`) | `[P2]` | **PASS** — `evidence/triagem-15set-l11/regr-01-encaixe-1515-marcado.png`, `evidence/triagem-15set-l11/regr-02-admin-meta-carrega.png` |

**Nenhum defeito no código do lote.** Dois achados anteriores a ele, com o detalhe
e as medidas no README:

1. O contato criado de dentro do painel de marcar leva alguns segundos para
   aparecer em "Quem será atendido", e nesse intervalo a tela exibe
   "Compromisso pessoal, sem cliente" **sem indicação de carregamento** — uma
   escolha de negócio legítima, mostrada como se fosse a escolhida. Medido: ~4 s
   com a máquina carregada, menos de 1,5 s com ela saudável, e **não consegui
   produzir um agendamento sem cliente** quando o ambiente estava saudável. O que
   está medido é o estado EXIBIDO, não um desfecho errado.
   `components/agenda/VinculoDaMarcacao.tsx`, não tocado pelo lote.
2. Todo agendamento emite `crm.activity_write_failed` com
   `origem: "agenda (sem negócio aberto para ancorar)"` — contato criado direto na
   Agenda não tem negócio para ancorar a atividade de timeline. Aparece também com
   a regra desligada, então é independente do #867.

**Duas armadilhas de ambiente**, para quem repetir: `supabase start` derruba o
stack inteiro (exit **137**, que lê como OOM e não é) quando um contêiner falha o
healthcheck, levando junto o `psql` do baseline — o log do CLI é que diz
`container is not ready: unhealthy`; e um Realtime unhealthy varrendo o WAL levou o
Postgres a `57014 statement timeout` e o GoTrue a `504`. **O Realtime não foi
exercitado nesta rodada.**

---

## J24 — O vocabulário de etiquetas da organização `[P1]` (2026-09-15)

Tela nova de Configurações › Tags (PR #955, issue #852 fatia S4): a lista das
etiquetas com o peso de cada uma e as três operações — renomear, juntar, excluir.

**As três ações são irreversíveis na prática** (não há desfazer) e uma delas é
destrutiva. Registrado aqui porque a tela foi para o lote **sem ninguém ter
clicado nos botões uma vez**: o autor declara no PR "a tela não foi aberta em
navegador nem coberta por Playwright", e o aceite da própria issue #852 pedia
Playwright.

Regra no banco: `tests/invariants/tags-vocabulario.test.ts` (`pnpm test:db`).
Contrato da rota, sem banco: `tests/unit/tags-vocabulario-rota.test.ts`.

| # | Caso | Resultado |
|---|---|---|
| J24.1 | Renomear uma etiqueta que está numa regra de automação de DOIS tipos de ação deixa a regra com as duas | **PASS por invariante** (`renomear preserva TODAS as ações da regra`). Era o defeito BLOQUEADOR achado na triagem: o `group by (regra, tipo)` truncava a regra ao subconjunto de um tipo, em toda organização, mesmo numa regra que nunca citou a etiqueta. Medido num Postgres real antes do conserto: regra com `add_tag` + `assign_owner` ficava com 1 ação |
| J24.2 | Juntar duas etiquetas de chaves diferentes não deixa a etiqueta repetida no array | **PASS por invariante** (`juntar duas etiquetas de chaves DIFERENTES…`). Medido antes do conserto: `{VIP, obra}` juntando `obra` em `VIP` devolvia `{VIP, VIP}` — e a leitura conta OCORRÊNCIAS, então o registro passava a pesar 2 na tela que deveria arrumá-lo |
| J24.3 | A lista carrega com as contagens, pela tela | **NÃO COBERTO** — falta Playwright e evidência visual |
| J24.4 | Excluir mostra o aviso de quantas regras continuam escrevendo a etiqueta | **NÃO COBERTO pela tela** — a regra está no invariante (`excluir … NÃO apaga a regra`), o AVISO não foi visto por ninguém |
| J24.5 | Quem é `viewer`/`agent` não chega à tela | **PASS por leitura de código + invariante** (`viewer é recusado antes de qualquer escrita`). O atalho de platform admin saiu da página e da rota na triagem: `fn_role_at_least` não conhece platform admin, então a tela oferecia três botões que todos voltavam 403 |
| J24.6 | O painel em espanhol | **CORRIGIDO na triagem, sem prova de tela** — seis chamadas `t()` recebiam template literal com interpolação, que `traduzir()` nunca casa: o diálogo inteiro e os dois toasts saíam em português para quem escolheu espanhol, e o guarda de i18n não vê `TemplateExpression` |
## Lote 12 · G2 — Inbox: painel do contato e leads recentes (PRs #909, #944, #946)

**PENDENTE POR EXECUÇÃO — nenhuma linha desta seção foi provada em tela.** Ela
existe porque a lacuna é de FERRAMENTA, não de descuido: os consertos do grupo
estão medidos em jsdom e em dublê de banco, e um deles jsdom e dublê são
estruturalmente incapazes de alcançar.

| Caso | Prioridade | Estado |
|---|---|---|
| L12.G2.1 `GET /api/v1/contact-tags` responde **200** (e não um 400 de parse do PostgREST) numa organização com pelo menos um contato SEM tag e um COM tag. Abrir o painel do Inbox › "Tag" e conferir a resposta pelo DevTools; anexar em `evidence/` | `[P1]` | **NÃO MEDIDO** |
| L12.G2.2 O rótulo "Novo Lead" cabe na fileira de botões do painel (`flex flex-wrap gap-2`, `components/inbox/CRMSidePanel.tsx`) sem quebrar a fileira nem sumir, em 400 px e no tema escuro | `[P2]` | **PARCIAL** — a PRESENÇA do botão está inscrita em `tests/e2e/encerramento-atendimento.spec.ts` (`SPECS_PARTE_3`), que o CI roda a cada PR; o ENCAIXE em 400 px continua sem medida |
| L12.G2.3 A linha "Funil · Etapa" com nome longo de funil: medir `getBoundingClientRect().width` contra `scrollWidth` do `div.line-clamp-2`, e o mesmo em celular, onde não há hover para o `title` | `[P2]` | **NÃO MEDIDO** |

**Por que L12.G2.1 não tem substituto unitário.** `app/api/v1/contact-tags/route.ts`
filtra com `.neq("tags", "{}")` sobre uma coluna `text[]`, e quem decide se essa
sintaxe é aceita é o PostgREST — não o Postgres, e muito menos o dublê de
`tests/unit/tags-do-contato-rota.test.ts`, que trata `"{}"` como caso especial
escrito à mão. Um dublê não pode reprovar uma sintaxe que ele mesmo define. É a
ÚNICA `.neq()` sobre coluna de array no repositório; para conferir em vez de
acreditar nesta linha (o número envelhece, o comando não):

```bash
grep -rn '\.neq(' app lib workers --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.' | grep -v ': *//' | sed 's/.*\.neq(/.neq(/'
```

O repositório já pagou o preço de um dublê de `.neq()` que no-opava: está
escrito, com o desfecho em produção, no comentário de `upsertConversation`, em `lib/channels/zernio/ingest.ts`.

A favor de a sintaxe estar certa, e é o que sustenta `[P1]` em vez de `[P0]`: o
schema não deixa NULL na coluna (`supabase/baseline.sql:1343`, tabela
`contacts` — `"tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL`), então não há o
terceiro valor que fez o `<>` do zernio devolver desconhecido. E o desfecho de
falha é contido: a rota alimenta SUGESTÃO de tag, e o editor segue gravando o
que se digita.

---

## Lote 12 · QA visual em tela — 16/set/2026 `[P0]` (funil) / `[P1]` (resto)

Prova em tela de dezesseis PRs, no SHA `778d1dcb2` da
`integracao/triagem-15set-l12`, em banco montado **só pelo `supabase/baseline.sql`**
num Supabase pg17 próprio, com **WhatsApp, IA, Resend, Google e Redis ausentes** —
o estado de um primeiro deploy. Evidência, medições e ressalvas de ambiente em
`evidence/triagem-16set-l12/README.md`; as specs desta sessão são
`tests/e2e/qa-l12-*.spec.ts`.

**O que esta seção NÃO é.** Nenhuma spec daqui está em `SPECS_PARTE_*` do
`e2e.yml`: são o instrumento de UMA sessão de QA, não um gate. O que vigia cada
conserto a cada PR continua sendo o teste de unidade/invariante que o próprio
grupo trouxe.

| # | Caso | Resultado |
|---|---|---|
| L12.QA.1 | **#938** · a janela de perder oferece os motivos DO FUNIL e grava o escolhido | **PASS pela tela** — os `value` dos rádios são `["Sem orçamento","Fora do perfil","other"]` num funil que cadastrou os dois primeiros; "Falha no pagamento" tem contagem 0; `POST /lose` = 200 e o banco grava `lost_reason="Sem orçamento"`. Evidência: `evidence/triagem-16set-l12/938-01-menu-motivos-do-funil.png`, `evidence/triagem-16set-l12/938-02-menu-card-perdido.png` |
| L12.QA.2 | **#938** · "Outro" com e sem detalhe | **PASS pela tela** — com texto fora da lista, `role="alert"` e `Confirmar` desabilitado ANTES do clique; sem detalhe, `Confirmar` habilitado, `POST` = 200 e `lost_reason="other"`. Evidência: `evidence/triagem-16set-l12/938-03-outro-texto-recusado.png`, `evidence/triagem-16set-l12/938-04-outro-vazio-gravado.png` |
| L12.QA.3 | **#935** · os TRÊS caminhos para a etapa de perda | **PASS pela tela** — menu grava; **arrasto** (teclado do `@hello-pangea/dnd`, mesmo `onDragEnd` do mouse) responde **422 `lost_reason_required`**, o card volta e o banco fica intacto; **lote** responde 422 **nomeando os dois cards** em `details.lead_ids`. Evidência: `evidence/triagem-16set-l12/935-05-arrasto-recusado-com-aviso.png`, `evidence/triagem-16set-l12/935-06-lote-dois-selecionados.png`, `evidence/triagem-16set-l12/935-07-lote-recusado.png` |
| L12.QA.4 | ⚠️ **#935** · a recusa diz o QUE FAZER? | **FALHOU** — a tela mostra só *"Informe o motivo da perda."* (+ `ID: <requestId>`). O fragmento `.changes/etapa-de-perda-exige-motivo.md` promete a recusa *"com o que fazer"* e nomeia o caminho ("use 'Marcar como perdido' no menu do próprio card"); **esse complemento não está na tela**. **Consertado na integração** (`fix(leads): a recusa do arrasto para a perda diz a saída`): a recusa do arrasto e do lote passa a nomear “Marcar como perdido” no menu do card, a rota `/lose` (o próprio menu) mantém o texto curto, e um teste prende a frase ao rótulo real do menu. A prova de tela do conserto é esta mesma spec, `qa-l12-funil.spec.ts`, que agora afirma a saída e roda no `e2e` do CI |
| J4.41 | **#919** · arrastar o mesmo card duas vezes seguidas | **PASS pela tela, reexecutado aqui** — `tests/e2e/kanban-owner-filter.spec.ts`, com o refetch do quadro segurado em 15 s (sem isso o teste fica verde mesmo com o conserto revertido) |
| J4.38 | **#911** · excluir pelo menu do card, inclusive no toque | **PASS pela tela** — o menu traz "Excluir", o `AlertDialog` nomeia o card e diz que não dá para desfazer, o `POST` é `{"action":"delete",…}` = 200 e o banco devolve `[]`. Em 390×844 com `hasTouch` e **sem hover**, a opacidade COMPUTADA do botão é `1`. Evidência: `911-11`…`911-15` |
| J4.39 | **#948** · tag em lote oferece as tags que já existem | **PASS pela tela — o caso que faltava** — quadro com **13 tags distintas**, menu oferece **10** (o teto), e digitar `verão` com `vip` na lista deixa o campo com **`"verão"` inteiro**; o `Enter` envia `params.add=["verão"]` e a tag do MENU não vai para ninguém. Evidência: `948-08`…`948-10` |
| L12.QA.5 | **#936** · levar o negócio para outro funil | **PASS nos EFEITOS** — não há botão (o próprio fragmento declara "por enquanto pela API"). `POST /clone` = **201** do navegador logado; o clone chega ao destino com `custom_fields` inteiro (lido pelo `value` dos `<input>`, não pelo `innerText`), a linha do tempo dele diz "Veio de outro funil · Veio do funil X" e a origem fica `lost` com a atividade que nomeia o destino. Evidência: `936-01`…`936-04` |
| L12.QA.6 | ⚠️ **#936** · a recusa de fronteira fala com desenvolvedor | **REPORTADO com ressalva** — `"Move cross-pipeline não é permitido. Use POST /api/v1/leads/[id]/clone…"` num campo que o `ApiErrorToast` mostra cru. A `main` já tinha o jargão; o lote acrescentou o verbo HTTP e a rota. **Não alcancei pela tela**: o quadro só desenha as etapas de UM funil. Vira defeito de tela quando o botão da fatia seguinte chegar |
| J4.25 | **#941** · radar sem leads de funil arquivado | **PASS pela tela** — dois funis (ativo e arquivado) com lead aberto e frio no mesmo contato: o do ativo aparece, o do arquivado não. Evidência: `evidence/triagem-16set-l12/941-10-radar-sem-funil-arquivado.png` |
| L12.G2.1 | **#946** · `GET /api/v1/contact-tags` responde 200 | **PASS — era NÃO MEDIDO** — 200 com corpo, numa organização com contato SEM tag e contatos COM tag; a rota é pedida quando o editor monta, no clique em "Tag". A `.neq("tags","{}")` sobre `text[]` é aceita pelo PostgREST |
| L12.G2.2 | **#909/#944** · o painel cabe em 400 px, tema escuro | **PASS** — `documentElement.scrollWidth` 400 × `clientWidth` 400. Evidência: `evidence/triagem-16set-l12/g2-06-inbox-400px-escuro.png` |
| L12.G2.3 | **#944** · a linha "Funil · Etapa" com nome longo | **PASS** — `scrollWidth` 245 × `clientWidth` 245 no `div.line-clamp-2`, com nome de funil de 40+ caracteres |
| L12.QA.7 | **#909** · o botão tem o nome do diálogo que abre | **PASS pela tela** — botão "Novo Lead", título do diálogo "Novo Lead". Evidência: `evidence/triagem-16set-l12/909-01-painel-com-botao-novo-lead.png`, `evidence/triagem-16set-l12/909-02-dialogo-mesmo-nome.png` |
| L12.QA.8 | **#944** · "Leads recentes" diz Funil · Etapa e Ganho/Perdido | **PASS pela tela** — dois leads de mesmo título aparecem distintos pela etapa; o desfecho lê **"Ganho"** e "Pago" tem contagem 0, **apesar** de o `crm_pipelines.vocabulary` daquele funil dizer `{"won":"Pago"}` no banco no mesmo instante; o lead de funil arquivado não aparece. Evidência: `evidence/triagem-16set-l12/944-03-leads-recentes-funil-e-etapa.png` |
| L12.QA.9 | **#946** · sugestão de tags com caixa mista e duplicata | **PASS pela tela** — `"VIP"`, `"vip "` e `"vip"` em contatos diferentes colapsam num chip só, em minúscula; `+ vip` **não** é oferecido porque o contato já a tem (e a rota conhece `vip`, o que separa "não oferece" de "não existe"); clicar grava a forma normalizada. Evidência: `evidence/triagem-16set-l12/946-04-sugestao-de-tags.png`, `evidence/triagem-16set-l12/946-05-tag-gravada-normalizada.png` |
| J24.3 | **#955** · a lista carrega com as contagens, pela tela | **PASS — era NÃO COBERTO** — a porta está em `/app/settings` (link para `/app/settings/tags`), e a linha da etiqueta traz 2 contatos e 1 regra de agente, com os três botões. Evidência: `evidence/triagem-16set-l12/955-01-porta-em-configuracoes.png`, `evidence/triagem-16set-l12/955-02-lista-com-contagens.png` |
| J24.1 | **#955** · renomear preserva as ações da regra | **PASS pela tela** — 200, contatos renomeados **e** a regra de automação reescrita na mesma operação, com todas as ações. Evidência: `evidence/triagem-16set-l12/955-03-renomear-formulario.png`, `evidence/triagem-16set-l12/955-04-renomeada-na-tela.png` |
| J24.2 | **#955** · juntar não duplica a etiqueta | **PASS pela tela** — o contato que tinha as duas fica com a de destino **uma vez**. Evidência: `evidence/triagem-16set-l12/955-05-juntar-formulario.png`, `evidence/triagem-16set-l12/955-06-juntadas.png` |
| J24.4 | **#955** · excluir avisa quantas regras continuam escrevendo | **PASS — era NÃO COBERTO pela tela** — o aviso lido por ferramenta traz "Atenção: 1 regra(s) de agente continuam escrevendo esta etiqueta…", e depois do 200 a regra **continua no banco**. Evidência: `evidence/triagem-16set-l12/955-07-excluir-aviso-de-regras.png`, `evidence/triagem-16set-l12/955-08-excluida.png` |
| J24.5 | **#955** · viewer e agent não chegam à tela | **PASS pela tela** — os dois param em `/403`, e a porta em `/app/settings` tem contagem **0** para ambos. Evidência: `evidence/triagem-16set-l12/955-09-viewer-recusado.png`, `evidence/triagem-16set-l12/955-09-agent-recusado.png` |
| J24.6 | **#955** · o painel em espanhol | **NÃO MEDIDO nesta sessão** — segue preso por `tests/unit/tags-vocabulario-painel-em-espanhol.test.tsx` |
| L12.QA.10 | **#955** · o aviso de teto com ≥500 etiquetas | **NÃO MEDIDO** — semear 500 etiquetas mede o `limit 500` da função, não o conserto do lote |
| J16.8 | **#931/#933** · a instalação SEM Google | **PASS pela tela** — nenhum botão "Conectar Google" (contagem 0) e o endereço de retorno impresso para registrar no console. Evidência: `evidence/triagem-16set-l12/931-01-agenda-sem-google.png` |
| J16.6 | **#933** · a URL com `prompt=consent select_account` | **NÃO MEDIDO nesta sessão** — exige `GOOGLE_CALENDAR_CLIENT_ID`/`SECRET`, e semeá-los mede a configuração, não o conserto. O `Location` de verdade segue preso por `tests/unit/agenda-google-connect-route.test.ts`. A dívida nº 1 do grupo G4 (ninguém abriu a tela do Google com duas contas) **continua de pé** |
| L12.QA.11 | **#915** · o compromisso que atravessa a meia-noite | **PASS pela tela** — o bloco aparece como **"Ocupado"** e o título sensível não chega nem à tela nem à rota. ⚠️ **O RECORTE não foi exercitado**: a tela abre na visão Semana (`de=13/09 03:00Z` `ate=20/09 03:00Z`) e o evento cai inteiro dentro. Medir o recorte exige a visão **Dia**. Evidência: `evidence/triagem-16set-l12/915-04-agenda-com-bloco-ocupado.png` |
| L12.QA.12 | **#907** · o nome editado vence o do WhatsApp | **PASS pela tela** — depois de editar em "Editar contato", o Inbox (lista, cabeçalho e painel) mostra só o nome escolhido, o radar idem, e `GET /api/v1/conversations` — a MESMA linha de onde a notificação tira o título — traz as duas colunas, com `name` primeiro na precedência. Evidência: `907-05`…`907-07` |
| L12.QA.13 | ⚠️ `Display name` em inglês na ficha do contato | **REPORTADO, anterior ao lote** — a ficha mostra "NOME" e "DISPLAY NAME" lado a lado, a segunda crua, sem `t()`, num produto que serve pt-BR e es (`app/app/contacts/[id]/_client.tsx:148`). Está igual na `main` |
| L12.QA.14 | **#942** · a ferramenta que confere e marca | **PARCIAL** — a CONFIGURAÇÃO está provada na tela: o pacote "Vender e mover o funil" aparece, a capacidade "Ver se o horário está livre e já marcar" mora atrás de "Escolher uma a uma (modo avançado)", nasce **desligada** e, como `admin`, o clique a liga. **O COMPORTAMENTO é NÃO MEDIDO: falta chave de IA** (`AI_GATEWAY_API_KEY`/`ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY`) — sem ela o motor pula toda resposta com `reason='ai_gateway_key_missing'`. Evidência: `evidence/triagem-16set-l12/942-00-pacotes-do-agente.png`, `evidence/triagem-16set-l12/942-01-capacidade-na-tela-do-agente.png`, `evidence/triagem-16set-l12/942-02-capacidade-ligada.png` |
| L12.QA.15 | ⚠️ O papel que a tela do agente exige para ESCREVER | **medido, não é defeito** — a porta é `minRole: "manager"`, mas `app/app/ai/agents/[id]/page.tsx:68` faz `readOnly = ROLE_RANK[role] < ROLE_RANK.admin`: como `manager` a caixa aparece **desabilitada** com `0 de 25` do teto usado. Registrado porque foi o que fez a primeira medição de #942 parecer defeito do lote |

**A seção "Lote 12 · G2" acima deixa de estar PENDENTE POR EXECUÇÃO**: os três
casos dela (L12.G2.1, G2.2 e G2.3) estão provados nas linhas acima.

---

## J27 — O construtor de fluxos diz a verdade sobre a regra `[P1]` (2026-09-17)

Origem: um print do dono do produto, do construtor aberto, com a frase "Corrija
por favor". O que o cartão mostrava e o que o motor fazia eram coisas
diferentes — e nada na tela acusava a diferença.

Contexto do código: `app/app/ai/followups/[id]/_components/` (cartão, formulário
da condição, canvas), `lib/followup/vocabulario.ts` (a frase da regra),
`lib/followup/node-handlers.ts` (a avaliação) e
`lib/followup/validate-publish.ts` (o portão do publicar). A etapa do funil é
comparada pelo `stage_id`; o cartão mostra o nome, resolvido em UMA fonte
(`EtapasDoFluxo`) que o canvas inteiro lê.

Spec: `tests/e2e/followup-cartoes.spec.ts` (parte 3 do `e2e`). Ambiente desta
sessão: Supabase local pg15 com o `baseline.sql` reaplicado, `next build` +
`next start` na porta 3111, sem chave de IA, sem Resend, sem WAHA — o estado de
um primeiro deploy. Cron drenado pelo endpoint, como em produção.

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J27.1 | A regra de etapa é escolhida numa lista, agrupada por funil | grava o `stage_id`; a saída do cartão lê «O lead está na etapa “Etapa · Funil”» | PASS |
| J27.2 | O cartão não mostra identificador interno | nenhum uuid no texto do cartão | PASS |
| J27.3 | Nada de texto cortado no cartão | `scrollWidth ≤ clientWidth` e `scrollHeight ≤ clientHeight` em todo subtítulo e toda saída | PASS — medido, não olhado |
| J27.4 | O passo de classificar fala português | "2 classes · espera 15 min"; saídas "Interessado", "Sem interesse", "Sem resposta", "Outros casos"; nenhum cartão com a palavra "grace" | PASS |
| J27.5 | A saída de escape de um nó ramificado | "Outros casos", nunca "Sempre" (que prometia o que o motor não faz) | PASS |
| J27.6 | A linha entre dois passos é visível no tema claro | `stroke` sai de token do tema, não do cinza `#b1b1b7` da biblioteca | PASS |
| J27.7 | Publicar com regra sem valor | recusado, com o aviso ancorado no nó dizendo QUAL regra | PASS |
| J27.8 | **A consequência**: dois leads, duas saídas | o lead NA etapa escolhida sai pela saída daquela regra; o de outra etapa sai por "Nenhuma delas" | PASS — antes do conserto os dois terminavam no mesmo nó |
| J27.9 | Leitura de etapas que falha (500) | o construtor diz que não deu para carregar; NÃO acusa a regra de apontar para etapa inexistente | PASS — provado em unit (`EtapasDoFluxo.test.tsx`, `NodeCard.test.tsx`); visto na tela por acaso, quando a RPC de sessão administrativa falhou sob carga |
| J27.10 | Nó solto não se acusa antes de Publicar | — | **NÃO CONSERTADO** — item separado: o aviso existe, mas só depois do clique em Publicar |
| J27.11 | O 422 do publish mostra id interno e jargão dentro do cartão | `Nó "ai_classify-2" não tem edge class_match…` | **NÃO CONSERTADO** — anterior a este trabalho; vale um item próprio, porque é o cartão falando a língua do banco |

Evidência: `evidence/followup-cartoes/cartoes-01-regra-de-etapa-pelo-nome.png` ·
`evidence/followup-cartoes/cartoes-02-regra-sem-valor-nao-publica.png` ·
`evidence/followup-cartoes/cartoes-03-dois-leads-duas-saidas.png`.

**Ressalva de ambiente, medida:** com a máquina em load 60+ (outras sessões), a
RPC `fn_support_context` falhou e derrubou `/api/v1/pipelines` com 500 — e foi
assim que o estado "não consegui carregar as etapas" apareceu na tela sem ser
provocado. A função existe e tem `EXECUTE` para `authenticated` no banco local;
a falha foi de carga, não de permissão.

### Conexão por código de pareamento — 2026-09-15

[P0] Conexões → Conectar novo WhatsApp → Conectar por código → telefone com país
e DDD → Gerar código → confirmação no celular → polling WORKING. Mesmo
componente no onboarding. QR permanece disponível para retorno.

Cobertura automatizada: `lib/channels/pairing-code.test.ts`,
`app/api/v1/channel-sessions/[id]/pairing-code/route.test.ts`,
`components/connections/PairingOptions.test.tsx`: contrato de transporte,
isolamento da consulta, RBAC/MFA, arquivado, estados não pareáveis, rate limit,
timeout, sanitização, formulário, geração explícita e retorno ao QR.
Teste de componente/contrato não prova pareamento real no celular.

Prova em 15/09/2026: 853 arquivos / 8.791 testes aprovados + 1 falha esperada;
typecheck e build local/amd64 aprovados; lint sem erros (avisos preexistentes).
Imagem `1.24.0-saraiva-pairing.edae079` saudável na VPS. Pela tela real,
Conectar novo WhatsApp abriu QR/código, telefone curto desabilitou o envio,
telefone malformado exibiu validação do servidor e a volta ao QR funcionou.
API real retornou 401 sem login, 400 para telefone inválido, 404 para sessão
ausente, 409 para sessão já conectada e 429 para repetição. Sessão vazia de QA
removida pelo fluxo de exclusão, após conferir zero histórico/vínculos; canal
original permaneceu WORKING. Código gerado pelo transporte é coberto por teste
de contrato; pareamento real por código ainda requer confirmação no celular.

## Redes sociais nativas — 2026-09-15

- [P0] Conexões → Redes sociais: credencial/perfil, contas e conexão sem expor chave.
- [P0] Instagram/Facebook: habilitar recebimento, IA pausada, abrir Inbox existente.
- [P0] Webhook de outra conta/rede, assinatura inválida e evento repetido não produzem resposta.
- [P1] Conta sem DMs implementados informa a limitação; não oferece ativação fictícia.
- [P1] Falha na assinatura do webhook fica visível e retenta com reconciliação por URL.
- Evidência automatizada: `social/parser.test.ts`, `social/client.test.ts`, rota social,
  `RedesSociaisClient.test.tsx`, invariante de banco `social-native.test.ts`.
- QA local com Supabase e provedor de teste: entrada assinada, resposta manual, deduplicação, assinatura inválida, conta incorreta e concorrência de registro aprovadas.
- QA visual local e na instalação self-host concluída; app/worker `788b0fe` saudáveis e testes de webhook do provedor aprovados. DM real e pareamento confirmado no celular permanecem pendentes.

## Prospecção nativa — 2026-09-15

[P0] Validado no navegador, com Next em modo produção e Supabase local: resultados comerciais semeados → escolher agente publicado, conexão, funil e duas etapas → definir oferta, critérios e ritmo → iniciar → ver contato, negócio e conversa criados → pausar a fila. Consulta do banco confirmou `paused/queued`, os três vínculos e zero mensagens. A busca paga e a entrega a pessoas reais não foram executadas neste QA. A Prospecção tem entrada direta na seção CRM do menu lateral para administradores.

### Contexto de prospecção no Inbox

O bloco `LeadEnrichment` do `CRMSidePanel` recebe os campos comerciais normalizados
por `GET /api/v1/contacts/[id]/crm-summary` e permite consultar site/redes/Maps
sem sair do atendimento. A rota autoriza primeiro o contato por RLS; a leitura
administrativa de candidatos restringe organização e contato, projetando somente
campos públicos. Sem candidato, mostra ausência; erro de consulta mostra tentativa
novamente sem bloquear as outras seções. Contato anonimizado não mostra o contexto.

Living System Checklist: entrada = prospecting_candidates; saída = atendente e
fontes externas HTTP(S); superfície/porta = conversa existente no Inbox; configuração
= busca de prospecção existente; continuidade = contexto da IA disponível ao humano.
Leitura pura: não emite mutação/auditoria, não agenda ação nem altera o agente.
Retorno de erro = estado explícito e nova leitura. Mapa: prospeccao-nativa.
Cobertura: inbox-enrichment-route.test.ts e inbox-demandas-abertas.test.tsx.
## J28 — Uma pessoa assume uma conversa que a IA passou `[P0]` (2026-09-18)

**Por que P0:** é a jornada em que o cliente mais sente a diferença entre um CRM com IA e
um robô que abandona a conversa. Toda passagem para humano termina com uma pessoa lendo
alguma coisa e digitando a primeira frase — e é essa frase que o cliente recebe.

### O que a onda entregou, e o que ela NÃO provou

A onda de MOTOR fez as treze passagens gravarem o contexto, corrigiu a verdade do
"cliente já foi avisado", trocou o dedup do aviso por adendo e fez o aviso se resolver
sozinho quando alguém assume. **A onda seguinte trouxe o cartão, a rota, o cobrador e o
laço de retorno** — e mesmo assim a jornada EM TELA ainda não existe: nada aqui foi
dirigido por um browser, e dizer que passou seria afirmar o que não se mediu.

| caso | estado |
|---|---|
| J28.1 · a passagem vira linha nos DOIS motores, com origem declarada | **PASS por unidade** — `tests/unit/passagem-registro-e-dedup.test.ts`, com pool falso (motor A) e client falso (motor B) |
| J28.2 · a segunda passagem da mesma conversa vira ADENDO, não descarte | **PASS por unidade** — mesmo arquivo, nos dois motores |
| J28.3 · "o cliente JÁ FOI avisado" só quando a mensagem saiu | **PASS por unidade** — `tests/unit/passagem-verdade-do-aviso.test.ts`, nos dois emissores |
| J28.4 · assumir a conversa fecha a passagem e resolve o aviso | **PENDENTE POR EXECUÇÃO** — `tests/invariants/passagem-se-reconhece-sozinha.test.ts` existe e precisa de `pnpm test:db` |
| J28.5 · **pela TELA**, quem assume lê o porquê, o que a IA tentou e a fala do cliente | **PASS pela tela** — fechado por J30 (`tests/e2e/passagem-com-contexto.spec.ts`), rodado contra a bancada; evidência em `evidence/casos-vivos/passagem/` |
| J28.6 · **pela TELA**, o aviso da Central leva a "Abrir conversa" e some ao assumir | **PASS pela tela** — fechado por J30, no mesmo spec |
| J28.7 · o cartão decide os SETE estados (nova, reconhecida, devolvida, recolhida, sem resumo, opt-out, anonimizada) | **PASS por unidade** — `tests/unit/cartao-da-passagem.test.ts` (25 casos), sobre a função pura que o JSX consome |
| J28.8 · a rota das passagens lê com o client da SESSÃO, e não com o admin | **PASS por unidade** — `tests/unit/passagens-da-conversa-rota.test.ts`; a RLS em si é do `test:db` |
| J28.9 · a passagem que ninguém assumiu volta a pedir, e para no terceiro aviso | **PASS por unidade** — `tests/unit/cobrador-de-passagem-nao-reconhecida.test.ts` (10 casos) |
| J28.10 · o laço de retorno: o cliente repetiu depois da passagem? | **PENDENTE POR EXECUÇÃO** — `tests/invariants/atrito-repeticao-pos-passagem.test.ts` existe e precisa de `pnpm test:db` |

### O que a onda do CARTÃO entregou — e a linha que continua NÃO COBERTA

O cartão existe, dentro do fio da conversa, e a decisão dos sete estados está provada por
unidade. **J28.5 e J28.6 continuam NÃO COBERTOS**, e a distinção importa: o que foi provado
é que a função decide certo e que a rota entrega a leitura ao client que tem RLS. Que a
TELA renderiza aquilo, que o botão "Assumir e responder" muda o estado do cartão e que o
aviso sai da lista de abertos é jornada em tela — DoD 12 —, e é da onda 12. Declarar PASS
aqui seria inventar uma medição.

**Por que o cartão mora no fio, e não no cabeçalho:** o `ConversationHeader.tsx` carrega um
comentário de 11 linhas contando que ele já travou a largura da tela inteira em 707px e
empurrou o painel de CRM 311px para fora da viewport em 1280px. Um cartão de seis linhas
ali reintroduz o defeito que o `flex-wrap` acabou de consertar. O fio já intercala
mensagens e notas por timestamp e o auto-scroll traz o fim para a viewport — e como a
passagem CALA a IA, ela é quase sempre o último evento quando a pessoa chega.

**Achado desta onda, e não é do produto:** `docs/architecture/escalacao-ciclo-humano.architecture.json`
estava na `main` da branch **com marcadores de conflito de merge commitados** (`<<<<<<< HEAD`
nas linhas 422 e 910, do merge `f7523adc5`). O arquivo não era JSON válido e
`tests/unit/mapas-de-arquitetura.test.ts` estava **vermelho em 5 casos** desde então.
Resolvido pela UNIÃO dos dois lados, com as arestas do lado `feat/casos-vivos` renumeradas
(`e75`–`e83` → `e81`–`e89`) porque os ids colidiam. 121/121 depois.

### O achado que mudou o desenho, e que a tela não teria encontrado

**`queued` contava como "cliente avisado", nos dois motores.** `sendMessageHandler` não
lança em falha de canal: modo de teste, canal arquivado, contato sem telefone e recusa do
transporte viram `status='failed'` na linha da mensagem, e canal fora do ar vira `queued`.
Os dois emissores liam só a ausência de exceção. O resultado é a Central afirmando "O
cliente JÁ FOI avisado de que uma pessoa vai assumir" para quem não recebeu nada — e o
atendente abrindo a conversa respondendo a alguém que não sabia que ele vinha.

Não é achado de tela: pela tela o texto está lá e parece certo. É achado de ler o que a
função devolve.

### A evidência da tela do chat do caso, e o que ela não prova (2026-09-18)

Três imagens da tela do caso estavam versionadas **sem nenhum documento que as citasse**
— `tests/unit/evidencia-citada.test.ts` reprovava a branch por isso, e o segundo lado da
regra existe exatamente para impedir que imagem entre antes do documento que a justifica.
Elas ficam citadas aqui, com o que EU vi ao abri-las (olhei as três, uma a uma):

| imagem | o que ela mostra |
|---|---|
| `evidence/casos-vivos/chat/01-entrou.png` | a tela de **login em branco**, antes de entrar. O nome diz "entrou"; a imagem diz o contrário |
| `evidence/casos-vivos/chat/02-lista-de-casos.png` | **a única que prova o que o nome diz**: `/app/ai/cases` com a aba "Abertos (1)" e o caso "Desconto acima da alça… · Aguardando você", mais o painel vazio à direita ("Selecione um caso à esquerda") |
| `evidence/casos-vivos/chat/03-detalhe-do-caso.png` | a tela de **Contatos** em estado de esqueleto (blocos cinza carregando). Não é o detalhe de caso nenhum |

**O que estas três imagens provam, e o que provou a jornada.** Duas das três não mostram o
passo que o nome delas promete, e a terceira prova só que a LISTA renderiza. Elas ficam
aqui como o registro do que a primeira tentativa alcançou — e não como prova da jornada.

A prova da jornada veio depois, em outra captura: `evidence/casos-vivos/README.md`, com o
caso aberto e a resposta da IA na tela. **É aquele README que responde "o chat do caso
funciona?"**, não estas três imagens; esta tabela existe para que ninguém as tome por
prova ao encontrá-las soltas no diretório.

---

## Onda 12 — A PROVA EM TELA dos casos vivos `[P0]` (2026-09-18)

Três funcionalidades do épico "casos vivos" passam a ter jornada dirigida por **browser**,
com medida por ferramenta (`getBoundingClientRect` / `getComputedStyle` / `count()`), num
banco fresco estilo VPS (`supabase/baseline.sql` + `bootstrap-owner` + seeds), build de
produção e **sem chave de IA** — o dublê `INTERNAL_AGENT_RUN_STUB`, que é como o CI roda.

As capturas e o que cada uma mostra estão em
[`evidence/casos-vivos/README.md`](../../evidence/casos-vivos/README.md). Aqui fica o estado
de cada caso.

### J28 — Conversar com a IA que abriu o caso `[P0]`

Spec: `tests/e2e/conversa-do-caso.spec.ts` → `SPECS_PARTE_2`.

| caso | o que se mede | estado |
|---|---|---|
| J28.1 | o painel "Conversar sobre o caso" existe UMA vez no detalhe do caso | PASS |
| J28.2 | o aviso de persona diz **quem** responde quando não é o agente do caso | PASS |
| J28.3 | a pergunta pronta PREENCHE o campo e **não** envia (contagem de bolhas não muda) | PASS |
| J28.4 | pergunta e resposta aparecem com **autor e hora**, e a resposta é prosa (não o JSON dos outros ramos do dublê) | PASS |
| J28.5 | **persistência**: F5 e as duas bolhas continuam lá | PASS |
| J28.6 | **compartilhamento**: outra pessoa da equipe abre o mesmo caso e vê a pergunta de quem chegou antes | PASS |
| J28.7 | **visibilidade**: em `visibility_mode='own'`, o `agent` que não é dono não vê o caso **nem na fila nem pelo link direto** | PASS |
| J28.8 | o painel de decisão vizinho continua alcançável (um só botão "Enviar"; a primeira `textarea` é a dele) | PASS |
| J28.9 | layout por ferramenta: botão alcançável, fonte e cor do produto, zero rolagem horizontal em 1440px **e** em 390px | PASS |
| J28.10 | sem jargão (`case_chat`, `purpose`, `llm_call`, `undefined`, `null`, `error_code`) | PASS |
| J28.11 | contato **anonimizado**: o campo some e a tela diz o motivo | PASS |
| J28.12 | o estado **sem chave de IA** | **NÃO COBERTO em tela** — o dublê injeta a chave, então `ia_configurada` é sempre verdadeiro sob ele. Guardado por `tests/unit/` |

### J29 — O aviso de caso no WhatsApp da equipe `[P0]`

Duas specs, e a divisão é uma restrição medida, não preguiça:
`tests/e2e/aviso-de-caso-no-whatsapp.spec.ts` (`SPECS_PARTE_2`) e
`tests/e2e/aviso-de-caso-chega-no-whatsapp.spec.ts` (`FORA_DO_CI`, com o motivo escrito no
workflow).

| caso | o que se mede | estado |
|---|---|---|
| J29.1 | a tela é de quem **administra** — um `manager` cai em 403 | PASS (CI) |
| J29.2 | o `admin` entra com verificação em duas etapas | PASS (CI) |
| J29.3 | o **estado efetivo** vem ANTES do formulário no fio do DOM, e a instalação sem endereço público lê "Este sistema ainda não tem um endereço na internet" | PASS (CI) |
| J29.4 | o interruptor fica **travado**, e a decisão do dono ("o aviso sai na hora, inclusive fora do horário") está escrita na tela | PASS (CI) |
| J29.5 | telefone pela metade é recusado, e o seletor fala de **capacidade**, nunca de provedor | PASS (CI) |
| J29.6 | o preço do teste ("manda mensagem de verdade e conta no limite diário") vem antes do clique | PASS (CI) |
| J29.7 | o teste **recusa dizendo o que falta**, não um "não deu certo" | PASS (CI) |
| J29.8 | **a recusa é honesta ponta a ponta**: caso aberto + dreno → entrega `falhou / sem_endereco_publico`, e a tela explica | PASS (CI) |
| J29.9 | layout por ferramenta e ausência de jargão (inclusive `waha` e `http://`) | PASS (CI) |
| J29.10 | com endereço público o interruptor **destrava** e o aviso de teste **chega** num receptor HTTP de verdade | PASS (local, `FORA_DO_CI`) |
| J29.11 | o caso aberto dispara **um** aviso, cujo texto tem assunto, primeiro nome e link, e **não** tem sobrenome, telefone do cliente nem trecho de conversa | PASS (local) |
| J29.12 | drenar de novo **não** manda de novo (idempotência) | PASS (local) |
| J29.13 | a entrega aparece como **enviada** na tela, e a linha do tempo do caso diz "Avisamos o suporte no WhatsApp" | PASS (local) |
| J29.14 | o número interno que responde **não vira contato nem conversa** | **NÃO COBERTO em tela** — o webhook exige token e HMAC do canal, e o cenário desta bancada nasce com segredo de placeholder. Guardado por `tests/unit/numero-interno-de-aviso.test.ts` |
| J29.15 | a falha de entrega vira aviso na Central **depois do teto de tentativas** | **NÃO COBERTO em tela** — o teto exige atravessar a janela de reivindicação (2 min por rodada); medido por unidade |

**Por que J29.10–13 não rodam no CI.** `lib/escalacao/aviso-de-teste.ts` e
`lib/escalacao/aviso-ao-suporte.ts` recusam mandar um aviso cujo link não abriria no celular
de outra pessoa, e `scripts/gerar-env-e2e.sh` grava `NEXT_PUBLIC_APP_URL=http://localhost:$E2E_PORT`
— que é o endereço em que o servidor sob teste responde de verdade, e do qual três specs de
fluxo por e-mail dependem. O endereço é lido uma vez no boot, então não há como valer só
para uma spec. O que roda no CI **não pula o assunto**: J29.8 cobra a recusa inteira.

### J30 — A passagem para humano chega com contexto `[P0]`

Spec: `tests/e2e/passagem-com-contexto.spec.ts` → `SPECS_PARTE_3`. **Isto fecha J28.5 e
J28.6**, que estavam declarados NÃO COBERTOS na onda do cartão.

| caso | o que se mede | estado |
|---|---|---|
| J30.1 (= J28.5) | o cartão "Por que a IA passou para você" está no fio, com motivo em português, "O cliente quer", "A IA já tentou" e a fala literal do cliente entre aspas | PASS |
| J30.2 | vocabulário de banco não chega à tela (`requested_human`, `suspected_optout`, `ferramenta_do_modelo`, `motivo_codigo`) | PASS |
| J30.3 | o convite **"Assumir e responder" está dentro da janela** quando a pessoa chega | FAIL → PASS (ver o achado abaixo) |
| J30.4 (= J28.6) | a Central mostra "O assistente passou um atendimento para um humano" com **"Abrir conversa"** apontando para aquela conversa, e o corpo do aviso **não** repete a fala do cliente | PASS |
| J30.5 | clicar "Assumir e responder" muda o cartão para **reconhecida** e ele passa a dizer quem assumiu | PASS |
| J30.6 | e o aviso sai dos abertos da Central **sozinho**, por gatilho | PASS |
| J30.7 | layout em 390px: o cartão cabe e a conversa não rola para o lado | PASS |
| J30.8 | o caminho da **ferramenta** do modelo e a passagem por `suspected_optout` | **NÃO COBERTO em tela** — guardados por `tests/unit/cartao-da-passagem.test.ts` |

### Os três defeitos que a prova em tela encontrou, e o conserto de cada um

1. **O convite de assumir nascia abaixo da dobra** (J30.3). Medido: botão em **y=1008 numa
   janela de 720px** — montado, clicável por programa e invisível para quem chegou.
   `ChatThread` decidia "a abertura já terminou" pelo contador de páginas da consulta de
   MENSAGENS, e o cartão chega de consulta própria, depois da primeira pintura; numa conversa
   sem mensagens (o normal logo após uma passagem) a guarda "o usuário está lendo o histórico"
   passava a valer sobre alguém que não tinha rolado nada. Consertado em
   `components/inbox/ChatThread.tsx`; a catraca é a medição do botão contra a janela.
2. **A fila de casos ficava vazia sem dizer por quê.** `GET /api/v1/ai/cases` (e o detalhe)
   tinham `catch` NU: o 500 virava `data === undefined` no React Query e a tela mostrava
   "Nenhum caso aberto" — indistinguível de "não há casos" — com o log do servidor mudo.
   Quem diagnosticava tinha o banco certo, a tela errada e nada entre os dois. Agora a causa
   é registrada; a frase para quem lê a tela não mudou.
3. **A tela do aviso virava beco sem saída no primeiro engasgo.** `useAvisoDeCaso` usava
   `retry: false` (razão escrita: "403 não muda se repetir"), e com isso QUALQUER falha
   passageira trocava o formulário por "Não foi possível abrir esta tela agora. Atualize a
   página", sem volta automática. Medido com o banco saturado (504 e `canceling statement due
   to statement timeout`): aconteceu em 2 de 3 aberturas. Agora repete o que é passageiro e
   nunca o que é `4xx`. **Servidor apertado não é exceção de laboratório** — é a VPS pequena
   que roda banco, aplicação e WhatsApp no mesmo disco.

Um quarto achado, de FERRAMENTA e não de produto: `playwright.config.ts` calculava a porta
antes de publicar o `.env.e2e` no processo, então o processo que sobe o servidor e o worker
que dirige o browser resolviam `E2E_PORT` para valores **diferentes** — servidor numa porta,
`page.goto` em outra, e `ERR_CONNECTION_REFUSED` com um servidor saudável no ar. O CI nunca
pisou nisso porque o gerador não escreve `E2E_PORT`; quem monta bancada em porta própria,
sim. Consertado pela ordem: publicar primeiro, decidir a porta depois.


## Conversões de anúncios — reprocessamento

[P1] `tests/e2e/conversoes-reprocessamento.spec.ts`: administrador abre Conversões sem credenciais opcionais, vê o que falta, identifica origem de uma venda pendente e agenda reprocessamento pela tela. A spec confere o evento exclusivo e captura screenshot; integra o CI. O teste não prova aceite/atribuição por contas reais de anúncios.

### Conversões Google: captura e qualificação

- [P1] `tests/e2e/conversoes-reprocessamento.spec.ts`: salvar captura Google pela tela, recarregar configuração, abrir endereço com wbraid e verificar a referência criada. Destino WhatsApp interceptado; não envia mensagem nem comprova atribuição externa.
- Componentes: `tests/unit/conversoes-formularios.test.tsx` cobre escolha de etapa/ação, bloqueio da mesma ação de compra e formulário de captura.
- Banco: `tests/invariants/conversoes-qualificacao-isolada.test.ts` cobre identificadores, isolamento da etapa, snapshot e reprocessamento por evento.
- Piloto real ainda necessário: anúncio → mensagem → etapa → recibo e diagnóstico da plataforma.

- Script do site: `tests/unit/script-do-site.test.ts` executa o JS distribuído, cobre navegação, filtros, storage bloqueado, links dinâmicos e exclusão. `tests/e2e/conversoes-reprocessamento.spec.ts` instala o snippet copiado da tela em uma página de teste, navega sem query e segue até a captura real, com WhatsApp interceptado.

## J33 — Um roteiro de atendimento coleta dados e a ficha mostra `[P1]` (2026-09-24)

Port do #1130 (@vgamkt), PR 3 de 4. Spec: `tests/e2e/fluxo-de-atendimento.spec.ts` (job e2e, parte 5).

| Caso | Esperado |
|---|---|
| J33.1 | O dono do servidor liga «Fluxos de atendimento» em /admin/sistema e a chave fica gravada na instalação |
| J33.2 | O gerente cria o roteiro em IA › Fluxos de atendimento; a paleta tem SÓ Início, Pergunta, Skill e Fim (medido no DOM) |
| J33.3 | Palavra-gatilho no Início, uma Pergunta de CPF e uma de lista; publicar grava o gatilho na versão ativa |
| J33.4 | Três mensagens pelo webhook do WAHA; a ficha mostra o roteiro «Concluído» com CPF e modelo (caixa medida por `boundingBox` e estilo computado) |

**NÃO coberto por esta spec:** o turno do agente roda com o worker e o modelo de verdade — no CI não há nenhum dos dois, e a spec chama as mesmas funções do motor (`prepararRoteiroDoTurno`, `garantirPerguntaDoRoteiro`) com o validador devolvendo `indefinido`. A pergunta enviada ao cliente pelo WhatsApp e a leitura pelo validador de modelo ficam para a prova do PR 4.
