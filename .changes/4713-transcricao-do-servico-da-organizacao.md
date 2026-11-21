---
impacto: capacidade_nova
secao: adicionado
titulo: Cada empresa escolhe o próprio serviço de transcrição de áudio, com o próprio idioma
---

Numa instalação com mais de uma empresa, quem ouvia o áudio de todas era o serviço de transcrição configurado no servidor: uma empresa que apontasse outro serviço, ou recebesse áudio em espanhol, não tinha como pedir isso pela tela. Agora o ponto "Ouvir o áudio do cliente" tem uma terceira opção, "Serviço compatível com OpenAI", com o endereço do serviço, o modelo, a chave da própria empresa (a mesma credencial de provedor personalizado que ela já cadastra) e, se quiser, o idioma dos áudios. A escolha da empresa passa a valer antes do serviço do servidor, e o idioma dela não é mais o idioma da instalação. Quem não mexe em nada continua exatamente como estava: "Automático" usa o serviço do servidor, e o ElevenLabs (Scribe) segue como a primeira escolha de quem o selecionou. Se a opção for salva sem endereço, a tela explica o que falta e o áudio continua sendo transcrito pelo serviço do servidor, em vez de a chamada sair incompleta.
