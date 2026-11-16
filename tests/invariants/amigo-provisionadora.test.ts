/** ADR-0002: as tabelas do Amigo só nascem quando o dono instala o módulo (#4227). */
import { moldeDeProvisionadora } from "./molde-de-provisionadora";
const TABELAS = ["amigo_connections", "amigo_credentials", "amigo_patient_links", "amigo_appointment_links", "amigo_operations"];
moldeDeProvisionadora({ modulo: "amigo", tabelas: TABELAS, protecaoPropria: TABELAS });
