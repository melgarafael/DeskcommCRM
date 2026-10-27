# Ajustes pedidos pelo dono — 27/10/2026

> Anotações do dono transformadas em plano. Decisões respondidas pelo dono em 27/10/2026 (fim do arquivo). Os itens estão na ordem
> sugerida de construção (o que destrava mais uso primeiro), e cada um vira commit próprio na
> branch `feat/agencia-ajustes` (sai da Fase 9). As decisões em aberto estão no fim.

## O que foi medido antes de planejar

| Ponto | Como está hoje |
|---|---|
| Fluxo das organizações | `app/app/automacoes/fluxos/[id]/` usa **`@xyflow/react`** (React Flow). Ele já tem tela que se movimenta, paleta de blocos (`NodePalette`), cartões por tipo (`nodes/*Node.tsx`), painel de configuração (`NodeConfigPanel`) e barra de publicar (`PublishBar`). Dá para reaproveitar a estrutura inteira. |
| Mapa da agência | HTML + SVG feito à mão (`TelaDoMapa.tsx`). Não tem zoom nem paleta, e não se movimenta como o fluxo. |
| Trilhas | `/agencia/trilhas` lista os clientes, mas cada cartão aponta para `/agencia/clientes/<id>?aba=trilha` (**é por isso que pula para Clientes**). |
| Pedir aprovação | **Existe, mas escondido**: só dentro da ficha do cliente › aba Aprovações. Aceita link ou arquivo do acervo do Drive. Não há envio de vídeo ou arte para dentro do sistema. |
| Aviso de texto para o cliente | **Não existe.** Você tem razão: não há lugar para mandar um recado que o cliente só precise ler. |
| Tela do cliente (`/app/aprovacoes`) | "Abrir material" abre o link do Google Drive numa aba nova. O vídeo não toca dentro do sistema. |
| Calendário | Visões Semana, Mês e Próximos, sem arrastar e sem esticar. As tarefas já arrastam entre colunas. |
| Armazenamento | Supabase Storage na VPS, com limite de **50 MB por arquivo** (`supabase/config.toml`). Um Reels costuma passar disso. O disco da VPS tem 271 GB livres. |
| Envio ao Drive | Já existe o upload em partes para o Drive (`lib/agencia/acervo/drive.ts`), mas o Drive **ainda não está conectado no teste** (pendência do Google). |

---

## 1. Envios — tudo o que vai para o cliente num lugar só (o maior ganho)

Um botão novo no menu da agência, **"Envios"**, onde se manda tudo para o cliente:

- **Para aprovar:** vídeo (até **2 GB**), arte (imagem), **roteiro em texto** e estratégia. O
  cliente aprova ou pede ajustes.
- **Para ficar ciente:** aviso em texto (ex.: "gravação remarcada para quinta"). O cliente
  clica em **"Ciente"**, e a agência vê quem leu e quando.

Como funciona:

1. A pessoa escolhe o cliente e o tipo, escreve o título e a descrição e **sobe o arquivo**
   (vídeo ou imagem), ou escreve o texto do roteiro. O upload é em partes, com barra de
   progresso, e aguenta vídeo grande.
2. O arquivo fica **na VPS**, num armazenamento privado (`agencia-envios`). O cliente assiste
   por um link assinado que vence em poucas horas, sem nada público.
3. O cliente abre a aba Aprovações da organização dele e vê:
   - **vídeo**: o player tocando ali mesmo, com a descrição ao lado;
   - **arte**: a imagem em tamanho grande, com zoom;
   - **roteiro**: o texto formatado na própria tela;
   - **aviso**: o texto e o botão "Ciente".
4. O cliente **aprova** ou **pede ajustes** com comentário. Se pedir ajustes, a agência manda
   a **nova versão** pelo mesmo envio (v2, v3…), e o cliente vê o histórico de versões.
5. **Aprovou** → o sistema copia o arquivo aprovado para a pasta do cliente no Google Drive (a
   subpasta certa: edições, artes ou roteiros), confere que chegou inteiro e **só então apaga
   da VPS**. As versões que não foram aprovadas são apagadas junto.
