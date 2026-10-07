---
impacto: capacidade_nova
secao: adicionado
titulo: O CRM no celular ganha barra de abas, movimento nos sobrepostos e alvos de toque de 44px
---

Quem abria o CRM no celular navegava como num site: a única porta para trocar de seção era o hamburguer, e todo sobreposto do produto — gaveta, janela, menu, seletor, dica — aparecia de um quadro para o outro, sem transição. Agora há uma **barra de abas fixa no rodapé** com as quatro telas de uso diário (Inbox, Funis, Agenda, Desempenho) mais "Mais", que abre a gaveta com o inventário completo. A barra respeita exatamente o que o menu lateral mostraria: ela projeta a mesma lista de destinos, com o mesmo filtro de papel, módulos ligados, capacidades da organização e áreas do plano — porta que o menu esconde não aparece ali. Ela some acima de 768px, onde a barra lateral já está na tela.

**Os sobrepostos passaram a se mover, e a causa de não se moverem era uma classe que não existia.** O produto escrevia `animate-in`, `fade-in-0`, `zoom-in-95` e `slide-in-from-*` em oito componentes — eram ~24 ocorrências —, e essas classes vêm de um plugin que nunca foi instalado neste repositório. Classe que o Tailwind não conhece não gera CSS e não gera erro: tudo abria seco, com o build verde. A gaveta agora desliza do lado em que foi aberta, a janela entra com escala e opacidade, e a cortina escurece antes do conteúdo — nos tempos e curvas que a linguagem de movimento do produto já declarava.

**Quem usa movimento reduzido** continua chegando ao mesmo destino, sem o percurso: as animações encurtam, e as duas que significam "ainda estou trabalhando" — o esqueleto de carregamento e o indicador de progresso — continuam se movendo de propósito, porque um indicador parado diz "travei".

**O esqueleto de carregamento ficou visível.** Ele era desenhado numa cor que dá contraste 1,146:1 sobre branco — na prática, invisível: a tela parecia vazia em vez de carregando. Agora usa a cor que a equipe mediu como legível nos dois temas, e uma faixa atravessa o elemento em vez de piscar a opacidade (piscar fazia metade de cada ciclo desfazer o conserto).

**Alvos de toque, e o conserto foi nos primitivos.** Medido na tela em 360px, com conta real e sessão completa: campo de texto, aba, gatilho de seletor e botão passaram a ter 44px onde quem aciona é o dedo, e voltam ao compacto no laptop. Como a régua mudou no componente base, o conserto alcançou o produto inteiro de uma vez — Equipe, Atividades, Auditoria, Contatos, Respostas rápidas e Comandas foram a **zero** controles curtos; Conexões caiu de 7 para 1; o painel de Desempenho ficou em zero. Os dois botões da barra de cima (organização e busca) mediam 40×44 e 42×44 e apareciam em TODA tela.

O que sobra é deliberado: links de texto dentro de lista (texto não é controle) e as células de meia hora da grade da agenda, cuja densidade é decisão registrada no código.

**O aviso saiu de cima da navegação.** O toast usava o canto superior, e o mecanismo que o desenha usa largura cheia no celular — então ele virava uma faixa colada no topo, cobrindo hambúrguer, organização, busca e sino. Agora nasce embaixo, acima da barra de abas, pelo mesmo número que o conteúdo já desconta. **Isto muda o desktop também:** o aviso passou do canto superior direito para o inferior direito, que é o que a estratégia responsiva do produto sempre pediu.

**Campo de texto não dá mais zoom no iPhone.** O Safari amplia a página inteira quando um campo recebe foco com fonte menor que 16px, e os campos usavam 14px: tocar a busca, ou o campo de resposta da conversa, saltava a escala da tela — e sair do campo não desfazia o salto. No celular os campos passam a 16px; no laptop seguem como eram.

**Telas de espera e de erro deixaram de ser uma frase solta.** O painel de Desempenho dizia "Carregando…" numa linha cinza e, quando falhava, "Erro ao carregar métricas." em vermelho, sem ícone, sem explicação e sem nada para clicar. Agora a espera desenha a silhueta da tela e o erro tem ícone, explicação e um "Tentar de novo" que refaz a consulta.

**Três consertos de leitura na agenda**, todos medidos em 360px: o cartão de conectar o Google espremia a frase em ~100px e a quebrava em seis linhas — agora empilha; o cabeçalho cortava a data em "5 de outu…" — agora quebra em duas linhas e diz o dia inteiro; e os avatares de quem atende se sobrepunham com 32px, o que tornava impossível acertar o certo — agora ficam separados no celular e voltam a se sobrepor no laptop.

**O funil desliza coluna por coluna.** Cada etapa ocupa 85% da largura no celular (em vez de 320px fixos, que deixavam a etapa seguinte como uma fatia de poucos pixels) e a rolagem encaixa numa etapa inteira por gesto. E a caixa de seleção do card, que só aparecia no passar do mouse, agora é visível onde não existe mouse — sem ela, a ação em lote "Mover para…" era inalcançável e arrastar era a única forma de mover um card no celular.

**Áreas seguras (notch e indicador de home).** O documento declara `viewport-fit=cover` pela primeira vez, que é o pré-requisito técnico para `env(safe-area-inset-*)` devolver qualquer valor diferente de zero. Com ele, a barra de abas, o aviso de chamada recebida e o indicador de navegação deixam de nascer por baixo da barra de status e do indicador de home no iOS em tela cheia.

Nada disso exige ação de quem opera uma VPS: não há variável nova, nem passo de atualização, nem mudança de banco. Quem usa o produto no laptop não vê diferença de layout — as mudanças de tamanho e densidade voltam ao que eram acima dos pontos de corte.
