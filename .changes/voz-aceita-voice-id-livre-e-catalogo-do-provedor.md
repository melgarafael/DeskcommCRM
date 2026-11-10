---
impacto: capacidade_nova
secao: adicionado
titulo: **A voz do agente mostra o catálogo do ElevenLabs com nome e idioma — e aceita um Voice ID colado**
---
A tela de voz em Agente de IA › Provedores passa a pedir ao ElevenLabs a lista de vozes da conta e a mostrar **nome e idioma**, não só o id congelado na última validação da credencial. Quem tem **voz própria ou contratada** na conta ElevenLabs e nunca a via na lista agora cola o id no campo e ele vale: a lista é atalho, não permissão — o `voice_id` salvo é usado como está no turno do agente, sem ser descartado nem "corrigido" por não constar do catálogo. Só o **formato** é conferido (letras, números, hífen e sublinhado, 8 a 64 caracteres), com a mensagem na tela antes de qualquer chamada paga. Se o provedor recusar a voz no uso — ou na prévia —, o motivo que **ele** devolveu aparece na tela, em vez de um "não foi possível" genérico. E se a listagem do ElevenLabs falhar, a tela não quebra: cai na lista da última validação da credencial, avisa que está nela, e o campo livre continua funcionando.
