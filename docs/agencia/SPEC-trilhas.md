# Spec: `trilhas` — a trilha do cliente

> Fase 4 do [mapa de capacidades](mapa-de-capacidades.md). Estado: **decidida** em 26/10/2026
> — o dono pediu para as fases seguirem sem parar para aprovação; as decisões abaixo são as
> sugestões, registradas para quem vier depois.
> Depende de [`tarefas`](SPEC-tarefas.md), [`calendario`](SPEC-calendario.md) e [`avisos`](SPEC-avisos.md).

## Objetivo

Cliente novo entra e as **Etapas 1 e 2** (mapa › Regras do negócio) se montam sozinhas:
cada passo tem dono e prazo, os passos se **desbloqueiam** quando os anteriores terminam,
e o relógio avisa antes de algo passar (D+7 do Fechamento, 5 dias da proposta, 7 dias da
Ativação, regra do dia 15).

### Histórias

- Como **dono**, na ficha da Turbo Kids clico em "Iniciar trilha"; a Apresentação aparece
  para marcar, e o resto fica bloqueado com cadeado até chegar a vez.
- Como **dono**, quando a Turbo Kids assina e paga, marco "Contrato assinado e pago" com a
  data; o sistema calcula pela regra do dia 15 quando o contrato começa e até quando vai a
  preparação, e libera a Etapa 2: o roteirista recebe "Roteiros do mês", o designer recebe
  "Identidade visual".
- Como **editor**, quando o videomaker termina "Subir o material", a minha tarefa de edição
  aparece, com prazo no fim do mês de preparação.
- Como **dono**, numa tela vejo todas as trilhas: em que etapa cada cliente está, quanto
  falta e o que está atrasado.

## Decisões

| # | Decisão | Por quê |
|---|---|---|
| R1 | **Modelo × cópia.** A trilha de um cliente é uma CÓPIA do modelo no dia em que começou. Mudar o modelo vale para as trilhas novas; as que já andam não mudam. | Mudar o processo não pode reescrever o que já foi combinado com um cliente. |
| R2 | Um modelo nasce pronto: **"Cliente recorrente"**, com as Etapas 1 e 2 do mapa (20 passos). Avulsos ganham modelos quando o dono os descrever — o editor de modelos já permite criar. | O dono ainda não descreveu as trilhas dos avulsos. |
| R3 | Três tipos de passo: **tarefa** (vira uma tarefa do quadro), **reunião** (vira uma reunião do calendário, marcada por quem gerencia o calendário) e **marco** (algo que acontece fora, marcado à mão: "Contrato assinado e pago"). | É o que as Etapas 1 e 2 têm. |
| R4 | **Desbloqueio**: o passo fica com cadeado até TODOS os passos de que depende estarem concluídos (ou pulados). Tarefa concluída no quadro conclui o passo; reunião marcada como realizada conclui o passo; marco conclui à mão. Tarefa reaberta devolve o passo para "em andamento". | Fases de jogo (D12) sem trabalho manual. |
| R5 | **Prazo do passo** por regra: manual; N dias depois de liberar; N dias depois de outro passo (a data da reunião ou do marco); ou o **fim da preparação** (regra do dia 15). O prazo do passo vira o prazo da tarefa — e os avisos de prazo da Fase 2 já cuidam dela. | Mapa P4: "os prazos variam por cliente"; o modelo dá o ponto de partida e quem planeja ajusta na tarefa. |
| R6 | **Regra do dia 15** ao marcar "assinado e pago": até o dia 15 o contrato começa no dia 1 do mesmo mês e a preparação vai até o fim dele; do dia 16 em diante começa no dia 1 do mês seguinte e a preparação vai até o fim desse mês. Contrato mínimo de 3 meses. As datas vão para a contratação quando ela ainda não as tem. | Mapa › Calendário do contrato. |
| R7 | **Quem faz a tarefa**: se alguém da equipe do cliente tem a função do passo, ele é o responsável; senão a tarefa vai para a função inteira (botão "Pegar"). | Usa a equipe que a Fase 2 já cadastra. |
| R8 | **Começar do meio**: ao iniciar, dá para escolher o passo de partida; os anteriores ficam "pulados". É o caso do avulso que vira recorrente e entra direto no Fechamento (D6). | Regra do negócio D6. |
| R9 | **Remarcar a Apresentação arrasta o Fechamento** marcado junto (o da Fase 3, `origem_id`), se ele ainda não aconteceu — fica pendente da Fase 3. | Mapa › Etapa 1. |
| R10 | **Relógio**: passo sem tarefa (reunião por marcar, marco) que está liberado e com prazo avisa no sininho de quem recebe avisos gerais — chegando, no dia e atrasado, cada marco uma vez — no mesmo cron `agencia-prazos`. | A tarefa já tem os próprios avisos; o que não é tarefa precisa de alguém olhando. |
| R11 | **Quem pode**: iniciar, pular, concluir marco e cancelar a trilha — `clientes.gerenciar`; editar modelos — `trilhas.gerenciar`; ver — quem alcança o cliente (C5). | Mesma régua de clientes. |

