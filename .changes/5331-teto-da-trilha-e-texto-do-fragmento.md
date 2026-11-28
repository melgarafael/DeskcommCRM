---
impacto: nada_mudou
secao: corrigido
titulo: Retenção › a trilha da varredura diária não cresce mais com o backlog de arquivos
---

A rodada diária de retenção que varre a pasta de arquivos da abordagem (#5139) registrava, na linha `retention.sweep_run` da auditoria, o caminho e o tamanho de **cada** arquivo removido. Numa instalação que acumulou arquivos — e o arquivo da abordagem é um vídeo de vários MB, trocado a cada ajuste de campanha —, a primeira rodada levava milhares de caminhos para o metadata de uma única linha de `api_audit_log`: a linha ia para TOAST e a tela de auditoria, que abre o metadata inteiro, ficava impraticável.

Agora a trilha é uma amostra declarada de até 50 caminhos por rodada. O total real continua no campo de contagem (`arquivos_orfaos_da_abordagem_removidos`), o que não coube na amostra aparece contado em `arquivos_orfaos_da_abordagem_caminhos_omitidos`, e a soma dos dois fecha com o total — nada é truncado em silêncio. Nenhuma poda mudou: o que sai do Storage é o mesmo, e a contagem e os bytes removidos continuam os mesmos.

O texto da entrada de 1.128.0 sobre o mesmo assunto foi corrigido: campanha não se apaga, só se arquiva, e a campanha arquivada continua apontando para o arquivo — o órfão nasce de quem troca de arquivo ou desiste **antes** de salvar. A partir da issue #5331.
