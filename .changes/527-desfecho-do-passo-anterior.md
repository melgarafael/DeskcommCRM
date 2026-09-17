---
impacto: capacidade_nova
secao: corrigido
titulo: Condição por "Desfecho do passo anterior" volta a filtrar leads
---

A condição **Desfecho do passo anterior** — e a negação escrita com ela
("não é <classe>") — agora decide de verdade. O motor montava esse campo como
`null` fixo, então o filtro era decorativo: quem escrevia uma negação via o
fluxo mandar **todos** os leads pelo ramo da negativa, inclusive os que nunca
passaram por um passo de classificação, e o follow-up seguia calado pelo
caminho errado.

O que muda em quem opera a VPS:

- a condição passa a ler a classe escolhida pelo último passo de classificação
  da inscrição — o mesmo desfecho que o histórico da conversa mostra;
- lead **sem classificação** deixa de satisfazer a negativa: "não foi X" só vale
  para um lead que **foi classificado** com outra classe. Ausência de dado não
  prova a negativa (e `é`/`contém` já eram falsos nesse caso);
- vale conferir os fluxos que usam essa condição com `não é`: eles podem passar
  a desviar leads que antes seguiam reto por ali. Nada quebra e nada precisa ser
  reconfigurado — era o filtro que o dono da VPS achava que já estava valendo.
