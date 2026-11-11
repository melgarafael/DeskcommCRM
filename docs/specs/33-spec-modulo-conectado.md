---
title: "Spec Técnica 33 — Módulo conectado: um serviço externo se pluga no CRM e atravessa as atualizações"
parent: 00-prd-master.md
type: spec
scope: plataforma de módulos (ADR-0005, onda O2), autenticação da API, navegação
status: draft
version: 0.2.0
owner: arquitetura
created_at: 2026-11-02
related:
  - ../adr/0005-plataforma-de-modulos-de-terceiro.md
  - ../doctrine/extensoes.md
  - extensoes-declarativas-v1.md
  - modulos-dados-declarados-v1.md
---

# Spec 33 — Módulo conectado

Status: **PROPOSTA**. O código citado é o da `main` em `fe7a11457` (02/11/2026). Esta spec detalha a
onda O2 da [ADR-0005](../adr/0005-plataforma-de-modulos-de-terceiro.md), que hoje tem a decisão mas
não tem contrato. Ela não muda a régua da ADR. Onde precisa de uma decisão que a ADR não tomou, a
decisão está em *Decisões onde a ADR não decide*.

## O problema, em duas frases

1. Quem precisa de um serviço próprio dentro do CRM (integração, lógica própria, dados fora do banco
   do produto) hoje só tem o fork, e o fork paga em conflito a cada versão.
2. A ADR-0005 já escolheu a saída, a classe `connected`, mas nenhuma peça dela existe: o manifesto
   recusa o perfil, não há token de módulo e não há lugar na tela.

## O que foi medido

