// Déclaration DPI-DAC7 (CGI art. 1649 ter A) — construction du fichier XML et contrôles de conformité.
// Schéma OCDE DPI v1.0, avec les règles du cahier des charges DGFiP :
// MessageRefId « OP_année_SIREN_n° », montants en euros entiers (arrondi au plus proche),
// contrepartie déclarée NETTE (après commissions), commissions TTC, balises TaxesQn (variante DGFiP).
export type Operator = { siren: string; legalName: string; tradeName: string; street: string; postcode: string; city: string; vat?: string | null };
export type Seller = {
  companion_id: string; first_name: string; last_name: string; birth_date: string; postal_address: string | null;
  nif: string | null; siret: string | null; tax_country: string; birth_city: string | null; birth_country: string;
  legal_status?: string | null; business_name?: string | null; vat_number?: string | null;
  n: number[]; gross: number[]; fees: number[]; tips: number[];
};
export type Issue = { companion_id?: string; who: string; field: string; blocking: boolean; message: string };

export const EU = ["AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"];
export const euros = (x: number) => Math.round(Number(x) + 1e-9);                       // 0,50 € et plus : arrondi supérieur
export const consideration = (s: Seller, q: number) => euros(s.gross[q] - s.fees[q] + s.tips[q]);   // net versé (pourboires inclus)
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Adresse postale libre « 8 rue de Bretagne, 75003 Paris » → rue / code postal / ville
export function splitAddress(a: string | null) {
  const s = String(a ?? "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.*?)[,\s]+(\d{5})\s+(.+)$/);
  return m ? { street: m[1].replace(/,$/, "").trim(), postcode: m[2], city: m[3].trim() } : { street: "", postcode: "", city: "" };
}

export function checkOperator(op: Operator): Issue[] {
  const out: Issue[] = [];
  if (!/^\d{9}$/.test(op.siren ?? "")) out.push({ who: "Zyntell (opérateur)", field: "SIREN", blocking: true, message: "SIREN de la société non renseigné : obligatoire pour toute déclaration réelle" });
  if (!op.street || !/^\d{5}$/.test(op.postcode) || !op.city) out.push({ who: "Zyntell (opérateur)", field: "adresse", blocking: true, message: "Adresse du siège incomplète" });
  return out;
}
// Clé de contrôle (Luhn) du SIRET
export const luhn = (v: string) => /^\d+$/.test(v) && [...v].reverse().reduce((a, c, i) => { let d = Number(c); if (i % 2) { d *= 2; if (d > 9) d -= 9; } return a + d; }, 0) % 10 === 0;
export const isEntity = (s: Seller) => s.legal_status === "societe";
// Informations exigées selon le statut : particulier et micro-entrepreneur = personne physique ; société = entité
export function checkSeller(s: Seller): Issue[] {
  const entity = isEntity(s), who = entity && s.business_name ? s.business_name : `${s.first_name} ${s.last_name}`, out: Issue[] = [];
  const add = (field: string, message: string, blocking = true) => out.push({ companion_id: s.companion_id, who, field, blocking, message });
  const nif = (s.nif ?? "").replace(/\s/g, ""), siret = (s.siret ?? "").replace(/\s/g, ""), vat = s.vat_number ?? "";
  if (!s.legal_status) add("statut", "Statut à indiquer : particulier, micro-entrepreneur ou société");
  const a = splitAddress(s.postal_address);
  if (!a.city) add("adresse", "Adresse postale manquante ou incomplète (rue, code postal, ville)");
  if (!entity) {
    if (!s.first_name || !s.last_name || s.last_name === "-") add("nom", "Nom ou prénom manquant");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.birth_date ?? "")) add("naissance", "Date de naissance manquante");
    if (!s.birth_city) add("lieu de naissance", "Ville de naissance manquante (exigée par la DGFiP)");
    if (!nif) add("NIF", "Numéro d'identification fiscale manquant (déclaré « inconnu » si absent)", false);
    else if (s.tax_country === "FR" && !/^[0-3]\d{12}$/.test(nif)) add("NIF", "Numéro fiscal incorrect : 13 chiffres commençant par 0, 1, 2 ou 3");
  }
  if (s.legal_status === "micro" || entity) {
    if (!/^\d{14}$/.test(siret)) add("SIRET", "Numéro SIRET manquant ou incorrect (14 chiffres)");
    else if (!luhn(siret)) add("SIRET", "Numéro SIRET à vérifier (clé de contrôle invalide)", false);
  }
  if (entity && !s.business_name) add("raison sociale", "Raison sociale de la société manquante");
  if (vat.startsWith("FR") && !/^FR[0-9A-Z]{2}\d{9}$/.test(vat)) add("TVA", "Numéro de TVA intracommunautaire incorrect (FR + 2 caractères + SIREN)");
  if (!EU.includes(s.tax_country)) add("résidence", `Résidence fiscale hors Union européenne (${s.tax_country}) : à vérifier, vendeur possiblement non déclarable`, false);
  return out;
}

