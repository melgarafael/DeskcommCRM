# Spec: `mapa-mental` — Criação e Ao vivo

> Fase 8 (parte a) do [mapa de capacidades](mapa-de-capacidades.md). Estado: **decidida** em
> 26/10/2026 pelas sugestões (o dono pediu para seguir as fases sem parar para aprovação).
> Decisões do dono que mandam: D12 (só da agência, etapas que desbloqueiam como fases de jogo),
> D16 (duas telas: Criação e Ao vivo), D17 (cada bloco escolhe humano ou IA). Depende de
> [`tarefas`](SPEC-tarefas.md) e reaproveita a regra de desbloqueio das [`trilhas`](SPEC-trilhas.md).

## Objetivo

Para cada cliente, a agência **desenha** o plano (do mês, de uma campanha, do lançamento) como
blocos ligados por setas — "isto só começa quando aquilo terminar" —, e depois **publica**. Ao
vivo, os blocos com tudo o que vinha antes pronto se acendem e viram tarefas para quem vai
fazer; os outros ficam com cadeado até chegar a vez.

## Decisões

| # | Decisão | Por quê |
|---|---|---|
| M1 | Um cliente tem **vários mapas** (plano do mês, campanha…), cada um em rascunho, publicado ou arquivado. | O plano muda por mês e por objetivo. |
| M2 | **Criação**: tela de desenho com blocos arrastáveis e setas; o bloco tem título, descrição, cor, tipo (tarefa ou marco), responsável (pessoa) ou função, prazo, checklist, links e **executor (humano ou IA)**. Em rascunho nada vira tarefa. | D16, D17. |
| M3 | **Publicar** confere o mapa (sem seta em círculo, todo bloco com título) e liga o Ao vivo. Depois de publicado, dá para mudar textos, prazos e responsáveis, mas **não as setas** (o caminho já começou). | O que já foi combinado com a equipe não muda por baixo. |
| M4 | **Ao vivo**: mesma regra de desbloqueio da trilha. Bloco de tarefa liberado vira tarefa do quadro (com responsável ou para a função, prazo, checklist e executor); concluir a tarefa conclui o bloco e libera os seguintes. Marco conclui à mão. Progresso por mapa. | D12 — fases de jogo. |
| M5 | Bloco marcado **IA** vira tarefa com executor IA; quem executa é a Fase 9. | D17, preparado desde a Fase 2. |
| M6 | Ver: quem alcança o cliente. Criar, editar e publicar: `mapa.editar`. | Vocabulário da Fase 1. |
| M7 | **Sem biblioteca nova**: o desenho é HTML + SVG com arrastar por ponteiro. No **celular**, Criação e Ao vivo viram **lista** (o mesmo formulário, com "depende de" no lugar das setas). | Mapa › Limites (dependência nova pede consulta); D14. |

## Dados (migration 9010)

`agencia_mapas` (cliente, título, descrição, situação, publicado em), `agencia_mapa_blocos`
(mapa, título, descrição, cor, posição x/y, tipo, função, responsável, prazo, checklist, links,
executor, situação bloqueado/liberado/em andamento/concluído, tarefa, liberado em, concluído em)
e `agencia_mapa_ligacoes` (de → para, sem seta para si mesmo). Instalação, RLS, `revoke all`.

## Telas

| Onde | O quê |
|---|---|
| `/agencia/mapas` | Mapas dos clientes que a pessoa alcança, por situação; "Novo mapa". |
| `/agencia/mapas/<id>` | Rascunho → **Criação**; publicado → **Ao vivo**. |

## Critérios de aceite

1. Criar blocos, arrastar, ligar por seta e editar pelo painel; tudo salva.
2. Publicar recusa círculo e libera só os blocos sem dependência, que viram tarefas.
3. Concluir a tarefa no quadro acende o bloco seguinte.
4. Celular mostra lista, sem rolagem lateral.
