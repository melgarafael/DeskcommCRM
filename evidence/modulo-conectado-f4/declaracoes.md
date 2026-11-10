# Módulo conectado F4: declarações do PR

Declaração do PR da F4 (o lugar do módulo conectado na tela: quadro em iframe de outra origem, ponte de
seis mensagens, grupo "Módulos" no menu e no Ctrl+K, painel lateral). Cada afirmação traz o comando que a
produz. Nada aqui foi executado nesta máquina: o veredito é o CI do PR interno.

## Destino (item 18 do Definition of Done)

**Núcleo e extensão (conector).** O núcleo ganha o lugar onde a tela de um módulo conectado aparece e a
ponte combinada; o conteúdo da tela é do módulo, fora do CRM.

Pergunta-raiz: *se nenhuma organização ativar um módulo conectado, a operação comum continua inteira?*
Sim. Sem módulo, a lista que alimenta o menu é vazia e a saída de `sidebarGroups` e `searchable` é a
mesma de antes (`tests/unit/navegacao-modulos.test.ts`); o botão do painel não existe
(`components/modulo/PainelDoModulo.test.tsx`); `/app/m/<slug>` responde 404
(`app/app/m/[modulo]/page.test.tsx`). Quem não usa módulo não passa por nada disso.

## Tela (item 14)

- **Tela nova:** `/app/m/<slug>` (`app/app/m/[modulo]/page.tsx`), uma por módulo ativo, gerada. A rota
  dinâmica entrou na completude de navegação com justificativa escrita (rota gerada, uma entrada por
  módulo ativo), sem exceção genérica (`grep -n "m/\[modulo\]" tests/unit/navegacao-completude.test.ts`).
- **Porta:** grupo "Módulos" no menu e na barra inferior, item no Ctrl+K, botão no topo
  (`components/shell/TopBar.tsx`) para o painel lateral.

## Env nova (item 9)

Nenhuma. A F4 não lê variável de ambiente nova.

## Migrations (tripla)

Nenhuma. A F4 não muda o schema (`git diff --stat origin/main -- supabase` fica sem linha nova da F4).

## Segurança da moldura, o que o código garante

- O iframe tem exatamente `sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox
  allow-same-origin"`, `referrerPolicy="no-referrer"` e `allow=""` (sem câmera, microfone nem localização).
  `allow-same-origin` vale para a origem DO MÓDULO, que nunca é a do CRM: `modulosNaTela` descarta o
  módulo cuja origem é a do CRM (`lib/extensions/modulos-na-tela.ts`).
- A URL do iframe leva só `organization` e `installation`; JWT, token e segredo nunca vão na URL.
- A ponte é uma lista fechada de seis mensagens (`lib/modulo/ponte.ts`): do módulo ao CRM `module:ready`,
  `module:request-jwt`, `module:navigate`; do CRM ao módulo `host:context`, `host:jwt`, `host:error`.
  Mensagem só vale se vier da origem do serviço E da janela daquele iframe, com campos exatos.
- O CRM sempre envia com `targetOrigin` igual à origem do serviço, nunca "*".
- `module:navigate` leva um id, não um endereço, e só resolve entre as telas que a pessoa vê; outra coisa
  é ignorada em silêncio.
- No máximo um pedido de JWT a cada 30 s; o seguinte recebe `host:error` com `rate_limited`.
- O navegador só leva `slug` e `titulo` do módulo (`modulos_conectados` do `ActiveOrg`); o endereço do
  serviço e o id da instalação ficam no servidor.
- **Cerca:** `tests/unit/modulo-quadro-so-pela-ponte.test.ts` varre o repositório (sem comentários) e
  quebra se outro arquivo escrever um iframe de módulo, se um `postMessage` de `components/modulo/` usar
  "*", se outro arquivo de `components/` importar a ponte, se o Quadro perder um atributo fechado ou se
  `serviceOrigin`/`installationId` entrarem no `ActiveOrg`. Há um iframe antigo e sem relação com módulo
  (`components/kanban/FileUploadCustomField.tsx`, pré-visualização de anexo PDF), listado na cerca.

## Painel lateral: decisão de desenho

O painel **não** abre o CRM dentro do CRM. Ele pede o módulo pelo slug à Server Action `moduloParaOPainel`
(`app/actions/modulo/moduloParaOPainel.ts`), que confere sessão, organização e papel pela mesma fonte da
rota e devolve só aquele módulo; depois desenha o **mesmo** `QuadroDoModulo`. Um só caminho de segurança.
Um iframe do próprio CRM exigiria relaxar `X-Frame-Options: DENY` e carregar o layout inteiro dentro do
painel. **Nenhum header foi alterado** (`git diff origin/main -- next.config.ts` fica vazio).

## Contrato do `/embed` para quem escreve o módulo

