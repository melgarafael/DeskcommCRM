---
impacto: nada_mudou
secao: corrigido
titulo: Arquivo da primeira abordagem que nenhuma campanha usa sai do Storage depois de uma semana
---

O arquivo escolhido para a primeira abordagem subia para o Storage assim que era selecionado na tela. Se a pessoa trocasse de arquivo, desistisse da campanha ou apagasse a campanha, o anterior ficava no bucket para sempre — e, no self-host, esse bucket divide a cota de 1 GB com as mídias do atendimento. Um vídeo de abordagem pesa vários MB, então algumas trocas ocupavam uma fatia que o operador não via de onde vinha.

Agora a rodada diária de retenção varre a pasta de arquivos da abordagem de cada empresa e remove o que **nenhuma campanha referencia** e já passou de **7 dias** de carência. O que alguma campanha ainda aponta é preservado, por mais velho que seja; o que está dentro da carência é preservado; e nada fora da pasta da abordagem da própria empresa é tocado — mídia de atendimento, respostas rápidas e propostas ficam onde estão. Quando o Storage não informa a idade de um arquivo, ele também é preservado: sem prova de que está velho, não se apaga.

A remoção aparece no relatório da rodada com a contagem e os bytes, e a trilha de auditoria registra o caminho e o tamanho de cada arquivo removido. Nada muda na tela, no envio nem no formato do arquivo da campanha.

Contribuição de @webtecnica, a partir da issue #5139.