## Dados (migration 9006)

`agencia_trilha_modelos` (nome, tipo recorrente/avulsa, ativo), `agencia_trilha_modelo_passos`
(chave estável, etapa, ordem, título, descrição, tipo, tipo de reunião, função, depende de
— lista de chaves —, regra de prazo + dias + âncora, checklist, executor humano/IA),
`agencia_trilhas` (cliente, contratação, modelo, situação, assinou-e-pagou em, início do
contrato, fim da preparação), `agencia_trilha_passos` (a cópia de cada passo, com situação
bloqueado/liberado/em andamento/concluído/pulado, prazo, tarefa, reunião, datas) e
`agencia_avisos_de_trilha` (passo + marco, cada aviso uma vez). Mesmo regime das outras
fases: instalação, RLS, `revoke all`, só o servidor.

## Telas

| Onde | O quê |
|---|---|
| Ficha do cliente › **Trilha** | Iniciar (modelo, contratação, passo de partida); progresso; etapas com os passos e o estado de cada um; botões do passo: abrir a tarefa, "Marcar reunião", "Concluir" o marco, "Pular"; datas do contrato (regra do dia 15). |
| `/agencia/trilhas` | Todas as trilhas ativas que a pessoa alcança: cliente, etapa, progresso, próximo passo, atrasados. |
| `/agencia/trilhas/modelos` | Editor de modelos (`trilhas.gerenciar`): passos, dependências, função, prazo. |

Menu: entra **Trilhas** (todo membro).

## Critérios de aceite

1. Iniciar a trilha "Cliente recorrente" libera só a Apresentação; o resto fica bloqueado.
2. Apresentação realizada libera Proposta e Fechamento, com prazos D+6/D+7 da Apresentação.
3. "Assinado e pago" num dia 6 dá contrato no dia 1 do mesmo mês e preparação até o fim
   dele; num dia 20, contrato no mês seguinte.
4. A tarefa nasce com a pessoa da equipe do cliente que tem a função, ou para a função.
5. Concluir a tarefa no quadro conclui o passo e libera os dependentes, que viram tarefas.
6. Começar do Fechamento deixa os passos anteriores pulados.
7. Remarcar a Apresentação arrasta o Fechamento ligado a ela.
8. O relógio avisa o passo sem tarefa atrasado uma vez.
9. Membro sem acesso ao cliente não vê a trilha.

## Fora desta fase

- Etapa 3 (ciclo mensal) — vira as tarefas recorrentes da Fase 2 e o mapa da Fase 8.
- Grupo e formulário automáticos ao assinar e pagar (Fases 5 e 6); aqui é uma tarefa.
- Trilhas dos avulsos (o editor permite criar quando o dono descrever).