| Fato | Comando | Resultado em `fe7a11457` |
|---|---|---|
| Perfis aceitos no manifesto | `grep -n 'profile: z.enum' lib/extensions/manifest.ts` | `declarative`, `data` (linha 279) |
| Perfis aceitos no banco | `grep -n "'declarative','data'" supabase/baseline.sql` | só os dois, em `fn_extensions_finish_install` (linha 49069) |
| Versão da API do host | `grep -n 'HOST_API_VERSION =' lib/extensions/manifest.ts` | `2`, e a F1 não o altera. O PR #3477 (rascunho, em conflito) usa `3` para o turno |
| Rotas da API | `git ls-tree -r --name-only HEAD app/api/v1 \| grep -c 'route\.ts$'` | 519 |
| Token de servidor | `lib/mcp/auth.ts`, tabela `api_tokens` | hash SHA256, organização na linha do token, papel e ator em `scopes` |
| Dono do token | `grep -n 'api_tokens_created_by_fkey' supabase/baseline.sql` | `created_by` → `auth.users` com `ON DELETE RESTRICT` |
| Teto de tokens vivos | `grep -n 'v_teto' supabase/baseline.sql` | 50 por organização |
| Teto de escrita por token | `lib/mcp/rate-limit.ts` | 30 por minuto, 600 por organização |
| Auditoria de token | `grep -n 'api_audit_log_actor_api_token_id_fkey' supabase/baseline.sql` | `actor_api_token_id` já existe (`ON DELETE SET NULL`); não há ator `module` |
| "Em nome de" | `app/api/v1/messages/route.ts:40` | precedente: escopo `messages:on_behalf` (#1613) |
| Assinatura de JWT | `package.json` | `jose` já é dependência |
| Segredo cifrado | `lib/crypto/aes_gcm.ts`, `lib/mcp/servidor-externo/segredo.ts` | caminho pronto para cifrar segredo em repouso |
| Guarda de origem | `lib/extensions/download.ts` | HTTPS, sem redirect, endereços especiais recusados, exceção só em loopback de laboratório |
| Ativação por organização | `organization_extensions` | já existe, com revisão e recibo |
| Compatibilidade na leitura | `lib/extensions/manifest.ts`, `checkCompatibility` | reavaliada na ativação, na leitura e na ação |
| CSP nas páginas | `next.config.ts:92` | não há; `X-Frame-Options: DENY` impede que o CRM seja enquadrado, mas não impede o CRM de enquadrar |
| Microfone | `next.config.ts`, `Permissions-Policy` | `microphone=(self)`: iframe de outra origem não recebe microfone |
| Navegação | `lib/navigation/catalogo.ts`, `interface.ts:118` | lista estática; `permitidos()` é o único filtro |
| Rota sem porta | `tests/unit/navegacao-completude.test.ts` | reprova o CI |

**Converter rotas já é o caminho aceito.** O `CLAUDE.md` registra a decisão de 17/09/2026:
"converter as rotas que cada integração precisar". PRs de contribuidor seguiram esse caminho e
entraram: #661 (contatos), #2194 (configurar o agente) e #2824 (roteadores).

**Rotas que chamam `resolveAuthDual` e não têm entrada em `lib/auth/public-paths.ts`:**
`agenda/servicos/atualizar`, `conversations/[id]/drafts/consume`, `conversations/[id]/notes/media` e
`prospecting/importar`. A última recusa token de propósito, como diz o comentário na rota. Nas outras
três, o `proxy.ts` responde 401 ao token antes de o handler rodar.

**O recorte de rotas que um módulo pode alcançar.** Saem do recorte 137 rotas pelos prefixos `cron`,
`admin`, `auth`, `webhooks`, `webhook-sources`, `lgpd`, `ai/credentials`, `mcp`, `system`, `tenants`,
`onboarding`, `extensions`, `health`, `settings/api-tokens`, `cobranca`, `plataformas-de-anuncio`,
`integrations`, `marca` e `avisos`. Saem também 34 rotas pelas primeiras linhas da lista de negação da F3
(`team/invite…`, `ai/providers`, `external-db/connections`, `channels`, `settings/assinatura`, o disparo
de campanha e o envio de mensagem). Sobram **348**: 22 aceitam token de ponta a ponta, 4 têm o handler
com token e não têm entrada no proxy, e 322 são só de sessão (221 com escrita e 101 só de leitura). O
resto da lista de negação, rota por rota e método por método, deixa **261 rotas (360 métodos) a
converter**, divididas na tabela da R. O comando que produz esses números está em
[Como medir o recorte](#como-medir-o-recorte), e a lista de negação nominal está na F3.

## O que muda

### Regra que vale para todas as fatias

- **Zero módulos continua sendo um estado completo** (não-negociável 1).
- **Nenhum código de terceiro roda no processo do CRM** (D2). O CRM não chama o serviço do módulo: o
  navegador abre a tela do módulo, e o módulo chama o CRM.
- **O módulo não recebe segredo, chave de IA nem acesso ao banco do CRM.** Ele só alcança rotas `/api/v1`.
- **Fora do caminho quente** (D6): ingestão, dreno, turno e envio não chamam módulo.

### F1 — Manifesto e catálogo aceitam `connected`

- O perfil `connected` entra no Zod e em `fn_extensions_finish_install`, com a tripla de migration.
- O manifesto continua sem URL (ADR-0003 D3). O endereço do serviço fica no catálogo revisado, num
  campo novo da entrada, e é validado pela mesma regra do download: origem exata, HTTPS, sem
  credencial, caminho, query ou fragmento.
- O pacote declara **áreas de uma lista fechada do host** (ver F3) e, se quiser, um rótulo e um
  ícone da lista existente para a tela.
- **A F1 não sobe a versão da API do host** (emenda de 04/11/2026). Medido: `HOST_API_VERSION = 2`
  e os três pacotes oficiais (`extensoes/pacotes/deskcomm/*.json`, `extensoes/catalogo.json`)
  declaram `host_api: {min: 2, max: 2}`; `checkCompatibility` devolve `host_api_unsupported` quando
  `max < HOST_API_VERSION`, então subir para 3 suspenderia os três em toda instalação, inclusive nas
  já instaladas (o artefato é imutável). Um perfil novo não muda o que os pacotes existentes fazem.
  Um módulo `connected` declara `host_api: {min: 2, max: 2}`. A subida fica para quando um contrato
  mudar de fato (F6), junto com novas versões dos pacotes oficiais. Para conferir: `grep -n
  'HOST_API_VERSION =' lib/extensions/manifest.ts`.
- Um manifesto `connected` em host antigo é recusado com `profile_unsupported`: o host antigo não
  tem `connected` na lista de perfis, sem precisar de bump.
- **Interruptor local (D8).** Quem administra a instalação desliga um módulo conectado sem
  desinstalar. Desligado, o token recusa, o grupo some e o aviso aparece em `/admin/extensoes`.
  **Na F1** o interruptor só guarda e mostra o estado (`disabled_at`, `disabled_by`, recibo
  `switch`, auditoria `extension.switched`); "o token recusa" é da F2 e "o grupo some", da F4, que
  leem `disabled_at`. Reinstalar um módulo removido que estava desligado volta desligado (lado
  seguro; quem administra liga).

### F2 — Token do módulo

É a decisão D5 da ADR. Cada item abaixo precisa de migration, com a tripla.

**Segredo da instalação.**

- Instalar gera o segredo, mostrado uma vez a quem administra a instalação e guardado cifrado. Se a
  chave de cifra faltar, a instalação falha com mensagem na tela.
- O segredo pode ser **girado** por `/admin/extensoes`. Girar invalida o anterior na hora, e o módulo
  recebe o novo pela mesma tela. Perder o segredo se resolve girando; não há recuperação.
- O segredo é da **instalação**, não de uma pessoa. A saída de quem instalou não invalida o segredo.

**Token por organização.**

- Ativar numa organização cria o token daquele par, na mesma transação da ativação, reaproveitando
  `api_tokens`. Duas colunas novas ligam o token ao par: `extension_installation_id` e o slug do
  módulo. O hash continua sendo a única forma guardada.
- **Dono do token.** `created_by` tem `ON DELETE RESTRICT`. Se o dono fosse quem ativou, a conta
  dessa pessoa não poderia mais ser apagada. Proposta: o token de módulo usa `created_by` nulo e a
  coluna de instalação como dono, com uma CHECK que exige um dos dois. Ver a pergunta 3.
- **Teto de 50 tokens vivos.** O token de módulo conta no teto. Se o teto estiver cheio, a ativação
  falha com a mensagem do gatilho na tela, e nada fica pela metade.
- Desativar, remover, desligar pela instalação ou suspender a organização revoga na mesma transação.
- A tela de tokens mostra o token do módulo identificado. Ali ele pode ser **revogado**, o que
  equivale a desativar o módulo naquela organização, mas não pode ser copiado nem editado.

**Como o módulo pega o token.**

- O módulo **busca** o token numa rota própria, com um HMAC do segredo sobre organização, carimbo de
  tempo e nonce. Carimbo fora de 5 minutos, nonce repetido ou organização sem ativação recusam.
- Como o banco guarda só o hash, cada busca **gera um token novo** e invalida o anterior daquele par.
  O token tem validade curta (proposta: 1 hora). O módulo guarda o token em memória e busca de novo
  quando vence.
- Nenhum token viaja em fila ou evento.

**A chamada.** Usa o caminho comum: teto de escrita, empresa suspensa recusada, `actor_api_token_id`
no audit. Nasce a variante `module` em `Actor`, para a auditoria dizer qual módulo agiu e para nenhum
`…_by_user_id` receber o id de um token.

### F3 — Autoridade: declarado ∩ consentido ∩ papel de quem pediu

É a decisão D4 da ADR, aplicada num ponto só, `resolveAuthDual`.

**Consentimento por área.** A tela de ativação lista as áreas em frases legíveis, e a organização
pode aceitar menos do que o pacote pede. São **9 áreas**: `contatos`, `negocios`, `conversas`, `agenda`, `funis`, `agentes_ia`, `catalogo`,
`configuracao` e `analise`. Cada área tem leitura e escrita separadas (18
permissões `area.<área>.<leitura|escrita>`). Toda rota convertida declara sua área. Rota sem área
recusa token de módulo, e um teste varre isso.

**Tarefas, etiquetas e financeiro não nascem agora** (decisão do mantenedor, #4142 item 4); as rotas
correspondentes ficam sem área e recusam módulo até nova decisão. Não existe área `etiquetas`: não há
rota de escrita de etiqueta, e anunciar escrita que não existe é proibido. `contact-tags` (GET) vive em
`contatos` e `conversation-tags` (GET) em `conversas`. A leitura de `financeiro/catalogo/[tipo]` continua em
`catalogo`, e a de `financeiro/lancamentos` e de `honorarios/*` continua em `analise`; a escrita de
`financeiro/*` e de `honorarios/*`, e as rotas `tasks`, `demandas`, `financeiro/comandas` e
`financeiro/fidelidade`, ficam sem área.
**Outras rotas que saíram da lista "fora do mapa"** (10/11/2026): `people`, `people/[id]`,
`company-people`, `company-people/[id]` em `contatos` (leitura e escrita); `campaign-templates`,
`campaign-templates/[id]` (o modelo não envia nada sozinho; quem dispara a campanha é a pessoa) e
`message-template-groups` (e todas as subrotas, inclusive `[id]/ordem`) em `configuracao` (leitura e
escrita); `channel-schedules` e `channel-schedules/[id]` em `configuracao` só na leitura (a janela pausa
canais do WhatsApp, e desfazer exige a pausa manual em Conexões, então a escrita não tem área);
`ads/meta/accounts` e `ads/meta/campaigns` em `analise` (só leitura); `calls` GET e
`messages/[id]/media` GET em `conversas` (só leitura). A escrita de `calls` (ligar para o cliente é falar
com o cliente) continua sem área, e `phone-numbers` fica inteiro sem área: a leitura só aceita sessão
(`requireRole`, sem `resolveAuthDual`) e a escrita mexe na conexão do canal.

**Lançamento pago não se desfaz:** `financeiro/lancamentos` POST com `status: "paid"` e
`financeiro/lancamentos/[id]` PATCH `pay: true` recusam o ator `module` com 403 `forbidden` na própria
rota; criar lançamento pendente segue permitido.

**Leitura que traz o contato exige também `contatos`**, como agenda e follow-ups já faziam
(`LEITURAS_COM_CONTATO_EMBUTIDO`): `calls` GET e `messages/[id]/media` GET.

**Texto livre digitado pela equipe** (título do negócio, observação, descrição). Para módulo sem
`contatos`, dentro de cada registro que traz um contato, os identificadores DESSE contato viram
`[contato]` em todo valor string do registro e dos filhos dele (`lib/modulo/redigir-contato.ts`). É
filtro por lista, sem adivinhar: o nome inteiro e cada parte com 3 ou mais letras, como palavra inteira
e sem diferenciar maiúscula nem acento; o telefone pelos últimos 8 dígitos, com qualquer separador e com
código do país e DDD na frente; o e-mail sem diferenciar maiúscula. A regra vale para baixo, nunca para
irmãos (num quadro, o contato do negócio A não filtra o título do negócio B), e o objeto que teve texto
trocado ganha `text_redacted: true`. Chaves `id`, `*_id`, `redacted` e `text_redacted` não são filtradas.
**Limite que sobra:** só sai o que está escrito igual ao cadastro. Um apelido ("Cida" para "Aparecida")
passa, e o nome de OUTRA pessoa, que não seja o contato ligado ao registro, também passa.
Também não são filtrados: nome (ou parte) com menos de 3 letras; telefone com menos de 8 dígitos; separador que
não seja espaço, ponto, hífen ou parênteses. Telefones secundários (`contact_phones`) não vêm por nenhum dos 3
consumidores (medido). No quadro, a rota lê o nome do contato e o anexa ao negócio só para módulo sem `contatos`
(`anexarNomeDoContato`), antes do filtro; sessão e módulo com `contatos` não recebem leitura nem campo a mais.

**Nunca há área** para credencial, token, LGPD, cobrança, webhook, administração da instalação,
extensões e envio de mensagem (D6). Além dos prefixos que já saem do recorte, ficam fora, por nome:

| Rotas | Por quê |
|---|---|
| `team/invite`, `team/invites/*`, `team/[user_id]/role`, `team/[user_id]/revoke` | dão e tiram acesso a pessoas |
| `ai/providers`, `ai/providers/[provider]/models` | provedor e chave de IA |
| `external-db/connections` e as 9 rotas abaixo dela | credencial de banco externo |
| `channels/*` (10 rotas) | conexão de canal e credencial de provedor |
| `settings/assinatura` | cobrança |
| `campaigns/[id]/[acao]` | inicia o disparo |
| `messages`, `messages/[id]`, `messages/[id]/forward`, `messages/[id]/retry` | enviam mensagem |
| `automation-rules/runs/[runId]/resend` | reenvia mensagem |
| `ai/replies/[id]`, `ai/cases/[id]/reply`, `proposals/[id]/send`, `agenda/agendamentos/[id]/google/meet/deliver\|resend\|retry` | enviam ao cliente (D6) |
| `ai/cases/alerta`, `ai/cases/alerta/teste`, `agenda/aviso`, `agenda/aviso/teste` | configuram e testam aviso por WhatsApp |
| `ai/followups/enrollments` POST, `ai/followups/enrollments/[id]/resume\|skip` | agendam ou antecipam envio a um contato |
| `contacts/[id]/unblock` | desfaz o descadastro, que é regra do envio |
| `calls` POST, `voice/*` (fora as leituras) | ligação e chamada de voz em tempo real |
| `ai/followup-flows/[id]/publish\|rollback` | publicar e reverter seguem só na tela (comentário de `public-paths.ts`, #1875) |
| `ai/knowledge/chave`, `ai/knowledge/provedor`, `voip/trunk`, `agenda/google/connect\|callback\|desconectar` | chave, provedor e conexão |
| `channel-sessions/*` (toda escrita, mais `qr` e `pairing-code`) | conexão e pareamento do canal |
| `leads/[id]/conversion/retry`, `conversions/meta-clicks/[id]/retry` | reenviam conversão à plataforma de anúncio |
| `team/[user_id]`, `team/[user_id]/reactivate`, `team/[user_id]/interface` | acesso e perfil de pessoa da equipe |
| `settings/art15`, `contacts/[id]` DELETE, `contacts/export`, `conversations/[id]/export`, `audit/export` | LGPD e exportação de dado pessoal |
| `modulos`, `modulos/instalar` | administração de extensões |
| `campaign-suppressions`, `campaign-suppressions/[id]` | tirar alguém da lista faz a campanha voltar a escrever para quem pediu para parar |
| `audit`, `audit/export` | a auditoria mostra tudo de todos |
| `phone-numbers`, `phone-numbers/[id]` | a leitura só aceita sessão; a escrita mexe na conexão do canal |
| `channel-schedules`, `channel-schedules/[id]` (escrita) | a janela pausa canais do WhatsApp; desfazer exige a pausa manual em Conexões |
| `imports`, `imports/[id]` | entrada de contatos em massa, não se desfaz |
| `financeiro/comandas/[id]/finalizar`, `financeiro/comandas/[id]/estornar`, `financeiro/comandas/faturar-lote`, `honorarios/parcelas/[id]/pagar` | mexem com dinheiro, não se desfazem, e hoje nem aceitam token de integração |
| `ai/budget`, `ai/voz`, `ai/knowledge/reindex-all` (escrita), `contacts/merge` (escrita), `automation-rules` (escrita) | gastam dinheiro da organização ou não se desfazem; a escrita de `automation-rules` só tem área na leitura |

**Só de sessão por desenho**, porque o sujeito é a própria pessoa logada: `attendants/presence`,
`notifications/push`, `conversations/[id]/claim|release|mark-read`, `prospecting/agents/*` e
`prospecting/importar`.

**Ainda sem token**, porque a função do banco recusa quem não tem sessão (`auth.uid()` nulo): o PATCH de
`settings/routing/channels` (`fn_set_channel_routing`) e de `agenda/configuracao` (`fn_agenda_settings`),
`financeiro/comandas/[id]/finalizar|estornar`, `financeiro/comandas/faturar-lote` e
`honorarios/parcelas/[id]/pagar` (sem área também: `financeiro/comandas` inteiro está sem área, ver acima).
Liberar exige uma variante da função que receba o ator, numa fatia própria com migration.

O módulo pode gravar **rascunho** por `conversations/[id]/drafts`; quem envia é a pessoa.

**Papel efetivo.** É o **menor** entre o teto do token e o papel **atual** da pessoa, lido do banco na
própria requisição. Acima de `agent`, só com um JWT válido de pessoa real. Sem JWT, o teto é `agent`
(D4). O token de módulo nasce só com `mcp:read`, `role:viewer` e o ator: **não carrega escopo de rota**
(`mcp:write`, `config:*`). Para ele, o escopo exigido pela rota é atendido pela decisão de área e modo
(declarado ∩ consentido, lido do banco agora); o papel continua valendo.

**JWT de contexto.**

- Uma rota de sessão entrega à tela um JWT curto (até 5 minutos), com pessoa, organização e
  instalação. Ela passa por `requireRole`, então a verificação em duas etapas vale.
- O JWT é assinado com uma **chave assimétrica do host**, separada do segredo do HMAC. O host assina
  e só ele valida o JWT que volta numa chamada. O módulo, se quiser ler o JWT, verifica com a chave
  pública e não consegue fabricar um.
- JWT de outra organização ou instalação, vencido ou de pessoa que saiu da organização recusa com 403.

**Acompanhamento de suporte.** O estado é lido **no servidor, na requisição**, pela mesma regra de
`requireSupportWrite`, e não vem do JWT. Em acompanhamento, toda escrita é recusada.

**Atribuição.** O audit grava o token do módulo como ator e a pessoa em `metadata`, separados. É a
forma mais fiel que achei da frase "ação é atribuída pelo token do módulo e pelo papel real"; ver a
pergunta 1.

### F4 — Lugar na tela

É a decisão D7 da ADR.

- **Uma rota:** `/app/m/[modulo]`, com a tela do módulo em iframe de outra origem, com `sandbox` e
  sem cookie da sessão do CRM. A proteção contra enquadramento indevido fica no serviço do módulo.
- **Um grupo:** "Módulos" na navegação, gerado por uma entrada genérica. Sem módulo ativo, o grupo
  não aparece.
- **Painel lateral opcional:** um botão no topo e um item no ⌘K abrem o mesmo iframe ao lado da tela
  atual. A ADR fala só em rota e grupo; ver a pergunta 2.
- **Conversa com a tela** por `postMessage`, com origem conferida nos dois lados e lista fechada de
  mensagens: caminho atual, idioma, tema e marca, pedido de novo JWT e pedido para navegar a um
  destino do catálogo de navegação do host. O módulo nunca escolhe um endereço livre.
- **Serviço fora do ar:** a tela do CRM mostra o aviso e segue funcionando.
- **Microfone fica fora.** Quem precisar abre a própria página em janela nova, na origem dele.

### F5 — Eventos que o módulo precisa buscar

- `GET` por cursor opaco, com o token do módulo, só da organização da linha do token.
- Lista fechada e mínima: contato anonimizado, módulo desativado na organização e organização suspensa.
- O evento leva só identificadores. O módulo que guarda dado pessoal apaga ao ler `contato anonimizado`.
- **A LGPD não pode ficar presa.** Um módulo desativado ou de organização suspensa ainda precisa
  saber que deve apagar. Proposta: por 30 dias depois da revogação, a busca do token aceita um token
  que só lê esta rota, e nenhuma outra. Ver a pergunta 4.
- A instalação vê em `/admin/extensoes` o último cursor lido e quando foi. Módulo atrasado aparece ali
  (invariante 3 do Sistema Vivo).

### F6 — Atravessar a atualização

- Atualizar o CRM **nunca** depende de módulo conectado: ele não tem tabela no banco do CRM, então
  não entra na reaplicação (escolha 2 da ADR).
- Se a nova versão sair da faixa `host_api` do pacote, `checkCompatibility` já suspende na leitura. O
  grupo some, o token de módulo recusa com código próprio e a instalação vê o motivo em `/admin/extensoes`.
- **Rotas alcançadas por módulo viram contrato.** Um teste congela, por área, a lista de rotas e
  métodos liberados a módulo e o formato de entrada e de saída de cada uma (o schema Zod do corpo e
  das respostas). Tirar uma rota da lista ou mudar o formato de forma incompatível exige subir `host_api`.
- **O conjunto de áreas também é contrato.** Renomear ou tirar uma área exige subir `host_api`.

### R — Converter as rotas, por área

É independente de F1 a F6, serve a qualquer integrador e já é o caminho aceito. Pode começar antes.

| Fatia | Áreas | Rotas no recorte | Já aceitam token | A converter |
|---|---|---|---|---|
| **R0** | invariante "rota com `resolveAuthDual` tem entrada em `PUBLIC_PATHS` ou justificativa escrita", com as 3 rotas barradas e a 1 que recusa por desenho | 4 | — | 3 + 1 justificativa |
| **R1** | configuração: `ai`, `pipelines`, `settings`, `tags`, `products`, `message-templates`, `message-template-groups`, `automation-rules`, `channel-schedules`, `attendants`, `team` | 138 | 12 | 111 rotas (158 métodos) |
| **R2** | operação: `contacts`, `leads`, `conversations`, `agenda`, `tasks`, `proposals`, `financeiro`, `honorarios`, `companies`, `people`, `company-people`, `phone-numbers`, `campaigns`, `campaign-templates`, `campaign-suppressions`, `demandas`, `contact-tags`, `conversation-tags`, `prospecting`, `notifications`, `lead-captures`, `calls`, `voip`, `conversions` | 163 | 10 | 122 rotas (171 métodos) |
| **R3** | leitura e análise: `metrics`, `reports`, `ads`, `anuncios`, `audit`, `channel-sessions`, `external-db` (fora as conexões), `voice`, `imports`, `modulos`, `rastreio`, `messages` (fora as 4 negadas) | 47 | 0 | 28 rotas (31 métodos) |

"A converter" já desconta a lista de negação inteira da F3, as rotas só de sessão por desenho, as que
ainda dependem de função com sessão, as 3 da R0 e as 3 já públicas por desenho (`anuncios/google/[org]`,
`anuncios/meta/[org]`, `rastreio/[id]`). Cada fatia vira vários PRs pequenos, de uma área por vez.

**Cada rota convertida:**

1. usa `resolveAuthDual` com papel e escopo iguais aos da tool MCP equivalente, quando houver;
2. tem porta no proxy: o caminho da pasta da rota em `lib/auth/portas-de-token/<fatia>.ts`, que
   `portaDeToken` transforma em entrada de `PUBLIC_PATHS` ancorada nos dois lados e com o id em forma de
   UUID;
3. filtra `organization_id` à mão em toda consulta, porque o ramo do token usa o cliente admin;
4. aplica `tetoDeEscritaDoToken` se escreve e `requireSupportWrite` antes do efeito;
5. confere que `…_by_user_id` não recebe id de token;
6. ganha teste de token aceito, escopo faltando, papel abaixo do mínimo, teto e **token da organização B
   lendo ou alterando recurso da organização A**, com o cliente falso de duas organizações
   (`tests/unit/helpers/cliente-admin-falso.ts`), em `tests/unit/token-por-area/<área>.test.ts`.

### Como medir o recorte

A medição lista `app/api/v1/**/route.ts` na `main`, tira os prefixos e a lista de negação acima e, para
cada rota, verifica se chama `resolveAuthDual` ou `validateBearerToken`, se tem entrada em
`public-paths.ts` (testando a URL com um UUID no lugar de cada parâmetro) e se exporta POST, PATCH, PUT
ou DELETE. A tabela da R e o parágrafo do recorte saem dela. A R0 já cobra parte disso como cerca
(`tests/unit/rotas-bearer-tem-porta-no-proxy.test.ts`); a F6 traz o resto para `scripts/` como teste.

## Fora desta spec (de propósito)

- Envio de mensagem por módulo (D6).
- Tabelas no banco do CRM para módulo conectado: quem precisa de dado no CRM usa o perfil `data`.
- Vitrine, preço, SDK e guia de autoria (onda O4), e runtime `hosted` (O5).
- `module_tool` e `module_action`: módulo chamado pelo agente ou por automação entra na fronteira do
  caminho quente e pede outra spec.
- Chamada do CRM para o serviço do módulo.
- Chave geral que faça todas as rotas aceitarem token de uma vez. Foi avaliada e recusada: com o
  cliente admin no ramo do token, cada rota sem filtro manual de `organization_id` viraria vazamento
  entre empresas, e nenhum teste pegaria isso sem medir rota por rota.
- Sessão delegada, em que o módulo age com a sessão da pessoa. Recusada: contraria a linha "JWT de
  contexto usado para atribuir ação" da ADR.

## Como provar

Todo teste de banco roda contra Postgres real do `baseline.sql`, e cada um tem uma sabotagem prevista:
tirar a linha da regra e ver o caso ficar vermelho.

| O que precisa ser verdade | Prova | Sabotagem que a deixa vermelha |
|---|---|---|
| Token de A nunca alcança dado de B | teste da área com o cliente falso de 2 organizações, para cada método convertido | tirar o filtro de `organization_id` da rota |
| Rota com token e sem porta no proxy reprova | teste R0 | tirar um modelo de `lib/auth/portas-de-token/` ou uma entrada de `public-paths.ts` |
| Desativar revoga na mesma transação | invariante | revogar fora da transação |
| Teto cheio não deixa ativação pela metade | invariante com 50 tokens vivos | criar o token depois de gravar a ativação |
| HMAC repetido recusa | caso com o mesmo nonce duas vezes | não guardar o nonce |
| Busca nova invalida o token anterior | caso direto | não revogar o anterior |
| Girar o segredo invalida o antigo | caso direto | aceitar os dois |
| Consentir menos vale | caso de área negada, com 403 | ignorar o consentimento no resolvedor |
| JWT nunca aumenta poder | token admin + JWT de `viewer` recusa escrita; token `viewer` + JWT de admin recusa | usar o papel do JWT |
| JWT forjado recusa | JWT assinado com o segredo do HMAC ou com outra chave | aceitar qualquer assinatura |
| Sem JWT, o teto é `agent` | caso direto | tirar o teto |
| Pessoa removida perde na hora | remover a pessoa e repetir com o JWT ainda válido | ler o papel do JWT em vez do banco |
| Suporte não escreve | escrita durante o acompanhamento recebe 403 | ler a marca do JWT em vez do servidor |
| Módulo não alcança credencial, acesso de pessoas, LGPD ou envio | varredura da lista de rotas por área contra a lista de negação | incluir uma rota negada numa área |
| Nada do caminho quente chama módulo (D6) | varredura de AST: ingestão, dreno, turno e envio não importam código de módulo | importar o cliente do módulo no dreno |
| Interruptor local (D8) | desligar na instalação: token recusa e grupo some | ignorar o interruptor no resolvedor |
| Evento de LGPD chega a módulo desativado | desativar e ler o evento de anonimização | recusar o token só de eventos |
| Rotas e formatos são contrato | teste congelado da F6 | mudar o schema de uma rota liberada |
| Áreas são contrato | teste congelado da F6 | renomear uma área |
| Zero módulos | e2e sem módulo: nenhum grupo, nenhum botão, operação inteira | renderizar o grupo vazio |
| Serviço fora do ar | e2e derrubando o serviço: aviso na tela e atendimento segue | deixar o erro subir ao layout |
| Atualização fora da faixa | suspende, avisa e o token recusa | não reavaliar a compatibilidade |
| Atualizar não depende de módulo | `tests/shell` com módulo instalado e serviço fora do ar | fazer o `update.sh` consultar o módulo |

**Prova pela tela (J novo em `docs/testing/user-journey-map.md`):** em banco fresco, com as variáveis
opcionais ausentes e um serviço de exemplo em processo separado (origem loopback, pela exceção de
laboratório que já existe):

1. admitir o catálogo, instalar e ver o segredo uma vez;
2. ativar numa organização, consentindo menos do que o pacote pede;
3. abrir a tela, ver os dados e tentar uma ação da área negada;
4. entrar como `viewer` e ver a escrita recusada;
5. revogar pela tela de tokens e ver o módulo parar;
6. desligar na instalação e ver o grupo sumir;
7. derrubar o serviço e confirmar o CRM inteiro.

## Sistema vivo

1. **Quem me alimenta:** a instalação, a ativação e a tela que pede o JWT.
2. **Quem eu alimento:** o serviço do módulo e as rotas do host, que continuam sendo a única porta de efeito.
3. **Registro:** `api_audit_log` com ator `module` e pessoa em `metadata`, e recibos em `extension_operations`.
4. **Onde apareço:** grupo "Módulos", painel, `/admin/extensoes`, tela de tokens e `/app/audit`.
5. **Porta:** a entrada genérica em `lib/navigation/catalogo.ts`.
6. **Anti-morte:** módulo suspenso, desligado ou fora do ar aparece na tela. Nenhuma demanda do
   atendimento depende dele.
7. **Configuração:** ativação, consentimento e revogação na tela da organização; instalação,
   interruptor e giro do segredo em `/admin/extensoes`.
8. **Continuidade IA↔humano:** não se aplica, porque o módulo fica fora do turno e só grava rascunho.
9. **Laço de retorno:** evento atrasado e recusa de token aparecem para quem administra, e a
   organização pode reduzir o consentimento.
10. **Mapa:** `docs/architecture/extensoes-declarativas.architecture.json`.

## Destino

**Ambos**, pela régua da doutrina. O ponto é núcleo: token, autoridade, tela genérica e rotas. Quem
consome é um módulo, e se nenhuma organização ativar, a operação comum continua inteira. As fatias R
são núcleo por si só, porque servem a qualquer integrador.

## Decisões onde a ADR não decide

Esta spec não espera resposta para começar. Onde a ADR-0005 é omissa, a decisão está tomada abaixo, com
o motivo. Cada uma vale até a revisão do PR que a implementa, e o mantenedor pode trocá-la ali.

1. **A pessoa vai em `metadata` do audit, e o ator é o token.** A ADR recusa "JWT de contexto usado
   para atribuir ação". Aqui o JWT só reduz o papel. Sem a pessoa registrada, a auditoria não diz por
   que a ação foi permitida.
2. **O painel lateral entra como entrada genérica fechada, dentro da D7.** Um módulo de apoio só faz
   sentido ao lado da tela em que a pessoa está.
3. **O token de módulo tem `created_by` nulo e a instalação como dona,** com uma CHECK que exige um
   dos dois. Com quem ativou como dono, o `ON DELETE RESTRICT` prenderia a conta dessa pessoa.
4. **Depois da revogação, por 30 dias, vale um token que só lê eventos.** Sem ele, um módulo desativado
   nunca fica sabendo de uma anonimização. A outra saída seria o módulo apagar tudo da organização ao
   ser desativado, o que perde dado numa desativação por engano.
5. **`configuracao` e `agentes_ia` só podem ser consentidas por quem administra a
   organização,** e a doutrina de extensões registra isso. Essas áreas mudam operação do núcleo (ou o
   dinheiro dela), mesmo com credencial, acesso de pessoas e envio fora. A área `financeiro` não nasce
   agora (#4142, item 4).
6. **A prova de aceite da O2 é um serviço de exemplo no repositório,** rodando no CI. A ADR pede "um
   módulo de pagamento real", mas o pagamento está indo para o núcleo: a #3509 é uma issue aberta, e
   o PR #3590 está em andamento.
7. **A O2 anda antes de fechar a O1b.** F1 a F6 não usam escrita, telas declaradas nem compilador. Da
   O1b, só entram aqui a rota `/app/m/[modulo]` e o grupo "Módulos".
8. **As rotas são convertidas em PRs pequenos, uma área por vez.** São 261 rotas (360 métodos), e um PR
   único seria impossível de revisar. Toda leitura convertida também passa pelo teto do token, como a
   rota de foto do contato (`contacts/[id]/avatar`) já faz, porque a cerca de #1999 o exige em toda rota
   com `resolveAuthDual`.
9. **A F1 não sobe `host_api`** (ver a emenda na seção F1). A próxima subida fica para a F6, e se o
   #3477 entrar antes, ele traz a `main` e sobe do número que encontrar.
