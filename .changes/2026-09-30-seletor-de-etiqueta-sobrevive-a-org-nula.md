---
impacto: nada_mudou
secao: alterado
titulo: O seletor de etiqueta do atendimento passa a ter prova com dublês que respeitam a organização ativa
---

O conserto da #1336, que saiu na v1.42.0, fez o seletor de etiqueta do atendimento se apoiar no último vocabulário conhecido, para não sumir quando a lista de etiquetas volta indefinida por um instante. O teste novo usa dublês que respeitam a organização ativa, como os hooks reais, e passa a reprovar se o seletor deixar de consultar o vocabulário da organização. Ele também cobre um filtro já aplicado com uma etiqueta que saiu do vocabulário: durante a oscilação, essa etiqueta continua no menu, que é o único lugar onde dá para desmarcá-la. Nada muda no comportamento de quem opera: só a cobertura.

Contribuição de @webtecnica (#2045, refs #1336).
