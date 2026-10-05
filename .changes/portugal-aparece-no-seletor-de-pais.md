---
impacto: capacidade_nova
secao: adicionado
titulo: Portugal passa a aparecer no seletor de país, com a citação do RGPD revisada por IA
---

Em Configurações › Empresa, o seletor de país passa a oferecer Portugal ao lado do Brasil. Escolhido Portugal, o contato usa o NIF (com o dígito de controlo da Autoridade Tributária), o exemplo de telefone é `+351`, o prazo do pedido de titular conta os feriados portugueses, e o documento de acesso cita `RGPD art. 15.º (Regulamento (UE) 2016/679)` com o rótulo "Direito exercido" — no RGPD, "base legal" é o art. 6.º. O e-mail ao titular sai em português de Portugal, sem citar a LGPD, e mostra a validade do link no fuso da organização; o alarme ao encarregado deixa de citar a LGPD e diz que o prazo do sistema é interno e mais curto que o mês do art. 12.º, n.º 3 (o apagamento da loja avisado pela Nuvemshop, que não é pedido de titular, sai com rótulo próprio e sem esse prazo). A ingestão de conversas para a base de conhecimento continua mascarando CPF e CEP por baixo do NIF e do código postal, porque uma empresa em Portugal também atende clientes brasileiros.

**A revisão da citação foi feita por IA, por delegação do dono do produto (doc 88), em 2026-10-05. Não é parecer jurídico e não houve advogado em Portugal.** As fontes conferidas foram o RGPD em português (JO L 119 de 4.5.2016, com as retificações de 2018 e 2021), a Lei n.º 58/2019 e as Guidelines 01/2022 do EDPB; o registro completo está no cabeçalho de `lib/legal/perfil-do-pais.ts`. A tela diz isso a quem escolhe Portugal, com este aviso: a citação foi conferida numa revisão feita por IA, sem advogado em Portugal; os prazos do sistema (7 e 15 dias úteis) são mais curtos que o prazo legal de um mês, e o relatório de acesso ainda não traz todas as informações do art. 15.º; **trocar o país muda a regra do documento do contato — a partir daí, CPF enviado por API, importação ou integração é recusado como NIF inválido**; e o sistema não substitui o encarregado da proteção de dados, que deve confirmar os textos enviados aos titulares, sobretudo nas campanhas de marketing, que em Portugal, em regra, exigem consentimento prévio (Lei 41/2004, art. 13.º-A).

Hoje o único caminho que cria pedido de titular são os webhooks da Nuvemshop, que não abre loja em Portugal (reconferido em 2026-10-05). Uma organização portuguesa com loja Nuvemshop brasileira alcança o fluxo; nesse caso o titular é brasileiro e as duas leis podem valer, e citar só o RGPD fica incompleto. Um teste passa a reprovar qualquer caminho novo de criação de pedido até o relatório de acesso cumprir o art. 15.º inteiro.

O que NÃO muda: quem está no Brasil (ou nunca escolheu país) recebe o e-mail, o alarme, o PDF e o `data.json` exatamente como antes. Nenhuma instalação muda sozinha: Portugal só vale para a organização em que alguém o escolher.

Contribuição de @webtecnica (#2084, o perfil de Portugal) e de @maclevison (#1946, a issue que pediu o perfil e a revisão da citação).
