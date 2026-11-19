---
impacto: nada_mudou
secao: corrigido
titulo: A auditoria da leitura do CPF passa a guardar o motivo na linha certa
---

Quando alguém abre a ficha de um contato e pede para ver o CPF, o sistema registra a leitura na auditoria. Só que o motivo informado (por exemplo, "conferência de cadastro") não ia para essa linha: ficava numa segunda linha, registrada como se o contato tivesse sido **atualizado** — o que não aconteceu. Quem filtrava a auditoria por leituras de CPF não encontrava o motivo de nenhuma delas.

Agora o motivo sai na própria linha da leitura do CPF, e a leitura da ficha deixa de gravar a linha de atualização.

Para quem lê o CPF por SQL nada muda: as duas formas de chamada continuam valendo, e a finalidade declarada na sessão segue sendo registrada quando não vem outra. Nenhuma ação é necessária na atualização.
