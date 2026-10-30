---
impacto: nada_mudou
secao: corrigido
titulo: Os crons de minuto param de consultar o banco quando não há trabalho
---

Numa instalação sem proposta presa e sem follow-up, seis rotas de cron consultavam o banco de minuto em minuto para voltar sempre vazias — era a maior parte do tráfego de um CRM parado. Agora elas perguntam uma vez por todas se existe trabalho, numa leitura só que vale 45 segundos e é compartilhada por todas as rotas no mesmo minuto.

`campaign-worker` e `historico-import` ficaram de fora desta peça: as duas já saem cedo pelo piso ocioso do #3731, que cobre `campanhas` e `historico` sem gastar requisição ao PostgREST. Duas leituras na mesma rota só somariam custo.

Quem tem trabalho não sente diferença: inscrição num fluxo de follow-up e proposta presa são vistas no minuto seguinte, e o que a própria rota acabou de criar (como a varredura de silêncio inscrevendo um contato) é visto na batida imediatamente seguinte, sem esperar a janela. Nada muda para quem opera a VPS: a função entra pela atualização normal, sem edição de arquivo. Crédito: @webtecnica.
