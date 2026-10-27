# Plano de implementação — Fase 9 (IA da agência)

> Estado: **construída e publicada no teste.emmovimento.tech em 27/10/2026**, branch
> `feat/agencia-fase-9` (sai da Fase 8). Spec: [`SPEC-ia-da-agencia`](SPEC-ia-da-agencia.md).
> Prova pela tela em `evidence/agencia-fase-9/`.
>
> **⚠️ O caminho que chama o modelo NÃO foi provado.** Isso cobre propor blocos, aplicar a
> proposta, escrever roteiro/legenda/pautas/campanha e criar a publicação. O teste **não tem
> chave de IA**: as variáveis `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` e
> `OPENROUTER_API_KEY` estão no `.env` do teste com valor vazio (`""`), e nenhuma organização
> tem credencial em `ai_provider_credentials`. Medido em 27/10/2026, conferindo só o
> comprimento, nunca o valor. Para provar, o dono precisa pôr uma chave no `.env` do teste (a
> instalação gasta crédito do provedor a cada pedido) e alguém roda o
> [`prova-fase9-com-modelo.mjs`](scripts/prova-fase9-com-modelo.mjs).
>
> **Verificação:**
> - Typecheck e lint limpos. O único aviso, `set-state-in-effect` no `ModalDaTarefa`, já
>   existia.
> - 6 testes de regras (`tests/unit/agencia-ia-regras.test.ts`): o catálogo, o limite por hora,
>   o formato da proposta, marco nunca da IA, e a recusa de chave repetida, seta para o nada,
>   laço e círculo, também contra blocos que já existem.
> - No Postgres da VPS, baseline install + update sem erro e `agencia-fase-9.test.ts` verde: o
>   registro fora do alcance de anon/authenticated, o catálogo fechado no banco (tarefa, bloco e
>   registro), e o registro sobrevive à tarefa apagada. A única falha da suíte é a varredura de
>   RLS acusando Bling e `social_insights`, que já existia no fork.
>
> **Prova pela tela, sem chave** (membro de teste com uma função temporária "IA (prova F9)", que
> tinha `mapa.editar`, `tarefas.criar` e `tarefas.atribuir` e foi apagada depois):
> 1. Num mapa novo, o painel "Pedir à IA" diz "A instalação não tem chave de IA configurada.
>    Peça a quem administra a instalação." em vez de um botão que quebraria.
> 2. Um bloco com executor IA oferece as cinco ações do catálogo. Foi escolhida "Escrever
>    legenda", com o membro de responsável.
> 3. Ao publicar o mapa, a tarefa nasceu com a ação `legenda`, na coluna A fazer.
> 4. "Executar com IA" sem chave mostra o motivo **dentro da caixa da IA**, e a tarefa
>    continua em A fazer, sem resultado.
> 5. Ao trocar para "Sem IA (feita por pessoa)", o botão some.
> 6. O calendário de publicações mostra "Novembro de 2026" (conserto da 8b).
> 7. Com 375 px não há rolagem lateral.
>
> **Achados na prova e consertados:**
> 1. O erro "sem chave" ia para o rodapé do modal, fora da vista, e o clique parecia não fazer
>    nada. Agora a caixa da IA mostra a própria resposta (`fala-da-ia`).
> 2. O `Salvar` do modal mandava sempre `executor: "humano"` e apagaria a escolha da IA. Agora
>    ele preserva o executor. Depois de a IA executar, o formulário relê a tarefa: senão o
>    Salvar desfaria a coluna Revisão e o item do checklist.
> 3. O apêndice do `baseline.sql` saiu com `do $` em vez de `do $$`, porque o
>    `String.replace` do JavaScript trata `$$` na substituição. O `test:db` reprovou no install,
>    e o apêndice foi refeito por fatia. **Lição:** para inserir SQL com `$$`, nunca usar
>    `replace` com o texto da migration como substituição.

## Decisões de arquitetura

- **Migration 9012** + apêndice no baseline:
  - `agencia_execucoes_ia` é da instalação, como as outras tabelas da agência.
  - `agencia_tarefas.resultado_ia` e `acao_ia` são colunas novas, e `agencia_mapa_blocos`
    também ganha `acao_ia`. Os CHECKs fecham o catálogo.
- **Catálogo** em `lib/agencia/ia/catalogo.ts`: `roteiro`, `legenda`, `ideias`,
  `plano_de_campanha` (só texto, I5) e `publicacao` (rascunho no calendário). A instrução de cada
  ação e o limite de 30 pedidos por hora por pessoa ficam no mesmo arquivo.
- **Proposta do mapa** em `lib/agencia/ia/proposta.ts` (Zod): no máximo 25 blocos.
  `normalizarProposta` garante que um marco nunca seja da IA. `problemaNaProposta` usa a mesma
  regra de círculo do mapa (`problemaNoMapa`).
- **A porta do modelo** fica em `lib/agencia/ia/modelo.ts`:
  - `resolveLanguageModel` usa a chave da instalação, e o modelo `anthropic/claude-sonnet-5` é
    uma constante.
  - `generateObject` valida a saída. Cada pedido grava uma linha no registro, e um erro vira
    frase legível, nunca exceção.
  - `contextoDoCliente` só passa nome, segmento, cidade e observações. Nada vem do cofre, de
    contrato ou de contato (I7).
- **Executor** em `lib/agencia/ia/executor.ts`: `proporParaMapa`, `aplicarProposta` (grade
  livre de 3 colunas e setas por chave) e `executarTarefa` (o resultado vai para a tarefa, a
  tarefa vai para Revisão e ganha o item "Conferir o resultado da IA"; a ação `publicacao` cria
  a publicação em rascunho).
- **Ações** em `app/actions/agencia/ia.ts`. Propor e aplicar pedem `mapa.editar`, e a proposta
  volta do navegador e é **validada de novo**. Executar e definir a ação pedem `tarefas.criar` e
  enxergar a tarefa.
- A tarefa do bloco herda `acao_ia` (`criarTarefaDoBloco` no motor do mapa).
- Auditoria: `agencia.ia_executada` e `agencia.ia_proposta_aplicada`.

## Para provar com modelo (quando houver chave)

Script pronto: [`scripts/prova-fase9-com-modelo.mjs`](scripts/prova-fase9-com-modelo.mjs) (copiar para `/root/agencia-ci/prova/`). O roteiro:
1. No mapa novo, escrever o pedido e clicar em "Propor blocos". Esperar a pré-visualização
   (`proposta-da-ia`), conferir que **nada entrou no mapa antes de "Aplicar"**, clicar em
   "Aplicar no mapa" e contar os blocos.
2. Numa tarefa com a ação `legenda`, clicar em "Executar com IA". O resultado aparece em
   `resultado-da-ia`, a coluna vai para Revisão, e o checklist ganha "Conferir o resultado da
   IA".
3. Trocar a ação para `publicacao` e clicar em "Executar de novo". A publicação aparece em
   **rascunho** no calendário, e nada vai para a Meta.
4. Conferir `agencia_execucoes_ia` (tokens, situação) e `api_audit_log`.
