# Módulo conectado F6: declarações do PR

Declaração do PR da F6 (atravessar a atualização do CRM: suspensão fora da faixa `host_api` e contrato
congelado do que um módulo alcança). Nada aqui foi validado por execução de teste: o veredito é o CI do PR
interno.

## Destino (item 18 do Definition of Done)

**Núcleo.** O CRM passa a recusar token de módulo fora da faixa e a vigiar o que um módulo alcança. O
módulo, fora do CRM, só precisa declarar a faixa `host_api` certa.

Pergunta-raiz: *se nenhuma organização ativar um módulo conectado, a operação comum continua inteira?*
Sim. A checagem nova só roda dentro de `autorizarModulo`, que só um token de módulo atravessa; a tela de
`/admin/extensoes` só mostra a nota para módulo `connected` (declarativo fora da faixa não é tocado). Atualizar
o CRM nunca depende de módulo conectado: ele não tem tabela no banco do CRM e não entra na reaplicação.

## Tarefa 1: suspensão fora da faixa

- `autorizarModulo` (`lib/auth/modulo-autorizado.ts`) relê a faixa `host_api` do manifesto do artefato a
  cada chamada, sem cache, com o mesmo `checkCompatibility` que o menu e a gestão usam. Fora da faixa:
  `403 module_incompatible`, mensagem própria em português, antes de olhar áreas.
- **Lado seguro:** manifesto sem faixa numérica ou sem lista de permissões recusa com
  `module_authorization_unavailable` ("nada foi feito"), nunca passa.
- **A leitura de eventos NÃO é bloqueada por incompatibilidade (decisão D2 do plano p10, declarada).**
  `eventos-do-modulo.ts`, `prova-do-modulo.ts` e a rota `events` não consultam o manifesto nem
  `autorizarModulo`; um teste (`lib/extensions/eventos-do-modulo.test.ts`) vigia que nenhuma delas passe a
  citar `checkCompatibility`, `host_api`, `module_incompatible` ou `autorizarModulo`. Um módulo suspenso
  continua podendo ler os avisos de contato anonimizado, para a LGPD não ficar presa a uma atualização.
- `/admin/extensoes`: para módulo conectado suspenso mostra uma frase em português simples (outra versão do
  CRM, não foi possível conferir, ou incompatível por outro motivo), com `t()` literal e es/en/tr.
- `HOST_API_VERSION` passou a `export const` (só para testes e para o contrato não copiarem o número).

## Tarefa 2: contrato congelado

- `tests/unit/modulo-contrato-congelado.test.ts` compara o que se deriva dos arquivos com o instantâneo
  `tests/unit/__contrato__/modulo-contrato.json`: as 9 áreas, as 18 permissões, a lista ordenada
  `MÉTODO /api/v1/modelo` por área (derivada de `areaDaPorta` varrendo `app/api/v1/**/route.ts`) e os
  schemas Zod de corpo das rotas liberadas (nome, origem, hash do texto da definição).
- A regra: quebra (rota, área ou schema que saiu ou mudou) sem `HOST_API_VERSION` maior que a do
  instantâneo reprova com a frase "suba HOST_API_VERSION (lib/extensions/manifest.ts) e regenere o
  instantâneo"; acréscimo reprova pedindo só para regenerar. `UPDATE_CONTRATO=1` reescreve o instantâneo e se
  recusa a gravar quebra sem subir a versão. Nenhum script novo no `package.json`.
- A derivação mora em `tests/unit/helpers/contrato-do-modulo.ts` (sem importar o repositório; recebe as
  funções por parâmetro), para o teste e a regeneração usarem o mesmo código.

## Living System Checklist (item 13)

1. **Quem me alimenta.** A versão do CRM (`HOST_API_VERSION`) e o manifesto do pacote.
2. **Quem eu alimento.** O módulo (recusa clara) e quem administra o servidor (nota em `/admin/extensoes`).
3. **Registro que emito.** A recusa já aparece como 403 com código; o log existente da rota registra o
   código. Não há tabela nova.
4. **Onde apareço na tela.** Em `/admin/extensoes`, na linha do módulo; no menu o módulo já some.
5. **Por qual porta se chega.** A tela de extensões da instalação.
6. **Anti-morte.** Módulo que ficou para trás não fica mudo sem explicação: a recusa tem código próprio e a
   tela diz o motivo.
7. **Onde se configura.** Não há configuração nova.
8. **Continuidade IA↔humano.** Não se aplica.
9. **Laço de retorno.** O código `module_incompatible` chega ao módulo; a nota na tela muda a decisão de
   quem administra (atualizar o módulo). **Dívida:** o que o módulo faz ao receber o 403 está fora do
   sistema.
10. **Mapa.** Sem nó novo: a F6 não cria peça; reusa `authority_gate`.

## Fragmento de release

`.changes/modulo-conectado-atualizacao.md`, `impacto: capacidade_nova`, `secao: adicionado`.

## Medido e não medido

**Medido (leitura e uma geração por script):**
- as chamadas de `checkCompatibility` (`instalada.ts`, `service.ts`, `modulos-na-tela.ts`) e que
  `autorizarModulo` não chamava;
- que a leitura de eventos não consulta o manifesto;
- o instantâneo foi gerado por um script `node` descartável (fora do repositório, com
  `--experimental-strip-types`) que importa o MESMO helper e as MESMAS funções `areaDaPorta` e
  `EXTENSION_AREAS` do repositório, com `HOST_API_VERSION = 2`: 9 áreas, 18 permissões, 312 pares de rota
  e 112 rotas com algum schema detectado. Isso **não é** a execução do vitest.

**NÃO medido:**
- **O teste novo e os testes alterados não foram rodados.** Nenhum `pnpm`, `vitest`, typecheck, lint,
  build ou Docker. O instantâneo **não foi validado por execução do teste**: o CI dirá.
- **Diferença entre Windows e Linux:** o instantâneo foi gerado no Windows. O código normaliza `\r\n` e
  usa ordenação por unidade de código, mas só o CI mostra se o resultado é idêntico.
- **O que ficou SEM congelar:**
  - o formato das respostas das rotas que não declaram schema (a maioria monta o corpo com `ok()`); só os
    schemas cujo nome diz resposta (`*Response*Schema`, `*Output*Schema`, `*Result*Schema`) são listados,
    por nome;
  - schemas filhos: se um schema muda por dentro de outro que ele referencia, o hash do pai não muda;
  - validação feita à mão, sem Zod, e query string validada fora de `.parse/.safeParse`;
  - o schema chamado `schema` em uma rota ficou como "nao-resolvido" (variável local sem definição
    estática achada);
  - o comportamento das rotas (o que ela faz com o corpo), que é matéria dos testes de cada rota.
- **Rotas que um módulo alcança só por um caminho dinâmico** não deduzido pelo modelo da pasta
  (`modeloDoCaminho` em runtime pode divergir do modelo pela pasta quando um segmento literal não está na
  lista conhecida): o contrato usa o modelo da pasta, o mesmo das listas da fase R.
- **Módulo real:** nenhum módulo recebeu `module_incompatible`; a nota da tela não foi vista renderizada.
- **Mudança de `host_api` no CRM real:** não foi simulada contra banco.
