---
impacto: exige_acao
secao: corrigido
titulo: O follow-up automático escolhe o agente pelo número da conversa
---

Com mais de um WhatsApp na mesma organização, cada um com seu agente de IA, um lead que conversou no número A podia cair no fluxo do agente publicado no número B e receber a persona errada. Agora os gatilhos de silêncio, de caso e de retorno decidem o agente entre os que atendem no número em que a conversa aconteceu: o agente publicado naquele número e também o especialista de roteador de intenções que atende por ele — membro ou fallback do roteador ativo daquele número, mesmo quando publicado sem número próprio, como a 0749 permite. Quando não há nenhum agente atendendo naquele número, o fluxo que usa IA não inscreve o contato, em vez de cair no agente de outro número; fluxo só de texto fixo segue igual. Organização com um número só, com ou sem roteador de intenções, a tela de etapas do funil e o enrollment manual continuam exatamente como estavam.

## Requer atenção

Se a organização tem mais de um número, confira que quem atende cada fluxo de follow-up atende no número onde o fluxo deve rodar: publicado naquele número, ou membro/fallback do roteador ativo daquele número. Fluxo que antes disparava no número errado deixa de disparar, e o ajuste é publicar o agente no número certo, apontar o fluxo para o agente daquele número ou incluí-lo no roteador ativo.
