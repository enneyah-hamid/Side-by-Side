// Déclaration DPI-DAC7 (CGI art. 1649 ter A) — construction du fichier XML et contrôles de conformité.
// Schéma OCDE DPI v1.0, avec les règles du cahier des charges DGFiP :
// MessageRefId « OP_année_SIREN_n° », montants en euros entiers (arrondi au plus proche),
// contrepartie déclarée NETTE (après commissions), commissions TTC, balises TaxesQn (variante DGFiP).
export type Operator = { siren: string; legalName: string; tradeName: string; street: string; postcode: string; city: string; vat?: string | null };
export type Seller = {
  companion_id: string; first_name: string; last_name: string; birth_date: string; postal_address: string | null;
  nif: string | null; siret: string | null; tax_country: string; birth_city: string | null; birth_country: string;
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
export function checkSeller(s: Seller): Issue[] {
  const who = `${s.first_name} ${s.last_name}`, out: Issue[] = [];
  const add = (field: string, message: string, blocking = true) => out.push({ companion_id: s.companion_id, who, field, blocking, message });
  if (!s.first_name || !s.last_name || s.last_name === "-") add("nom", "Nom ou prénom manquant");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.birth_date ?? "")) add("naissance", "Date de naissance manquante");
  if (!s.birth_city) add("lieu de naissance", "Ville de naissance manquante (exigée par la DGFiP)");
  const a = splitAddress(s.postal_address);
  if (!a.city) add("adresse", "Adresse postale manquante ou incomplète (rue, code postal, ville)");
  if (!s.nif) add("NIF", "Numéro d'identification fiscale manquant (déclaré « inconnu » si absent)", false);
  if (s.tax_country === "FR" && s.nif && !/^\d{13}$/.test(s.nif.replace(/\s/g, ""))) add("NIF", "Le numéro fiscal français comporte 13 chiffres");
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
    return `<dpi:ReportableSeller><dpi:Identity><dpi:IndividualSeller><dpi:Standard><dpi:IndSellerID>` +
      `<dpi:ResCountryCode>${s.tax_country}</dpi:ResCountryCode>` +
      (nif ? `<dpi:TIN issuedBy="${s.tax_country}">${esc(nif)}</dpi:TIN>` : `<dpi:TIN unknown="true">NOTIN</dpi:TIN>`) +
      `<dpi:Name><dpi:FirstName>${esc(s.first_name)}</dpi:FirstName><dpi:LastName>${esc(s.last_name)}</dpi:LastName></dpi:Name>` +
      `<dpi:Address legalAddressType="OECD302"><dpi:CountryCode>${s.tax_country}</dpi:CountryCode><dpi:AddressFix>${a.street ? `<dpi:Street>${esc(a.street)}</dpi:Street>` : ""}${a.postcode ? `<dpi:PostCode>${a.postcode}</dpi:PostCode>` : ""}<dpi:City>${esc(a.city)}</dpi:City></dpi:AddressFix></dpi:Address>` +
      `<dpi:BirthInfo><dpi:BirthDate>${s.birth_date}</dpi:BirthDate>${s.birth_city ? `<dpi:BirthPlace><dpi:City>${esc(s.birth_city)}</dpi:City><dpi:CountryInfo><dpi:CountryCode>${s.birth_country}</dpi:CountryCode></dpi:CountryInfo></dpi:BirthPlace>` : ""}</dpi:BirthInfo>` +
      `</dpi:IndSellerID></dpi:Standard></dpi:IndividualSeller></dpi:Identity>` +
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
