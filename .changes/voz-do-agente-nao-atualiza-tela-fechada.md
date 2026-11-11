---
impacto: nada_mudou
secao: corrigido
titulo: O cartão de voz do agente não atualiza a tela depois de ela já ter saído
---
O cartão "Voz deste agente" ignora a resposta que chega depois de a tela ser fechada. Para quem opera, nada muda; nos testes, some um erro solto (`window is not defined`) que derrubava a suíte de vez em quando mesmo com todos os casos passando. Crédito: @paulolimajr77.