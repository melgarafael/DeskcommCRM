---
impacto: nada_mudou
secao: corrigido
titulo: O CPF cadastrado aparece na ficha do contato e pode ser corrigido na edição
---

O CPF era gravado no cadastro (cifrado, com busca e duplicados funcionando), mas não aparecia em tela nenhuma: a ficha só sabia se havia CPF, e a edição do contato não tinha o campo. Para ver o número, o caminho era exportar a lista em CSV.

Agora a ficha do contato tem a linha **CPF** (NIF na organização portuguesa). Ela diz "Cadastrado" quando há documento, e gerente ou administrador vê o número no botão **Mostrar**, que pede ao servidor na hora — o número não vem junto com a ficha, e cada leitura fica na auditoria, como já ficava no export. Atendente vê só que há CPF, e a tela diz por quê. Em **Editar contato** entrou o campo do documento, com a mesma conferência do cadastro: vazio mantém o que está gravado, preenchido troca.

O CPF passa a ser cifrado só com os dígitos, como a importação já fazia; antes, o digitado com máscara era guardado com pontos e traço. As fichas antigas continuam como estão e aparecem formatadas igual na tela. Nenhuma ação é necessária na atualização.

Contribuição de @minhatribodigital (#4865).