6. Se o Drive não estiver conectado ou a cópia falhar, o arquivo **fica** na VPS **até conectar** e aparece um
   aviso para a equipe: nunca se apaga o que não chegou ao Drive.

O que muda no que já existe:

- A aba Aprovações da ficha do cliente vira um atalho para Envios, já filtrado naquele cliente.
- A tarefa ganha o botão **"Enviar para o cliente aprovar"**, que abre o mesmo formulário já
  ligado à tarefa. Quando o cliente responde, a tarefa acompanha, como já acontece hoje.
- A publicação (calendário de posts) usa o mesmo envio.

Trabalho técnico:

- Migration nova:
  - arquivo do envio (caminho no armazenamento, tamanho, tipo, versão, situação da cópia para
    o Drive);
  - tipo `aviso` com situação `ciente`.
- Bucket privado, upload em partes (TUS) e limite de tamanho por arquivo maior, para vídeo. Isso
  pede ajuste no Storage do teste e, um dia, da central.
- Uma rotina no cron da agência copia para o Drive e limpa, com nova tentativa.
- Prova pela tela dos dois lados: agência envia, cliente assiste, pede ajustes, recebe a v2,
  aprova, e o arquivo aparece no Drive e some da VPS.

## 2. Trilhas — na própria aba, mais fácil de ler

- **Conserto:** clicar num cliente em Trilhas abre `/agencia/trilhas/<cliente>`, sem pular
  para Clientes.
- **Tela nova da trilha do cliente:** uma linha do tempo vertical, etapa por etapa (Etapa 1 e
  Etapa 2), com:
  - feito, em verde, com a data em que foi concluído;
  - liberado e em andamento, em destaque;
  - bloqueado, apagado, com "espera: …".
- **Reloginho na ponta de cada linha que falta:** contagem regressiva ao vivo ("faltam 2 d 4 h").
  Fica amarelo quando falta menos de 24 h e vermelho quando atrasa ("atrasado há 3 h").
- No topo, a barra de progresso (12 de 20) e o próximo prazo.
- A lista de Trilhas ganha busca e filtro (atrasadas, sem trilha, concluídas).

## 3. Calendário — arrastar e esticar, como no quadro de tarefas

- **Visão Semana:** segurar e arrastar a reunião para outro dia e horário, com encaixe de 15
  em 15 min. **Esticar a borda de baixo** do cartão aumenta ou diminui a duração.
- **Visão Mês:** arrastar muda só o dia e mantém o horário.
- Ao soltar, a reunião é remarcada pelo mesmo caminho do "Remarcar" de hoje. Isso atualiza o
  evento na Agenda Google, avisa os participantes, mantém o Fechamento D+7 e a regra da trilha,
  e tem um "Desfazer" por alguns segundos.
- Só arrasta quem tem `calendario.gerenciar`. No celular, segurar o cartão por meio segundo
  antes de arrastar, para não brigar com a rolagem.
- O mesmo arrastar entra no **calendário de publicações** (muda o dia e a hora do post; post
  aprovado e agendado volta a pedir agendamento, como já acontece ao editar a data).

## 4. Tarefas — mais fácil de usar

- **Links continuam**, como você disse: é o jeito de mandar ao editor a pasta do Drive com o
  material gravado. Vamos facilitar:
  - um botão **"Pasta do cliente no Drive"**, que já coloca o link da subpasta Captações do
    cliente da tarefa, sem precisar copiar e colar;
  - o link aparece em destaque no cartão, com o ícone da pasta.
- **"Enviar para o cliente aprovar"** dentro da tarefa (item 1).
- Ajustes de uso que vão junto:
  - modelo de tarefa por função (ex.: "Edição de vídeo" já vem com checklist e prazo padrão);
  - criar a tarefa a partir do cartão do cliente;
  - atalhos na tarefa para "Concluir" e "Mandar para Revisão".

## 5. Mapas — igual ao fluxo das organizações

- Trocar o desenho feito à mão pelo **mesmo motor do fluxo** (`@xyflow/react`). A tela se
  movimenta com arrastar e zoom, os blocos ligam por alças e há mini-mapa e "centralizar".
