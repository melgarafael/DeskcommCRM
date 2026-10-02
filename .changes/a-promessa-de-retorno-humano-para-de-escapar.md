---
impacto: capacidade_nova
secao: corrigido
titulo: O assistente para de prometer retorno ao cliente sem que alguém fique responsável
---

Medido em produção em 16 de setembro. O assistente escreveu ao cliente: *"Vou encaminhar as informações do site imobiliário para análise e te retorno com a proposta."* O cliente saiu da conversa esperando um orçamento — e ninguém ficou devendo nada, porque o sistema não registrou nada: nenhum caso para alguém resolver, nenhum retorno marcado, nenhum aviso na Central.

Existe uma trava exatamente para isso — o assistente não pode prometer que uma pessoa da empresa vai agir sem que alguém fique responsável. A trava disparou **uma vez**, o assistente reformulou a frase, e a segunda formulação **passou**. O sistema dependia de reconhecer promessa por palavra: exigia "equipe", "setor" ou "responsável" colado ao verbo, e um objeto no meio da frase ("as informações") já a despistava. De sete frases equivalentes medidas, **cinco passavam** — inclusive uma que escrevia "equipe".

Agora a trava também pergunta ao classificador que já roda a cada envio se a mensagem promete que alguém da empresa volta a falar com o cliente. Os dois sinais valem juntos: o antigo, que é de graça e imediato, e o novo, que pega o que a palavra não pega. **Nenhuma consulta a mais é feita** — a pergunta entrou na mesma que já existia.

Um detalhe que vale saber na hora de decidir: a camada que faz a segunda pergunta segue a escolha que já existe na tela do assistente, no painel de segurança, e só o administrador da empresa a muda. Desligando, o reconhecimento volta a ser só por palavra — isto é, aquelas cinco frases voltam a passar. Crédito: @paulolimajr77.
