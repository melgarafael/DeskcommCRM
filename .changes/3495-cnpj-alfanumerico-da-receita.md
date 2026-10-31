---
impacto: capacidade_nova
secao: corrigido
titulo: Cadastro de empresa aceita o CNPJ alfanumérico da Receita e confere os dígitos verificadores
---

O cadastro de empresa recusava o CNPJ alfanumérico que a Receita passou a emitir — 12 posições de dígito ou letra e 2 dígitos verificadores. O documento certo voltava como "CNPJ inválido" na criação, na edição, na consulta e na importação de planilha. A cobrança já lia esse formato; o cadastro não.

Agora as quatro portas aceitam os dois formatos. A letra é guardada em maiúscula, então o mesmo documento digitado em caixa baixa e em caixa alta continua sendo uma empresa só. O dígito verificador é conferido pela mesma régua da cobrança: CNPJ com dígito trocado é recusado com a mensagem "CNPJ inválido: confira as 12 posições (dígitos ou letras) e os 2 dígitos verificadores.", em vez de entrar e virar empresa fantasma.

O CNPJ numérico continua entrando como antes. A atualização troca a regra do banco que só aceitava dígito na coluna do CNPJ normalizado; nada do que já está gravado muda.

Contribuição de @webtecnica (#3495).
