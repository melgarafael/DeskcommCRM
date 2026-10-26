/** ADR-0002: as tabelas só nascem quando o dono instala o módulo. */
import { moldeDeProvisionadora } from "./molde-de-provisionadora";
moldeDeProvisionadora({ modulo: "cadencias", tabelas: ["email_cadences", "email_cadence_enrollments", "email_cadence_events"], protecaoPropria: ["email_cadences", "email_cadence_enrollments", "email_cadence_events"] });