- **Paleta de blocos da agência:** cada bloco já faz uma função, e você só coloca e liga. Os
  blocos ficam agrupados na paleta como no fluxo das organizações. Todo bloco tem responsável
  (pessoa ou função), prazo, checklist, cor e executor (pessoa ou IA, quando couber).

  **Reuniões e comercial (Etapa 1)**

  | Bloco | O que faz quando chega a vez |
  |---|---|
  | Apresentação | marca a reunião de Apresentação (Meet se online) com a pauta do apêndice A |
  | Preparar proposta | cria a tarefa da proposta, com rascunho pela IA (opcional) |
  | Fechamento | marca a reunião de Fechamento (D+7 da Apresentação, que arrasta junto) |
  | Gerar contrato | gera o contrato do modelo escolhido e espera assinado **e** pago |
  | Esperar assinatura e pagamento | trava o caminho até o contrato ser concluído; mostra o prazo de 5 dias |
  | Proposta expirada / recusa | desvio: nova proposta ou cliente para o remarketing |
  | Grupo do WhatsApp | cria o grupo do cliente com a equipe dele |
  | Formulário de acesso | manda o link do formulário (72 h) e espera a resposta |
  | Ativação | marca a reunião de ativação (até 7 dias depois de assinar e pagar) |

  **Produção de conteúdo (Etapas 2 e 3)**

  | Bloco | O que faz quando chega a vez |
  |---|---|
  | Pautas do mês (IA) | a IA lista as pautas; uma pessoa confere |
  | Roteiro | tarefa do roteirista (ou da IA); pode mandar direto para aprovação |
  | Storyboard | tarefa do storyboard ligada ao roteiro |
  | Gravação / captação | tarefa e reunião de gravação no calendário, com a lista de cenas |
  | Subir material | tarefa de subir o bruto para a pasta Captações do cliente no Drive |
  | Edição de vídeo | tarefa do editor, já com o link da pasta Captações |
  | Fotos / tratamento | tarefa do designer com as fotos da captação |
  | Arte | tarefa do designer (depende da identidade visual) |
  | Legenda (IA) | a IA escreve a legenda; uma pessoa confere |
  | Enviar para aprovação | cria o envio em **Envios** (vídeo, arte ou roteiro) e espera a resposta do cliente |
  | Aviso ao cliente | manda o aviso de texto em **Envios** e espera o "Ciente" |
  | Publicação | cria o post no calendário de publicações (à mão ou publicar sozinho) |

  **Redes, anúncios e entregas (Etapa 2 e serviços avulsos)**

  | Bloco | O que faz quando chega a vez |
  |---|---|
  | Identidade visual | tarefa de padronizar a identidade; libera as artes |
  | Atualizar perfis | checklist por rede (Instagram, Facebook, Google, YouTube, TikTok) |
  | Árvore de links | tarefa da árvore de links (rascunho pela IA) |
  | Acesso ao CRM | cria ou confere a organização do cliente no CRM |
  | Campanha de reconhecimento / conversão | tarefa do gestor de tráfego com o rascunho da IA (só texto; criar no Gerenciador de Anúncios continua com a pessoa) |
  | Relatório do mês | tarefa do relatório de resultados para o cliente |
  | Site / página | tarefa de desenvolvimento com etapas (briefing → layout → aprovação → no ar) |
  | Automação | tarefa de montar a automação (fluxo, WhatsApp) para o cliente |
  | Assessoria | reunião ou tarefa de assessoria recorrente |

  **Controle**

  | Bloco | O que faz |
  |---|---|
  | Marco | ponto de controle que uma pessoa conclui (ex.: "material em mãos") |
  | Esperar data | segura o caminho até um dia (ex.: dia 1 do mês de postagem; regra do dia 15) |
  | Repetir todo mês | no ciclo da Etapa 3, recria o trecho seguinte para o mês N + 1 |
  | Nota | só texto no mapa, sem efeito |

