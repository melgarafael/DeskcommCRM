# Módulo conectado F5: declarações do PR

Declaração do PR da F5 (os eventos que o módulo conectado busca por cursor: contato anonimizado, módulo
desativado e organização suspensa; e o atraso visível em `/admin/extensoes`). Nada aqui foi executado
nesta máquina: o veredito é o CI do PR interno.

## Destino (item 18 do Definition of Done)

**Núcleo e extensão (conector).** O núcleo ganha os fatos, a tabela, a leitura por cursor e a tela do
dono do servidor; o que fazer com cada fato (apagar os dados do contato, parar de operar) é do módulo,
fora do CRM.

Pergunta-raiz: *se nenhuma organização ativar um módulo conectado, a operação comum continua inteira?*
Sim. Os gatilhos só escrevem uma linha pequena; a rota só é chamada por um módulo assinado; sem módulo
conectado `/admin/extensoes` não lê atraso nem mostra bloco novo
(`app/admin/(protected)/extensoes/page.test.tsx`). Os gatilhos de vínculo e de instalação só emitem para
módulo `connected`.

## Tela (item 14)

Sem tela nova. `/admin/extensoes` (já existente) ganha, por instalação `connected`, o bloco "Leitura dos
avisos pelo módulo": por vínculo, o último aviso lido, quando, quantos faltam, o selo "Atrasado" e a
frase da LGPD ("Este módulo ainda não apagou os dados de N contato(s) anonimizado(s)."). A empresa não é
nomeada: a tela mostra "Empresa 1", "Empresa 2".

## Banco e rota (itens de schema)

- Migration `9120` (tabelas `extension_module_events` e `extension_module_cursors`, quatro gatilhos,
  `fn_extensions_events_allowed|read|ack`) e `9121` (`fn_extensions_events_lag`), as duas com apêndice
  idempotente no `supabase/baseline.sql`, linha `-- manifest:` e `revoke ... from public, anon,
  authenticated` com `grant` só a `service_role`.
- Tabelas com RLS ligada e nenhuma policy: só o servidor lê.
- Rota `GET /api/v1/extensions/events`, em `lib/auth/public-paths.ts` pelo caminho exato, com rate limit.
  Não audita (só leitura) e não exige `requireSupportWrite(` (GET).
- Gatilho nunca faz HTTP: escreve uma linha em `extension_module_events` e o módulo busca.

## Decisões do plano, para a nota do PR (o mantenedor pode trocá-las)

- **D1 — a leitura é assinada, não por bearer.** A spec fala em "token do módulo", mas um token revogado
  não autentica e criar um segundo tipo mexeria em `api_tokens`, no teto de 50 e em todas as portas. A
  assinatura HMAC `X-Module-*` da busca de token já existe, tem nonce e janela de 5 min, e prova o mesmo.
  A prova foi extraída para `lib/extensions/prova-do-modulo.ts` e usada pelas duas rotas.
- **D2 — quem pode ler.** Vínculo ligado com instalação ativa, **ou** `module_disabled` do par nos últimos
  30 dias. Organização suspensa continua lendo, porque o evento de suspensão precisa chegar.
- **D3 — eventos são da organização.** Cada linha leva `organization_id`; `module_disabled` leva
  `installation_id` e só o par certo o lê; o corpo leva só identificadores.
- **D4 — `organization_suspended` também sai quando o status vira `redacted`.** A spec lista só
  "suspensa"; a LGPD apaga a organização e o módulo precisa saber.
- **D5 — sem expurgo nesta fase (fora de escopo).** A linha tem cerca de 100 bytes e só identificadores.
  Dívida declarada: expurgo por idade (mínimo 1 ano) fica para quando houver medição de volume.

Desvio de execução da T3 (declarado): `fn_extensions_events_lag` (9121) existe porque ler as tabelas por
PostgREST na tela esbarraria nas cercas de tenant do admin client; a função devolve números e datas, sem
organização.

## Cerca

