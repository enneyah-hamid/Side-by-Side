// Tests unitaires du fichier DAC7 : vendeur « entité » (société), vendeur particulier assujetti à la TVA,
// contrôles selon le statut et lecture des comptes rendus officiels. Le XML produit est ensuite validé
// contre le schéma officiel OCDE DPI v1.0 (étape suivante du workflow).
import { buildDpiXml, checkSeller, parseStatusMessage, luhn, type Seller } from "../serveur/supabase/functions/_shared/dpi.ts";

const base: Seller = { companion_id: "a", first_name: "Camille", last_name: "Durand", birth_date: "1992-03-04", postal_address: "8 rue de Bretagne, 75003 Paris",
  nif: "1234567890123", siret: null, tax_country: "FR", birth_city: "Rouen", birth_country: "FR", legal_status: "particulier",
  n: [1, 0, 2, 0], gross: [100, 0, 200, 0], fees: [20, 0, 40, 0], tips: [5, 0, 0, 0] };
const micro: Seller = { ...base, companion_id: "b", legal_status: "micro", siret: "73282932000074", vat_number: "FR44732829320" };
const soc: Seller = { ...base, companion_id: "c", legal_status: "societe", business_name: "Yanis Services SAS", siret: "73282932000074", vat_number: "FR44732829320", nif: null, birth_city: null, postal_address: "3 rue Verte, 76000 Rouen" };
const op = { siren: "123456789", legalName: "Zyntell SASU", tradeName: "Side by Side", street: "14 rue de Binche", postcode: "76150", city: "Maromme" };
const xml = buildDpiXml({ operator: op, year: 2026, messageRefId: "OP_2026_123456789_001TEST", indic: "DPI401", timestamp: "2027-01-10T10:00:00", opDocRefId: "OP_P", opDocType: "OECD1",
  sellers: [base, micro, soc].map((s, i) => ({ s, docRefId: `OP_V${i}`, docType: "OECD1" })), taxTag: "TaxQ" });
await Deno.writeTextFile("tests/dac7-exemple-entite-ocde.xml", xml);
const fail = (m: string) => { throw new Error(m); };

Deno.test("U01 société déclarée comme vendeur « entité » (raison sociale, SIREN, TVA, siège)", () => {
  if (!/<dpi:EntitySeller><dpi:Standard><dpi:EntSellerID><dpi:ResCountryCode>FR<\/dpi:ResCountryCode><dpi:TIN issuedBy="FR">732829320<\/dpi:TIN><dpi:IN issuedBy="FR" INType="BRN">732829320<\/dpi:IN><dpi:VAT>FR44732829320<\/dpi:VAT><dpi:Name>Yanis Services SAS<\/dpi:Name><dpi:Address legalAddressType="OECD304">/.test(xml)) fail(xml);
});
Deno.test("U02 micro-entrepreneur : personne physique, avec son numéro de TVA", () => {
  if ((xml.match(/<dpi:IndividualSeller>/g) ?? []).length !== 2 || !xml.includes('<dpi:TIN issuedBy="FR">1234567890123</dpi:TIN><dpi:VAT>FR44732829320</dpi:VAT><dpi:Name>')) fail("individuel");
});
Deno.test("U03 société : ni date ni lieu de naissance exigés", () => { const i = checkSeller(soc); if (i.some((x) => ["naissance", "lieu de naissance", "NIF"].includes(x.field))) fail(JSON.stringify(i)); });
Deno.test("U04 société sans raison sociale ni SIRET : bloquant", () => { const i = checkSeller({ ...soc, business_name: null, siret: null }); if (!i.some((x) => x.field === "raison sociale" && x.blocking) || !i.some((x) => x.field === "SIRET" && x.blocking)) fail(JSON.stringify(i)); });
Deno.test("U05 numéro fiscal français incorrect détecté", () => { if (!checkSeller({ ...base, nif: "9234567890123" }).some((x) => x.field === "NIF" && x.blocking)) fail("NIF"); });
Deno.test("U06 SIRET : clé de contrôle", () => { if (!luhn("73282932000074") || luhn("73282932000075")) fail("luhn"); });
Deno.test("U07 statut non renseigné : bloquant", () => { if (!checkSeller({ ...base, legal_status: null }).some((x) => x.field === "statut" && x.blocking)) fail("statut"); });
Deno.test("U08 compte rendu « accepté avec erreurs » : enregistrements en erreur extraits", () => {
  const p = parseStatusMessage(`<dpism:DPI_StatusMessage xmlns:dpism="urn:oecd:ties:dpism:v1"><dpism:MessageSpec><dpism:MessageRefId>SM1</dpism:MessageRefId></dpism:MessageSpec><dpism:DPIStatusMessage><dpism:OriginalMessage><dpism:OriginalMessageRefID>OP_X</dpism:OriginalMessageRefID></dpism:OriginalMessage><dpism:ValidationErrors><dpism:RecordError><dpism:Code>80010</dpism:Code><dpism:Details Language="FR">TIN invalide</dpism:Details><dpism:DocRefIDInError>OP_V1</dpism:DocRefIDInError></dpism:RecordError></dpism:ValidationErrors><dpism:ValidationResult><dpism:Status>Accepted</dpism:Status></dpism:ValidationResult></dpism:DPIStatusMessage></dpism:DPI_StatusMessage>`);
  if (p.original !== "OP_X" || p.official !== "accepte_avec_erreurs" || p.errors[0]?.doc_ref_id !== "OP_V1" || p.errors[0]?.details !== "TIN invalide") fail(JSON.stringify(p));
});
Deno.test("U09 compte rendu « rejeté » (erreur de fichier)", () => {
  const p = parseStatusMessage(`<SM><OriginalMessageRefID>OP_X</OriginalMessageRefID><ValidationErrors><FileError><Code>50005</Code></FileError></ValidationErrors><ValidationResult><Status>Rejected</Status></ValidationResult></SM>`);
  if (p.official !== "rejete") fail(JSON.stringify(p));
});
Deno.test("U10 document sans statut : simple accusé de réception (jamais « accepté » par défaut)", () => { if (parseStatusMessage("<AR><OriginalMessageRefID>OP_X</OriginalMessageRefID></AR>").official !== "recu") fail("recu"); });
