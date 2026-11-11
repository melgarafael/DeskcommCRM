# Módulo conectado F3: declarações do PR

Declaração do PR da F3 (autoridade por área: consentimento, portão declarado ∩ consentido, papel efetivo
com JWT de contexto, tela de consentimento e atribuição da pessoa no audit). Cada afirmação traz o comando
que a produz. Nada aqui foi executado nesta máquina: o veredito é o CI do PR interno.

## Destino (item 18 do Definition of Done)

**Núcleo e extensão (conector).** O núcleo ganha o ponto de entrada (consentimento, portão, JWT de
contexto, atribuição no audit); o primeiro consumidor real é o módulo conectado da spec 33.

Pergunta-raiz: *se nenhuma organização ativar um módulo `connected`, a operação comum continua inteira?*
Sim. O portão (`lib/auth/modulo-autorizado.ts`) só roda quando o ator é `module`
(`grep -n 'actor.type === "module"' lib/api/auth-dual.ts`); o consentimento só existe para instalação
`connected` ativada (`fn_extensions_set_consent`); a atribuição só aparece quando há JWT de contexto
(`grep -n "person_id" lib/audit/ator-modulo.ts`). Usuário, agente e token comum não passam por nenhum deles.

## Tela (item 14)

**Nenhuma tela nova.** O cartão da extensão em `/admin/extensoes` ganha as caixas de consentimento por
área (`components/extensions/ConsentimentoPorArea.tsx`). A porta já existe em `lib/admin/navegacao.ts`
(`grep -n '"/admin/extensoes"' lib/admin/navegacao.ts`).

## Env nova (item 9)

**`MODULE_JWT_PRIVATE_KEY`, opcional, sem ação ao atualizar.** Entrou em `.env.example` e em `lib/env.ts`
com padrão vazio (`grep -n "MODULE_JWT_PRIVATE_KEY" .env.example lib/env.ts`). Sem ela, o módulo continua
chamando a API com o token; só não há JWT de contexto de pessoa. Nenhum valor de chave aparece neste documento.

## Migrations (tripla)

- `supabase/migrations/20261105120000_9119_modulo_conectado_consentimento.sql` (permissões `area.*` na
  CHECK e `fn_extensions_set_consent`).
- `supabase/baseline.sql`: apêndice idempotente depois do apêndice da 9118
  (`grep -n "fn_extensions_set_consent" supabase/baseline.sql`).
- Cabeçalho `-- manifest:` (`head -3` do arquivo).

## Living System Checklist (item 13)

1. **Quem me alimenta.** O admin, pela rota `PUT /api/v1/extensions/[id]/consentimento`
   (`lib/extensions/consentimento.ts`); o módulo, pela rota `POST /api/v1/extensions/[id]/contexto`
   (JWT da pessoa); o token do módulo da F2.
2. **Quem eu alimento.** O portão de autoridade (`lib/auth/modulo-autorizado.ts`), chamado por
   `resolveAuthDual` (`lib/api/auth-dual.ts`), que decide por área e modo; e o audit, que recebe
   `metadata.person_id`.
3. **Registro que emito.** `extension.consent_changed` (lista fechada de áreas, sem dado pessoal) e, nas
   mutações do módulo, as ações de sempre com `metadata.module`, `actor_api_token_id` e, quando há
   pessoa, `person_id` (`lib/audit/ator-modulo.ts`).
4. **Onde apareço na tela.** O cartão em `/admin/extensoes`; a pessoa aparece nos registros de auditoria.
5. **Por qual porta se chega.** `/admin/extensoes` (já existente). Nenhuma tela nova.
6. **Anti-morte.** **Nenhum, com justificativa:** é decisão de acesso síncrona. Quem é recusado recebe o
   código de erro e pode repetir depois que o admin consentir. Nenhuma demanda de pessoa fica esperando.
7. **Onde se configura.** O próprio cartão (áreas) e `MODULE_JWT_PRIVATE_KEY` (opcional, só para a pessoa).
8. **Continuidade IA↔humano.** Não se aplica: a F3 não cria agente.
9. **Laço de retorno.** Fecha no host: retirar o consentimento recusa a chamada seguinte, porque o portão
   lê o banco a cada chamada. **Dívida declarada:** o que o módulo faz ao receber a recusa fica fora do
   sistema e nenhum teste desta branch mede esse comportamento.
10. **Mapa.** `docs/architecture/extensoes-declarativas.architecture.json` ganha seis nós
    (`consent_ui`, `consent_route`, `consent_db`, `authority_gate`, `context_route`, `context_jwt`) e oito
    arestas. Verificação: `Get-Content -Raw docs/architecture/extensoes-declarativas.architecture.json |
    ConvertFrom-Json` (o JSON lê sem erro), e cada nó novo tem pelo menos duas arestas.

## Atribuição da pessoa no audit (tarefa 6)

Mecanismo mínimo, sem tocar rotas: o ator `module` ganhou o campo opcional `pessoaId`
(`grep -n "pessoaId" lib/api/handlers/types.ts`); `resolveAuthDual` o preenche com a pessoa do JWT de
contexto; `metadataDoModulo` o devolve como `person_id`. Como as rotas de contatos, conversas, leads e
mensagens já espalham `metadataDoModulo(actor)` na metadata, elas passam a gravar `person_id` sem mudança
(`grep -rn "metadataDoModulo" app lib --include=*.ts`). A pessoa **nunca** vai para `actor_user_id`.
Teste: `lib/audit/ator-modulo.test.ts` e `lib/api/auth-dual-contexto.test.ts`.

## Fragmento de release

`.changes/modulo-conectado-consentimento.md`, `impacto: capacidade_nova`, `secao: adicionado`. Diz que a
variável nova é opcional e que não exige ação. Sem seção no `CHANGELOG.md`. (O plano cita o nome
`modulo-conectado-autoridade.md`; usou-se o nome pedido na ordem da tarefa.)

## O que NÃO foi medido

- **Nada foi executado nesta máquina.** Nenhum `pnpm`, `vitest`, typecheck, lint, build, Docker ou
  Playwright. O veredito é o CI do PR interno.
- **A migration 9119 e o apêndice do baseline não foram aplicados** em nenhum Postgres.
- **Nenhuma jornada em navegador.** J69 é especificação, todos os casos "NÃO EXECUTADO"; a coluna de CI da
  J69 foi montada a partir dos nomes e da intenção dos testes das tarefas anteriores, e cada teste
  não foi relido caso a caso nesta tarefa.
- **Rotas que não usam `metadataDoModulo` não gravam `person_id`.** Só as quatro rotas listadas acima e o
  audit de ferramentas MCP usam o mecanismo comum; não se varreu uma a uma as demais rotas mutantes de
  `app/api/v1` para saber se alguma monta o audit de outro jeito.
- **O módulo real não foi exercido:** assinar o JWT de contexto e repassá-lo pela tela dele.
- **`lib/database.types.ts` não foi regenerado.**
- **Espelho `.claude/skills` não regenerado:** a F3 não tocou o guia `deskcomm-extensao`.
