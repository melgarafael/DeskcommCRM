# SPEC — IA da agência (Fase 9)

> Módulo `ia-da-agencia` do [mapa de capacidades](mapa-de-capacidades.md) (D17). Decidida em
> 26/10/2026 sem parar para aprovação (pedido do dono: as fases seguem uma após a outra).

## O que resolve

Duas coisas, nesta ordem:

1. **Chat no mapa.** Quem monta o mapa escreve o que quer ("plano de dezembro: 8 Reels,
   2 gravações, edição, aprovação do cliente antes do dia 20"), e a IA **propõe** os blocos e
   as setas. A proposta aparece em pré-visualização. **Nada entra no mapa sem o "Aplicar"** de
   uma pessoa, e só em mapa em rascunho.
2. **Executor IA.** O bloco marcado "executor: IA" vira tarefa como os outros. Na tarefa, o
   botão **"Executar com IA"** roda uma ação do catálogo e devolve o resultado **para
   conferência**. A tarefa vai para Revisão, e quem confere conclui ou devolve.

## Regras

| # | Regra |
|---|---|
| I1 | A IA usa a chave de IA **da instalação** (`resolveLanguageModel`). Sem chave, os botões explicam o motivo e não aparecem quebrados. Modelo: `anthropic/claude-sonnet-5` (constante em `lib/agencia/ia/modelo.ts`; sem variável de ambiente nova, para não pedir edição de `.env`). |
| I2 | Saída de IA é sempre **estruturada e validada por Zod** (`generateObject`). Resposta fora do formato vira erro legível e não grava nada. |
| I3 | **Chat no mapa:** pede `mapa.editar` e mapa em rascunho. São no máximo 25 blocos por proposta. As setas só ligam blocos da proposta ou blocos que já existem, e a proposta passa pela mesma regra do mapa (`problemaNoMapa`): círculo é recusado. Ao aplicar, os blocos novos vão para o primeiro lugar livre da grade, e quem não tem responsável fica com o executor sugerido pela IA. |
| I4 | **Catálogo do executor (nesta fase):** `roteiro` escreve o roteiro de vídeo curto. `legenda` escreve a legenda com chamada para ação. `ideias` lista as pautas do mês. `plano_de_campanha` escreve o rascunho de campanha (objetivo, público, orçamento sugerido e texto do anúncio) **como texto**: nada é criado no Gerenciador de Anúncios. `publicacao` cria uma **publicação em rascunho** no calendário (Fase 8b) com a legenda gerada, e ela ainda precisa de aprovação do cliente e de agendamento por uma pessoa. |
| I5 | **Nada que fale em nome do cliente ou gaste dinheiro sai sem uma pessoa** (D17). Criar campanha de verdade (que nasceria pausada) fica para depois e exige autorização do dono: a conexão de anúncios do teste é real. |
| I6 | O resultado é gravado na própria tarefa (`agencia_tarefas.resultado_ia`, texto) e no checklist como "Conferir o resultado da IA". A execução é registrada em `agencia_execucoes_ia` (quem pediu, ação, modelo, tokens, situação, erro), e cada execução audita `agencia.ia_executada`. |
| I7 | O contexto que a IA recebe é só o do cliente: nome, nicho e objetivo da ficha, o título e a descrição do bloco ou da tarefa, e as tarefas e publicações do mês. **Nunca** recebe o cofre de acessos, contratos ou dados pessoais de contato. |
| I8 | Limite: 30 execuções por hora por pessoa, contadas no banco. Passou disso, a tela diz quando dá para tentar de novo. |

## Dados (migration 9012)

- `agencia_execucoes_ia` — tabela da instalação: `tarefa_id`/`mapa_id` (um dos dois),
  `acao`, `pedido_por`, `modelo`, `tokens_entrada`, `tokens_saida`, `situacao`
  (`ok`/`falhou`), `erro`, `criado_em`.
- `agencia_tarefas.resultado_ia text`, `agencia_tarefas.acao_ia text null`, com CHECK no
  catálogo.
- `agencia_mapa_blocos.acao_ia text null` (a ação que a tarefa do bloco vai executar),
  com o mesmo CHECK.

## Telas

- Mapa em rascunho: o painel "Pedir à IA" com uma caixa de texto, o botão "Propor blocos", a
  pré-visualização (lista de blocos e setas) e os botões "Aplicar" e "Descartar".
- Bloco com executor IA: escolher a ação do catálogo.
- Tarefa com ação de IA: o botão "Executar com IA", o resultado com "Copiar" e a situação.

## O que NÃO está provado

**Nada que chama o modelo foi exercido no teste**: a instalação do teste não tem chave de IA
(as quatro variáveis estão vazias no `.env`) e nenhuma organização tem credencial. A prova pela
tela cobriu o resto: a mensagem "sem chave", a ação que vai do bloco para a tarefa, executar sem
chave sem mexer na tarefa e tirar a IA da tarefa ([plano-fase-9](plano-fase-9.md)). Quando houver
chave, rode [`scripts/prova-fase9-com-modelo.mjs`](scripts/prova-fase9-com-modelo.mjs). A
qualidade do texto depende do modelo e não é julgada pela prova. A criação real de campanha fica
fora desta fase (I5).
