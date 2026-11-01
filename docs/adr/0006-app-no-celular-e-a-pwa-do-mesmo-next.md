# ADR-0006 — O app no celular é a PWA instalada a partir do mesmo Next.js

- **Status:** aceito em 2026-10-20 pelo dono do produto, com as decisões (a)…(e) da seção *Decisões do dono*
- **Data:** 2026-10-20
- **Contexto medido em:** `b89b5a085` (topo de `origin/main` em 20/10/2026)
- **Doc que muda junto:** [`docs/design-system/screen-flow/07-responsive-strategy.md`](../design-system/screen-flow/07-responsive-strategy.md) — a premissa de foco ("mobile não é foco") deixa de valer

---

## Contexto

Membros da comunidade pedem um app para os atendentes: abrir pelo ícone, receber o aviso de
mensagem nova com o navegador fechado e responder dali. A pergunta não é "temos app?", e sim
"o que falta para o que já existe virar um app".

O que já existe, conferido em `b89b5a085` (os caminhos são a régua — reconfira antes de citar):

| Peça | Onde | Estado |
| --- | --- | --- |
| Manifest com a marca da instalação | `app/manifest.ts` | `display: standalone`, `start_url: /app`, nome de `marcaDaSaida()`; dinâmico porque a imagem é construída sem marca |
| Ícone do app em runtime | `app/app-icon/[size]/route.ts` + `lib/branding/icone-do-app` | 192 e 512 px, desenhados da marca da instalação |
| Service worker de notificação | `public/notify-sw.js`, registrado por `lib/notifications/service_worker.ts` | bandeja, clique que abre a conversa, evento `push` |
| Web Push | `lib/notifications/web_push.ts`, `lib/notifications/vapid.ts`, `app/api/v1/notifications/push/route.ts`, `lib/notifications/push_client.ts` | funciona quando o par `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` está no `.env`; o kit grava o par **vazio** (`hostgator-setup-kit/install.sh`) e o `update.sh` não o gera |
| Tela de avisos | `app/app/settings/notifications/page.tsx` | diz a verdade sobre o push estar ou não disponível (`vapidPronto()`) |
| Casca de celular | `components/shell/BarraInferior.tsx` (barra de abas), `components/shell/MobileSidebar.tsx`, `lib/ui/rodape-ocupado.tsx`, `viewportFit: "cover"` em `app/layout.tsx` | safe-area, piso de 44 px; medição em `evidence/celular-quase-nativo-20261005/LEIA.md` |

Ou seja: o produto já é quase uma PWA instalável. Faltam peças de acabamento (par VAPID que
nasce com a instalação, ícone do iPhone, manifest completo, um caminho guiado para instalar) e
telas que hoje funcionam no celular mas não foram desenhadas para o toque.

Duas restrições de plataforma moldam o espaço de soluções:

1. **Service worker e Web Push exigem contexto seguro (HTTPS).** Uma instalação acessada por
   `http://IP` não pode ter app instalado nem push, por regra do navegador, não nossa.
2. **No iPhone, Web Push só existe para o site adicionado à tela de início** (iOS 16.4+), e o
   Safari exige que todo push recebido mostre uma notificação.

## Decisões

### D1 — Uma PWA, servida pelo mesmo Next.js e pelas mesmas rotas `/app`

O app instalado é o próprio produto aberto em janela própria. Mesma imagem Docker, mesma
autenticação, mesmas rotas, mesmo registro de navegação (`lib/navigation/registry.ts`). Uma
tela nova feita para o laptop aparece no celular no mesmo deploy, e vice-versa.

### D2 — Sem rotas paralelas de celular (`/m/*`)

A tela se adapta por largura e por tipo de ponteiro (`pointer-coarse`), como a casca já faz.
Não existe um segundo conjunto de páginas para manter em paralelo.

### D3 — Um service worker escrito à mão, sem gerador

`public/notify-sw.js` continua sendo o único service worker. Nada de Serwist, `next-pwa` ou
outro plugin que gere SW no build.

### D4 — Nenhum dado de atendimento guardado no aparelho

O SW não faz cache de API, de HTML autenticado nem de mídia. A única coisa que ele responde
sozinho é uma **página offline neutra** — sem nome de contato, sem texto de mensagem — quando
uma navegação falha por falta de rede. Requisições que não são navegação passam direto.

### D5 — Ícone e nome do app são os da instalação

O manifest e o ícone continuam saindo de `platform_branding` (via `marcaDaSaida()` e
`marcaDaInstalacao()`), nunca de `organizations.settings.branding`. Ver decisão (d).

### D6 — O par VAPID nasce com a instalação e nunca é trocado

O kit gera o par na instalação e, no `update.sh`, gera **só se estiver vazio**. Nenhum script
regrava um par existente: trocar a chave invalida a inscrição de todo aparelho já instalado, e
cada atendente teria de reativar os avisos à mão. Operador não edita `.env` para ter push
(doutrina de packaging, `docs/doctrine/packaging.md`).

## Alternativas recusadas

