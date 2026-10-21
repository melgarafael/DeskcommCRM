---
impacto: nada_mudou
secao: alterado
titulo: As telas do CRM deixam de consultar o login duas vezes só para conferir a verificação em duas etapas
---
Ao abrir uma tela, o CRM perguntava duas vezes ao servidor de autenticação quem está logado: uma para saber quem é a pessoa e outra para saber se ela tem a verificação em duas etapas cadastrada. A resposta era a mesma; agora a segunda pergunta reaproveita a primeira. Com o banco fora da VPS, é uma espera e um pedido a menos por tela, e a regra da verificação em duas etapas não muda. Crédito: @SrPascoa
