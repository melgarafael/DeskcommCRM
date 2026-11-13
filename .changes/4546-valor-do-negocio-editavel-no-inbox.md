---
impacto: capacidade_nova
secao: adicionado
titulo: O valor do negócio pode ser preenchido e corrigido no painel do Inbox, sem abrir o quadro
---

No Inbox, o bloco do negócio na lateral não tinha o **Valor do negócio**: o
número aparecia só para leitura em "Negócios recentes", e preencher ou corrigir
exigia sair da conversa, abrir o card no funil e voltar. Como a equipe fecha a
venda dentro da conversa, o valor ficava em branco e a previsão do funil, as
metas por vendedor e o Faturamento — que leem o `value_cents` oficial do
negócio — ficavam sem ele.

Agora há um campo **Valor do negócio** logo abaixo de "Etapa do funil", com a
moeda da organização (ou a do negócio, quando já gravada), aceitando
`1.234,56` e mostrando o valor entendido antes de salvar. A gravação usa o
MESMO caminho do quadro (`PATCH /api/v1/leads/[id]`, via `useEditLead`), então
o valor que chega é o `value_cents` inteiro em centavos e a alteração entra na
linha do tempo do negócio como as demais edições. Quem não pode editar o card
(`viewer`) continua vendo o valor, só que sem o campo — a mesma régua de
permissão do funil. Campo vazio ou inválido não apaga o valor existente.
Contribuição de @webtecnica (#4546).