- **Mapas prontos para começar** (modelos que a pessoa abre e ajusta, em vez de começar em branco):
  - **Recorrente — Etapa 1** (Apresentação até Ativação);
  - **Recorrente — Etapa 2** (mês de preparação: vídeos e fotos, redes, campanhas, artes);
  - **Recorrente — Etapa 3** (ciclo mensal, com "Repetir todo mês");
  - **Avulsos:** Gravação, Tráfego, Site, Automação, Artes/design e Assessoria, cada um com o
    caminho curto do serviço, que você ajusta quando descrever os seus.
- O painel lateral muda conforme o bloco, como o `NodeConfigPanel` do fluxo. Ficam Criação e
  Ao vivo, como hoje: o banco e o motor da Fase 8a continuam, e mudam a tela e os tipos de
  bloco (coluna `tipo` com o vocabulário novo e `config` em JSON validado por bloco).
- No celular, a lista continua (o React Flow não é bom de usar com o dedo em tela pequena).

---

## Ordem sugerida e tamanho

| # | Item | Tamanho | Depende de |
|---|---|---|---|
| 1 | Trilhas (conserto + tela nova com reloginho) | pequeno | — |
| 2 | Envios + vídeo, arte e texto dentro do sistema + Drive ao aprovar | grande | Drive conectado (só para provar a cópia) |
| 3 | Tarefas (pasta do Drive, enviar para aprovar, modelos) | médio | 2 |
| 4 | Calendário arrastar e esticar (reuniões e publicações) | médio | — |
| 5 | Mapas no motor do fluxo, com blocos que já fazem a função | grande | 2 (blocos de envio e aviso) |

Começar pelas Trilhas porque é rápido e conserta um defeito que você já viu. Depois vem Envios,
que é o que muda a rotina com os clientes.

## Decisões do dono (27/10/2026)

1. **Vídeo de até 2 GB** por arquivo. O limite do Storage do teste sobe de 50 MB para 2 GB.
2. **Drive desconectado:** o arquivo fica na VPS até conectar. A equipe vê o aviso, e nada se
   apaga sem a cópia confirmada.
3. O botão novo se chama **"Envios"**.
4. **Texto tem duas opções:** "Roteiro", que o cliente aprova ou pede ajustes, e "Aviso", que o
   cliente marca como **Ciente**, para mostrar que viu.
5. **Blocos do mapa:** a lista foi ampliada para montar as **três etapas do recorrente** e os
   **serviços avulsos**, com mapas prontos para começar (item 5).
6. **Arrastar vale também no calendário de publicações.**

---

## Andamento

### Item 2 — Trilhas: **feito, publicado e provado no teste em 27/10/2026**

- A trilha abre em `/agencia/trilhas/<cliente>`, sem pular para Clientes. A lista de Trilhas
  tem o seletor "Ver a trilha de…", filtros (Todas, Com atraso, Em dia), busca e "Clientes sem
  trilha" (é por ali que se inicia uma).
- A tela do cliente virou linha do tempo por etapa: feito em verde, com a data; liberado em
  destaque; bloqueado apagado, com "Espera: …".
- **Reloginho** na ponta de cada passo que falta. Ele conta até o prazo (ou até a reunião
  marcada), mostra os segundos quando falta menos de um dia, fica amarelo a menos de 24 h e
  vermelho quando atrasa ("atrasado há 13 h 51 min 10 s"). O topo mostra o próximo prazo.
- A ficha do cliente só resume (passos e %) e tem o botão "Abrir a trilha". Os avisos da trilha
  passaram a apontar para a aba Trilhas.
- **Prova** (`docs/agencia/scripts/prova-trilhas.mjs`, evidências em
  `evidence/agencia-ajustes-trilhas/`):
  - abriu em `/agencia/trilhas/<id>`;
  - 4 passos concluídos, 7 liberados e 9 bloqueados, com 8 reloginhos nas três cores;
  - o reloginho anda (08 s → 10 s);
  - o marcador fica sobre a linha (centro 405 × linha 405, medido);
  - a troca de cliente e o filtro "Com atraso" funcionam;
  - o botão da ficha leva à aba Trilhas;
  - com 375 px não há rolagem lateral.