| Alternativa | Por que não |
| --- | --- |
| **App nativo** (React Native, Expo, Swift/Kotlin) | Segunda base de código para um time que já mantém uma. E colide com a marca própria: um binário de loja carrega um nome e um ícone fixos, enquanto cada instalação tem os seus — seria um build por revendedor, o oposto de "uma imagem serve todas as marcas" |
| **Wrapper ou TWA agora** (Capacitor, Bubblewrap) | Só se justifica com presença em loja, que a decisão (e) deixou fora da primeira versão. Exige vínculo de domínio por instalação e build por marca. Fica como caminho aberto **depois** da F1, se a demanda por loja aparecer — a PWA é a base que um TWA embrulha, nada se perde |
| **Rotas `/m/*`** | Duas árvores de telas divergem na primeira feature que só uma recebe; duplica o registro de navegação e o teste de completude. A casca responsiva já resolve o layout |
| **Gerador de SW** (Serwist, `next-pwa`) | O valor deles é o precache e as estratégias de cache — exatamente o que D4 proíbe. Sobraria uma dependência acoplada ao build para gerar um arquivo que cabe em cem linhas lidas por humano |
| **Offline de verdade** (fila de envio, conversas no aparelho) | O atendimento depende do servidor: o envio passa pelo WhatsApp com cadência controlada, e uma fila no aparelho reenviando ao voltar a rede pode mandar fora de hora ou em dobro. E dado de contato no aparelho é dado pessoal fora do controle da instalação. A página offline neutra cobre o caso real (metrô, elevador) |
| **Afrouxar `SameSite` do cookie de sessão** | O cookie é `SameSite=Strict` por doutrina (`CLAUDE.md`, *Stack canônica*), e nada na PWA precisa de outra coisa: o app abre na própria origem. Se algum fluxo parecer pedir isso, a resposta é uma tela intermediária na origem, não mudar o cookie |

## Decisões do dono (2026-10-20)

- **(a) Conteúdo na tela bloqueada é configurável por empresa.** O padrão é **o nome do
  contato, sem o texto da mensagem**. A empresa pode escolher mostrar mais ou menos.
- **(b) Várias empresas no mesmo aparelho, ou um celular compartilhado entre atendentes, fica
  para uma fase posterior.** A primeira versão assume um atendente por aparelho.
- **(c) Instalação em `http://IP`, sem cadeado, fica sem app** — e a tela diz isso com clareza,
  em vez de oferecer um botão que não funciona.
- **(d) Ícone e nome do app são os da INSTALAÇÃO**, não da organização (D5).
- **(e) Sem presença em loja (Play Store) na primeira versão.**

## Fases

| Fase | Nome | O que entra |
| --- | --- | --- |
| **F0** | Avisos certos | O que já se envia hoje passa a respeitar a decisão (a); o clique no aviso abre a conversa certa; a tela de avisos diz o que está e o que não está disponível naquela instalação |
| **F1** | Instala e avisa | Par VAPID gerado pelo kit e nunca rotacionado (D6); manifest completo (`id`, `description`, cores, ícone `maskable`); ícone do iPhone (`apple-touch-icon`, que o `app/layout.tsx` ainda não declara); tela de instalação guiada, por sistema (Android, iPhone), com o aviso da decisão (c); SW que **sempre** mostra a notificação ao receber push — hoje `public/notify-sw.js` não mostra quando há janela visível, e o Safari exige que todo push vire notificação; página offline neutra (D4) |
| **F2** | Atende pelo celular | Conversa em tela cheia; composer pensado para toque (teclado virtual, anexo, áudio); botão voltar coerente entre lista e conversa; gravação e reprodução de áudio no iPhone; reenvio de mensagem que falhou |
| **F3** | Funil e agenda | Mover lead de etapa sem arrastar (menu de toque); "minhas tarefas"; contatos em cartão |
| **F4** | Gestor e acabamento | Telas do gestor no celular; acabamento das superfícies que sobrarem |

**Critério de pronto da F1 inclui aparelho real.** O CI não tem par VAPID nem celular, então
`e2e` verde não prova que o aviso chega. A F1 só fecha com evidência em `evidence/<data>-<entrega>/` (versionado)
de, num **Android real** e num **iPhone real** (app adicionado à tela de início), numa
instalação HTTPS fresca: instalar pelo caminho guiado, abrir pelo ícone com a marca da
instalação, receber o aviso com o app fechado e a tela bloqueada mostrando o que a decisão (a)
manda, e tocar no aviso para cair na conversa.

## Consequências

- **O celular vira superfície de primeira classe para o atendente.** Configuração pesada
  continua desenhada para tela grande, mas nunca bloqueada no celular. O doc 07 foi revisto
  junto com esta ADR.
- **Uma base, um deploy.** Nenhuma tela nova precisa de versão "mobile" separada; precisa ser
  provada também em largura de celular.
- **A F1 mexe no kit.** Gerar o par VAPID no `install.sh` e no `update.sh` cai na regra 15 da
  *Definition of Done*: a mudança tem de chegar a quem já instalou sem edição manual, e roda
  `pnpm test:shell`. Ela muda o que o operador vê, então leva fragmento em `.changes/`.
- **Instalação sem HTTPS não tem app nem push** — e passa a saber disso pela tela, não por
  tentativa.
- **Sem loja, sem conta de desenvolvedor por revendedor.** Se a loja vier, entra como embrulho
  (TWA) sobre esta mesma PWA, numa decisão nova.
- **O que fica de fora até nova decisão:** várias empresas por aparelho (b), offline de dados,
  app nativo.
