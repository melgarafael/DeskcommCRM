---
impacto: nada_mudou
secao: corrigido
titulo: A volta de versão pela tela só vai para a versão de onde a instalação veio
---

O botão Voltar em Configurações › Atualização sempre pediu a versão de onde a
última atualização saiu, e continua funcionando igual. O que muda é no
servidor: a cada atualização para frente, o kit guarda num arquivo local de qual
versão saiu, e o agente da VPS só aceita voltar para essa versão quando o pedido
vem da tela. Um pedido de volta para qualquer outra versão anterior fecha como
recusado, com a explicação na própria tela. Voltar para outra versão continua
possível pelo terminal, com `bash hostgator-setup-kit/update.sh --to <versão> --force`.
Instalação que atualizou antes desta versão ainda não tem o arquivo: a primeira
volta pela tela é recusada, e a partir da próxima atualização o botão volta a
funcionar.