`tests/unit/eventos-do-modulo-so-por-prova.test.ts` lê arquivos (sem banco) e quebra se: outro arquivo de
código além de `lib/extensions/eventos-do-modulo.ts` citar as tabelas de eventos ou de cursor; a rota sair
de `lib/auth/public-paths.ts` ou entrar por padrão largo; as migrations 9120 e 9121 ou o apêndice do
baseline chamarem `net.http_*`, `pg_net`, `http_post` ou `http_get`; alguma `fn_extensions_event*` criada
nesta fase ficar sem `revoke` de `public, anon, authenticated`.

## Living System Checklist (item 13)

1. **Quem me alimenta.** Os fatos do CRM: anonimização de contato (LGPD), desativação do módulo
   (ativação) e suspensão da organização; a assinatura do módulo que busca.
2. **Quem eu alimento.** O módulo, que recebe os avisos e age; o admin do servidor, que vê o último
   cursor e o atraso em `/admin/extensoes`.
3. **Registro que emito.** Cada fato vira uma linha em `extension_module_events`; o cursor lido fica em
   `extension_module_cursors`. A leitura não audita (só leitura); as mutações que geram os fatos já têm
   o audit delas.
4. **Onde apareço na tela.** Em `/admin/extensoes`, no bloco de cada módulo conectado.
5. **Por qual porta se chega.** A tela de extensões da instalação, que já tem porta no menu do painel.
6. **Anti-morte.** Módulo parado: o atraso cresce e aparece o selo "Atrasado" passadas 24 h; um módulo
   desligado ainda lê por 30 dias, para a LGPD não ficar presa.
7. **Onde se configura.** Não há configuração nova.
8. **Continuidade IA↔humano.** Não se aplica: a F5 não cria agente.
9. **Laço de retorno.** O selo "atrasado" muda a decisão de quem administra (cobrar o módulo, desligar,
   avisar o cliente). **Dívida declarada:** o que o módulo faz ao ler um evento fica fora do sistema; só o
   cursor prova que ele leu, não que apagou.
10. **Mapa.** `docs/architecture/extensoes-declarativas.architecture.json` ganha três nós
    (`module_events_table`, `module_events_route`, `module_events_cursor`) e sete arestas. Verificação:
    `Get-Content -Raw docs/architecture/extensoes-declarativas.architecture.json | ConvertFrom-Json` lê
    sem erro, e cada nó novo tem pelo menos duas arestas.

## Fragmento de release

`.changes/modulo-conectado-eventos.md`, `impacto: capacidade_nova`, `secao: adicionado`. Nenhuma ação do
operador. Sem seção no `CHANGELOG.md`. Jornada: J71 (todos os casos "NÃO EXECUTADO").

## Medido e não medido

**Medido nesta tarefa (leitura, não execução):** o JSON de arquitetura foi relido por `node` e cada nó
novo foi contado nas arestas (table 2, route 5, cursor 2); a entrada exata da rota existe em
`lib/auth/public-paths.ts`; nenhum arquivo de código (fora de testes) cita hoje as tabelas de eventos;
`net.http` e `pg_net` não aparecem nas migrations 9120 e 9121.

**NÃO medido:**

- **Nada foi executado nesta máquina.** Nenhum `pnpm`, `vitest`, typecheck, lint, build, Docker ou
  Playwright. A cerca nova também não foi rodada: o veredito é o CI do PR interno.
- **Banco real:** os gatilhos e as funções só têm teste de invariante escrito, não executado; a 9121 também
  não foi aplicada.
- **Número da migration 9121:** `pnpm checar:colisao-de-migration` não foi rodado.
- **Módulo real:** nenhum serviço de verdade buscou eventos. J71 é especificação.
- **Tela em navegador:** o bloco novo de `/admin/extensoes` não foi visto renderizado (cores do selo,
  quebra de linha).
- **Prazo entre a anonimização e a leitura:** o módulo busca quando quiser; o CRM não garante prazo, só
  mostra o atraso.
- **Volume da tabela de eventos:** sem expurgo (D5), não foi medido crescimento.
- **Espelho `.claude/skills` não regenerado:** a F5 não tocou o guia `deskcomm-extensao`.
- **Coluna de CI da J71** foi montada a partir dos nomes e da intenção dos testes das tarefas anteriores;
  cada teste não foi relido caso a caso nesta tarefa.
