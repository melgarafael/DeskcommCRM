---
impacto: nada_mudou
secao: corrigido
titulo: Os crons de proposta param de agir sobre a empresa que desligou o módulo
---

Na tela Módulos por empresa, desligar Propostas escondia a tela daquela empresa, mas três trabalhos de fundo continuavam agindo nas propostas dela: a expiração diária vencia as propostas com prazo passado, o destravamento de envio devolvia a rascunho a proposta presa em "enviando", e o aviso de promessa de proposta sem proposta criada continuava abrindo na Central. Os três agora perguntam o módulo POR EMPRESA: a empresa que desligou fica de fora da rodada, as outras são processadas na mesma execução, a empresa sem linha continua herdando a instalação e um erro de leitura não processa ninguém. A instalação desligada não roda nenhum deles, e a resposta da rodada diz que foi por isso, em vez de devolver zero. Nada a fazer na VPS.