export function buildDpiXml(o: {
  operator: Operator; year: number; messageRefId: string; indic: "DPI401" | "DPI402" | "DPI403"; timestamp: string;
  opDocRefId: string; opDocType: string; opCorrDocRefId?: string | null;
  sellers: { s: Seller; docRefId: string; docType: string; corrDocRefId?: string | null }[];
  taxTag?: "TaxesQ" | "TaxQ";                       // « TaxesQ » : variante DGFiP ; « TaxQ » : schéma OCDE d'origine
}) {
  const T = o.taxTag ?? "TaxesQ", op = o.operator;
  const doc = (type: string, ref: string, corr?: string | null) =>
    `<dpi:DocSpec><stf:DocTypeIndic>${type}</stf:DocTypeIndic><stf:DocRefId>${esc(ref)}</stf:DocRefId>${corr ? `<stf:CorrDocRefId>${esc(corr)}</stf:CorrDocRefId>` : ""}</dpi:DocSpec>`;
  const q4 = (tag: string, f: (q: number) => number, money = true) =>
    [0, 1, 2, 3].map((q) => `<dpi:${tag}${q + 1}${money ? ' currCode="EUR"' : ""}>${f(q)}</dpi:${tag}${q + 1}>`).join("");
  const seller = ({ s, docRefId, docType, corrDocRefId }: typeof o.sellers[number]) => {
    const a = splitAddress(s.postal_address), nif = (s.nif ?? "").replace(/\s/g, "");
    const vat = s.vat_number ? `<dpi:VAT>${esc(s.vat_number)}</dpi:VAT>` : "";
    const addr = (type: string) => `<dpi:Address legalAddressType="${type}"><dpi:CountryCode>${s.tax_country}</dpi:CountryCode><dpi:AddressFix>${a.street ? `<dpi:Street>${esc(a.street)}</dpi:Street>` : ""}${a.postcode ? `<dpi:PostCode>${a.postcode}</dpi:PostCode>` : ""}<dpi:City>${esc(a.city)}</dpi:City></dpi:AddressFix></dpi:Address>`;
    // Société : vendeur « entité » (SIREN comme identifiant fiscal et numéro d'immatriculation, siège social)
    const siren = (s.siret ?? "").replace(/\s/g, "").slice(0, 9);
    const identity = isEntity(s)
      ? `<dpi:EntitySeller><dpi:Standard><dpi:EntSellerID><dpi:ResCountryCode>${s.tax_country}</dpi:ResCountryCode>` +
        (s.tax_country === "FR" && /^\d{9}$/.test(siren) ? `<dpi:TIN issuedBy="FR">${siren}</dpi:TIN><dpi:IN issuedBy="FR" INType="BRN">${siren}</dpi:IN>` : `<dpi:TIN unknown="true">NOTIN</dpi:TIN>`) +
        `${vat}<dpi:Name>${esc(s.business_name)}</dpi:Name>${addr("OECD304")}</dpi:EntSellerID></dpi:Standard></dpi:EntitySeller>`
      : `<dpi:IndividualSeller><dpi:Standard><dpi:IndSellerID>` +
        `<dpi:ResCountryCode>${s.tax_country}</dpi:ResCountryCode>` +
        (nif ? `<dpi:TIN issuedBy="${s.tax_country}">${esc(nif)}</dpi:TIN>` : `<dpi:TIN unknown="true">NOTIN</dpi:TIN>`) + vat +
        `<dpi:Name><dpi:FirstName>${esc(s.first_name)}</dpi:FirstName><dpi:LastName>${esc(s.last_name)}</dpi:LastName></dpi:Name>` + addr("OECD302") +
        `<dpi:BirthInfo><dpi:BirthDate>${s.birth_date}</dpi:BirthDate>${s.birth_city ? `<dpi:BirthPlace><dpi:City>${esc(s.birth_city)}</dpi:City><dpi:CountryInfo><dpi:CountryCode>${s.birth_country}</dpi:CountryCode></dpi:CountryInfo></dpi:BirthPlace>` : ""}</dpi:BirthInfo>` +
        `</dpi:IndSellerID></dpi:Standard></dpi:IndividualSeller>`;
    return `<dpi:ReportableSeller><dpi:Identity>${identity}</dpi:Identity>` +
      `<dpi:RelevantActivities><dpi:PersonalServices>` +
      `<dpi:Consideration>${q4("ConsQ", (q) => consideration(s, q))}</dpi:Consideration>` +
      `<dpi:NumberOfActivities>${q4("NumbQ", (q) => s.n[q], false)}</dpi:NumberOfActivities>` +
      `<dpi:Fees>${q4("FeesQ", (q) => euros(s.fees[q]))}</dpi:Fees>` +
      `<dpi:Taxes>${q4(T, () => 0)}</dpi:Taxes>` +
      `</dpi:PersonalServices></dpi:RelevantActivities>${doc(docType, docRefId, corrDocRefId)}</dpi:ReportableSeller>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<dpi:DPI_OECD xmlns:dpi="urn:oecd:ties:dpi:v1" xmlns:stf="urn:oecd:ties:dpistf:v1" xmlns:iso="urn:oecd:ties:isodpitypes:v1" version="1.0">` +
    `<dpi:MessageSpec><dpi:TransmittingCountry>FR</dpi:TransmittingCountry><dpi:ReceivingCountry>FR</dpi:ReceivingCountry><dpi:MessageType>DPI</dpi:MessageType>` +
    `<dpi:MessageRefId>${esc(o.messageRefId)}</dpi:MessageRefId><dpi:MessageTypeIndic>${o.indic}</dpi:MessageTypeIndic>` +
    `<dpi:ReportingPeriod>${o.year}-12-31</dpi:ReportingPeriod><dpi:Timestamp>${o.timestamp}</dpi:Timestamp></dpi:MessageSpec>` +
    `<dpi:DPIBody><dpi:PlatformOperator><dpi:ResCountryCode>FR</dpi:ResCountryCode><dpi:TIN issuedBy="FR">${esc(op.siren)}</dpi:TIN>` +
    `<dpi:IN issuedBy="FR" INType="BRN">${esc(op.siren)}</dpi:IN>${op.vat ? `<dpi:VAT>${esc(op.vat)}</dpi:VAT>` : ""}` +
    `<dpi:Name>${esc(op.legalName)}</dpi:Name><dpi:PlatformBusinessName>${esc(op.tradeName)}</dpi:PlatformBusinessName>` +
    `<dpi:Address legalAddressType="OECD304"><dpi:CountryCode>FR</dpi:CountryCode><dpi:AddressFix><dpi:Street>${esc(op.street)}</dpi:Street><dpi:PostCode>${esc(op.postcode)}</dpi:PostCode><dpi:City>${esc(op.city)}</dpi:City></dpi:AddressFix></dpi:Address>` +
    `<dpi:Nexus>RPONEX1</dpi:Nexus><dpi:AssumedReporting>false</dpi:AssumedReporting>${doc(o.opDocType, o.opDocRefId, o.opCorrDocRefId)}</dpi:PlatformOperator>` +
    o.sellers.map(seller).join("") + `</dpi:DPIBody></dpi:DPI_OECD>`;
}

// Lecture d'un compte rendu officiel (message de statut DPI au format XML) : statut, enregistrements en erreur
export function parseStatusMessage(xml: string) {
  const tag = (n: string) => new RegExp(`<(?:\\w+:)?${n}>([^<]*)</(?:\\w+:)?${n}>`, "g");
  const all = (n: string) => [...xml.matchAll(tag(n))].map((m) => m[1].trim());
  const original = all("OriginalMessageRefID")[0] ?? all("OriginalMessageRefId")[0] ?? "";
  const st = (all("Status")[0] ?? all("FileAcceptanceStatus")[0] ?? "").toLowerCase();
  const errors = [...xml.matchAll(/<(?:\w+:)?RecordError>([\s\S]*?)<\/(?:\w+:)?RecordError>/g)].map((m) => ({
    code: (m[1].match(/<(?:\w+:)?Code>([^<]*)</) ?? [])[1] ?? "", details: ((m[1].match(/<(?:\w+:)?Details[^>]*>([^<]*)</) ?? [])[1] ?? "").slice(0, 300),
    doc_ref_id: (m[1].match(/<(?:\w+:)?DocRefIDInError>([^<]*)</) ?? [])[1] ?? "" }));
  const fileErrors = [...xml.matchAll(/<(?:\w+:)?FileError>([\s\S]*?)<\/(?:\w+:)?FileError>/g)].length;
  const rejected = /reject|rejet/.test(st) || fileErrors > 0, accepted = /accept/.test(st);
  return { original, official: rejected ? "rejete" : accepted ? (errors.length ? "accepte_avec_erreurs" : "accepte") : "recu", errors };
}
