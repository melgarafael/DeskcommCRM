import { describe, expect, it } from "vitest";
import { mensagemDaRecusaDePublicacao, publicationFailureDiagnostic } from "@/lib/agenda/google/sync-executor";
import { GoogleHttpError } from "@/lib/agenda/google/transport";

describe("publication failure retains technical cause without private text",()=>{
  it("statement timeout is not a changed reservation or a lost lease",()=>{
    const error=Object.assign(new Error('private SQL text and client@example.test'),{code:'57014'});
    expect(mensagemDaRecusaDePublicacao(error,'POST')).not.toContain('compromisso mudou');
    const diagnostic=publicationFailureDiagnostic(error,'checkpoint',501,true);
    expect(diagnostic).toMatchObject({phase:'checkpoint',sqlstate:'57014',http_status:null,lease_lost:false,deadline_expired:true});
    expect(JSON.stringify(diagnostic)).not.toContain('private');expect(JSON.stringify(diagnostic)).not.toContain('@');
  });
  it.each(["40001", "PT409"])("only the native stale lease domain identifies loss of acquisition (%s)",(code)=>{
    const error=Object.assign(new Error('google_stale'),{code});
    expect(publicationFailureDiagnostic(error,'renew',5)).toMatchObject({domain:'google_stale',lease_lost:true});
    expect(mensagemDaRecusaDePublicacao(error,'POST')).toContain('compromisso mudou');
    const other=Object.assign(new Error('unrelated detail'),{code:'40001'});
    expect(mensagemDaRecusaDePublicacao(other,'POST')).not.toContain('compromisso mudou');
  });
  it("a Google HTTP refusal and a deadline remain different facts",()=>{
    expect(publicationFailureDiagnostic(new GoogleHttpError(403,null,{private:'secret'}),'write',4)).toMatchObject({http_status:403,sqlstate:null});
    expect(publicationFailureDiagnostic(new DOMException('private','TimeoutError'),'read',4000,true)).toMatchObject({http_status:null,sqlstate:null,error_type:'TimeoutError'});
  });
});