O serviço do módulo serve `/embed` em sua própria origem. O CRM abre `/embed?organization=<uuid>&installation=<uuid>`.
Combinado: o módulo recebe do CRM **texto JSON** e precisa fazer `JSON.parse` do que chega em `event.data`;
o módulo envia **objetos** (não texto) com `window.parent.postMessage(objeto, <origem do CRM>)`. O módulo
manda `module:ready` quando estiver pronto; só então recebe `host:context`. Para o JWT, manda
`module:request-jwt` e espera `host:jwt` (ou `host:error`). Não há `host:resize` nem outra mensagem; o
quadro ocupa a altura da tela.

## Living System Checklist (item 13)

1. **Quem me alimenta.** O catálogo (`service_origin`), a ativação e o consentimento da F3
   (`lib/extensions/modulos-na-tela.ts`); a pessoa na tela, por meio do menu, do Ctrl+K e do botão do topo.
2. **Quem eu alimento.** A pessoa na tela, que vê a ferramenta do módulo; o módulo, que recebe contexto e
   JWT pela ponte; a rota de contexto da F3, chamada em `module:request-jwt`.
3. **Registro que emito.** O audit da F3 já cobre as chamadas que o módulo faz depois (com
   `metadata.module` e `person_id`). A F4 não grava registro novo: abrir uma tela não muda dado.
4. **Onde apareço na tela.** Em `/app/m/<slug>`, no painel lateral e no aviso de serviço fora do ar.
5. **Por qual porta se chega.** Grupo "Módulos" no menu e na barra inferior, Ctrl+K (um item por módulo para
   abrir a página e um "Abrir ao lado" por módulo para o painel) e o botão no topo.
6. **Anti-morte.** Módulo que não responde: em 10 s aparece "O serviço deste módulo não respondeu", e o
   resto do CRM segue. A pessoa nunca fica diante de um quadro em branco sem explicação.
7. **Onde se configura.** Não há configuração nova: ativar e consentir é na tela da F3 (`/admin/extensoes`).
8. **Continuidade IA↔humano.** Não se aplica: a F4 não cria agente.
9. **Laço de retorno.** Fecha no host: `host:error` com código fechado ao módulo, e o aviso visível à
   pessoa (e portanto ao admin que a acompanha). **Dívida declarada:** o que o módulo faz ao receber
   `host:error` fica fora do sistema e nenhum teste desta branch mede esse comportamento.
10. **Mapa.** `docs/architecture/extensoes-declarativas.architecture.json` ganha quatro nós
    (`module_frame`, `module_bridge`, `module_nav_group`, `module_panel`) e nove arestas.
    Verificação: `Get-Content -Raw docs/architecture/extensoes-declarativas.architecture.json |
    ConvertFrom-Json` lê sem erro, e cada nó novo tem pelo menos duas arestas.

## Fragmento de release

`.changes/modulo-conectado-tela.md`, `impacto: capacidade_nova`, `secao: adicionado`. Nenhuma ação do
operador. Sem seção no `CHANGELOG.md`.

## Medido e não medido

**Medido nesta tarefa (leitura, não execução):** o JSON de arquitetura foi relido e cada nó novo foi
contado nas arestas (frame 5, bridge 4, nav_group 2, panel 2); a cerca foi escrita lendo o
`QuadroDoModulo.tsx`, `lib/auth/types.ts` e os iframes e `postMessage(` existentes por busca no código.

**NÃO medido:**

- **Nada foi executado nesta máquina.** Nenhum `pnpm`, `vitest`, typecheck, lint, build, Docker ou
  Playwright. A cerca nova também não foi rodada: o veredito é o CI do PR interno.
- **Módulo real:** nenhum serviço de verdade falou a ponte. J71 é especificação, todos os casos
  "NÃO EXECUTADO".
- **Navegador de verdade:** nenhum teste abriu a tela. Comportamento do sandbox, de pop-ups e de
  `postMessage` entre origens reais só foi testado com simulação de jsdom.
- **CSP inexistente:** o CRM não define `Content-Security-Policy`, então a moldura não foi medida contra
  uma. `frame-src`/`frame-ancestors` ficam fora de escopo.
- **Painel em celular:** abaixo de 768 px o painel vira a rota; não foi visto em aparelho real.
- **`Esc` com o foco dentro do iframe:** a tecla vai ao iframe e não chega ao CRM; o painel fecha pelo
  botão ou com o foco fora do quadro. Não foi medido, é comportamento conhecido do navegador.
- **Coluna de CI da J71** foi montada a partir dos nomes e da intenção dos testes das tarefas anteriores;
  cada teste não foi relido caso a caso nesta tarefa.
- **Espelho `.claude/skills` não regenerado:** a F4 não tocou o guia `deskcomm-extensao`.
