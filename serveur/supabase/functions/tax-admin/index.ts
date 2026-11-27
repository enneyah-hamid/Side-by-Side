// Fiscalité et déclarations DAC7 — réservé aux administrateurs (rôle admin + double authentification).
// Chaque consultation, génération, téléchargement et modification est journalisé.
// La transmission à la DGFiP se fait sur impots.gouv.fr après validation explicite d'un administrateur.
import { admin, json, serve, requireAdmin, requireStepUp, audit, notify, sha256, HttpError } from "../_shared/clients.ts";
import { buildDpiXml, checkOperator, checkSeller, consideration, euros, parseStatusMessage, type Operator, type Seller } from "../_shared/dpi.ts";

const PORTAL = "https://www.impots.gouv.fr/transfert-dinformations-en-application-des-dispositifs-dpi-dac7-plateformes-deconomie-collaborative";

async function operator(): Promise<Operator> {
  const { data: s } = await admin.from("settings").select("*").single();
  return { siren: s.operator_siren ?? "", legalName: s.operator_legal_name, tradeName: s.operator_trade_name, street: s.operator_street, postcode: s.operator_postcode, city: s.operator_city, vat: s.operator_vat };
}
async function sellers(year: number): Promise<Seller[]> {
  const { data, error } = await admin.rpc("tax_year_summary", { p_year: year });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ ...r, n: [r.n1, r.n2, r.n3, r.n4], gross: [r.g1, r.g2, r.g3, r.g4].map(Number), fees: [r.f1, r.f2, r.f3, r.f4].map(Number), tips: [r.t1, r.t2, r.t3, r.t4].map(Number) }));
}
// Comparaison indépendante de l'ordre des clés (la base réordonne les objets JSON)
const canon = (v: any): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);
const totalOf = (s: Seller) => ({ missions: s.n.reduce((a, b) => a + b, 0), consideration: [0, 1, 2, 3].reduce((a, q) => a + consideration(s, q), 0), fees: [0, 1, 2, 3].reduce((a, q) => a + euros(s.fees[q]), 0) });
const yearOk = (y: number) => Number.isInteger(y) && y >= 2023 && y <= new Date().getFullYear();
// Année en cours : interdite en production (déclaration sur une année close) ; autorisée uniquement dans l'environnement de test
const closedYear = (y: number) => y < new Date().getFullYear() || Deno.env.get("TAX_ALLOW_CURRENT_YEAR") === "1";
const ACTIVE = ["validee", "transmise", "acceptee", "a_corriger"];
// Étape affichée : à préparer, incomplet, prêt, transmis, accepté, rejeté, à corriger
function stage(decls: any[], blocking: boolean) {
  const base = decls.filter((d) => !["annulee", "brouillon"].includes(d.status)).pop(), draft = decls.some((d) => d.status === "brouillon");
  if (!base) return blocking ? "incomplet" : draft ? "pret" : "a_preparer";
  return ({ validee: "pret", transmise: "transmis", acceptee: "accepte", rejetee: "rejete", a_corriger: "a_corriger" } as Record<string, string>)[base.status] ?? "a_preparer";
}


serve(async (req) => {
  const me = await requireAdmin(req);
  if (["validate", "receipt", "import_receipt", "certificates"].includes(String((await req.clone().json().catch(() => ({}))).action))) requireStepUp(me);   // opérations sensibles
  const body = await req.json();
  const year = Number(body.year);
  switch (body.action) {
    case "overview": {                                      // tableau de bord de l'année choisie
      if (!yearOk(year)) throw new HttpError(400, "Année fiscale invalide");
      const [S, op, { count: total }, { data: decls }, { count: certs }] = await Promise.all([
        sellers(year), operator(), admin.from("companions").select("id", { count: "exact", head: true }),
        admin.from("tax_declarations").select("id, version, kind, status, message_ref_id, sellers, total_consideration, total_fees, validated_at, transmitted_at, receipt_ref, receipt_at, created_at, corrects, errors").eq("year", year).order("version"),
        admin.from("tax_certificates").select("id", { count: "exact", head: true }).eq("year", year).not("published_at", "is", null)]);
      const [{ data: breakdown }, { data: receipts }] = await Promise.all([admin.rpc("tax_breakdown", { p_year: year }),
        admin.from("tax_receipts").select("id, declaration_id, official_status, reference, file_name, errors, created_at").in("declaration_id", (decls ?? []).map((d) => d.id)).order("created_at")]);
      const issues = [...checkOperator(op), ...S.flatMap(checkSeller)];
      await audit(me.id, `Fiscalité ${year} : consultation du tableau de bord DAC7`);
      return json({ year, companions_total: total ?? 0, concerned: S.length,
        total_consideration: S.reduce((a, s) => a + totalOf(s).consideration, 0), total_fees: S.reduce((a, s) => a + totalOf(s).fees, 0),
        total_missions: S.reduce((a, s) => a + totalOf(s).missions, 0),
        sellers: S.map((s) => ({ companion_id: s.companion_id, name: `${s.first_name} ${s.last_name}`, ...totalOf(s), issues: checkSeller(s).length })),
        issues, blocking: issues.filter((i) => i.blocking).length, declarations: decls ?? [], certificates_published: certs ?? 0, deadline: `${year + 1}-01-31`, portal: PORTAL,
        stage: stage(decls ?? [], issues.some((i) => i.blocking)), breakdown: breakdown ?? [], receipts: receipts ?? [] });
    }
    case "verify": {                                        // contrôles de cohérence et de conformité
      if (!yearOk(year)) throw new HttpError(400, "Année fiscale invalide");
      const S = await sellers(year), issues = [...checkOperator(await operator()), ...S.flatMap(checkSeller)];
      if (body.notify) for (const id of [...new Set(issues.filter((i) => i.companion_id && i.blocking).map((i) => i.companion_id!))])
        await notify(id, `Informations fiscales ${year} incomplètes : complétez-les dans Revenus → Mes documents fiscaux.`, null, "fiscal");
      await audit(me.id, `Fiscalité ${year} : vérification (${issues.length} point(s), dont ${issues.filter((i) => i.blocking).length} bloquant(s))`);
      return json({ issues });
    }
    case "generate": {                                      // déclaration (brouillon) au format XML DGFiP
      if (!yearOk(year) || !closedYear(year)) throw new HttpError(400, "La déclaration porte sur une année terminée");
      const op = await operator(), S = await sellers(year);
      const blocking = [...checkOperator(op), ...S.flatMap(checkSeller)].filter((i) => i.blocking);
      if (blocking.length) throw new HttpError(409, `Déclaration impossible : ${blocking.length} information(s) obligatoire(s) manquante(s). Lancez « Vérifier les informations ».`);
      const { data: prev } = await admin.from("tax_declarations").select("*").eq("year", year).in("status", ACTIVE).order("version", { ascending: false });
      const correcting = body.correction === true;
      if (prev?.length && !correcting) throw new HttpError(409, "Une déclaration existe déjà pour cette année : utilisez « Corriger une déclaration »");
      if (!prev?.length && correcting) throw new HttpError(409, "Aucune déclaration à corriger pour cette année");
      await admin.from("tax_declarations").delete().eq("year", year).eq("status", "brouillon");      // un seul brouillon à la fois
      const { data: last } = await admin.from("tax_declarations").select("version").eq("year", year).order("version", { ascending: false }).limit(1);
      const version = (last?.[0]?.version ?? 0) + 1, stamp = new Date().toISOString().slice(0, 19);
      const msgRef = `OP_${year}_${op.siren}_${String(version).padStart(3, "0")}${Date.now().toString(36).toUpperCase()}`;
      // Correction : seuls les vendeurs dont les données ont changé sont renvoyés (OECD2 / suppression OECD3)
      let rows = S.map((s) => ({ s, docType: "OECD1", corr: null as string | null }));
      if (correcting) {
        const { data: recs } = await admin.from("tax_seller_records").select("companion_id, doc_ref_id, data, declaration_id").in("declaration_id", prev!.map((p) => p.id));
        const lastRec = new Map<string, any>(); for (const p of [...prev!].reverse()) for (const r of (recs ?? []).filter((r) => r.declaration_id === p.id)) lastRec.set(r.companion_id, r);
        const sig = (s: any) => JSON.stringify([s.first_name, s.last_name, s.birth_date, s.postal_address, s.nif, s.tax_country, s.birth_city, s.legal_status ?? null, s.business_name ?? null, s.vat_number ?? null, s.legal_status === "societe" ? s.siret : null, s.n, [0, 1, 2, 3].map((q) => consideration(s, q)), s.fees.map(euros)]);
        // Enregistrements signalés en erreur par l'administration : toujours renvoyés avec les données à jour
        const inError = new Set(prev!.flatMap((p: any) => (p.errors ?? []).map((e: any) => e.doc_ref_id)).filter(Boolean));
        rows = S.filter((s) => !lastRec.has(s.companion_id) || inError.has(lastRec.get(s.companion_id).doc_ref_id) || sig(lastRec.get(s.companion_id).data) !== sig(s))
          .map((s) => ({ s, docType: lastRec.has(s.companion_id) ? "OECD2" : "OECD1", corr: lastRec.get(s.companion_id)?.doc_ref_id ?? null }));
        if (!rows.length) throw new HttpError(409, "Aucune différence avec la déclaration transmise : rien à corriger");
      }
      const indic = correcting ? "DPI402" : S.length ? "DPI401" : "DPI403";
      const sellersX = rows.map((r, i) => ({ s: r.s, docRefId: `${msgRef}_V${String(i + 1).padStart(5, "0")}`, docType: r.docType, corrDocRefId: r.corr }));
      const xml = buildDpiXml({ operator: op, year, messageRefId: msgRef, indic, timestamp: stamp, opDocRefId: `${msgRef}_P`, opDocType: correcting ? "OECD0" : "OECD1", sellers: sellersX });
      const path = `${year}/${msgRef}.xml`;
      const up = await admin.storage.from("fiscal").upload(path, new Blob([xml], { type: "application/xml" }), { upsert: false });
      if (up.error) throw up.error;
      const tot = rows.reduce((a, r) => { const t = totalOf(r.s); return { c: a.c + t.consideration, f: a.f + t.fees }; }, { c: 0, f: 0 });
      const { data: d, error } = await admin.from("tax_declarations").insert({ year, version, kind: correcting ? "corrective" : S.length ? "initiale" : "neant", message_ref_id: msgRef, message_type_indic: indic,
        corrects: correcting ? prev![0].id : null, xml_path: path, xml_sha256: await sha256(xml), sellers: rows.length, total_consideration: tot.c, total_fees: tot.f, created_by: me.id }).select().single();
      if (error) throw error;
      if (sellersX.length) await admin.from("tax_seller_records").insert(sellersX.map((x) => ({ declaration_id: d.id, companion_id: x.s.companion_id, doc_ref_id: x.docRefId, doc_type_indic: x.docType, corr_doc_ref_id: x.corrDocRefId ?? null, data: x.s })));
      await audit(me.id, `Fiscalité ${year} : déclaration ${correcting ? "corrective" : "initiale"} générée (${msgRef}, ${rows.length} accompagnateur(s))`);
      return json({ declaration: d, xml });
    }
    case "validate": {                                      // validation administrateur obligatoire avant transmission
      const { data: d } = await admin.from("tax_declarations").update({ status: "validee", validated_by: me.id, validated_at: new Date().toISOString() }).eq("id", body.id).eq("status", "brouillon").select().single();
      if (!d) throw new HttpError(409, "Déclaration déjà validée ou introuvable");
      if (d.corrects) await admin.from("tax_declarations").update({ status: "annulee" }).eq("id", d.corrects).eq("status", "validee");
      await audit(me.id, `Fiscalité ${d.year} : déclaration ${d.message_ref_id} validée`);
      return json({ ok: true, portal: PORTAL });
    }
    case "download": {
      const { data: d } = await admin.from("tax_declarations").select("*").eq("id", body.id).single();
      if (!d?.xml_path) throw new HttpError(404, "Fichier introuvable");
      const f = await admin.storage.from("fiscal").download(d.xml_path);
      if (f.error) throw f.error;
      const xml = await f.data.text();
      if (await sha256(xml) !== d.xml_sha256) throw new HttpError(500, "Fichier archivé altéré : téléchargement bloqué");
      await audit(me.id, `Fiscalité ${d.year} : téléchargement du fichier ${d.message_ref_id}`);
      return json({ xml, name: `${d.message_ref_id}.xml` });
    }
    case "receipt": {                                       // accusé de réception de la DGFiP
      const ref = String(body.receipt_ref ?? "").trim();
      if (ref.length < 3) throw new HttpError(400, "Indiquez le numéro de l'accusé de réception");
      if (body.status === "acceptee" || body.status === "rejetee") throw new HttpError(409, "Acceptation ou rejet : importez le document officiel de l'administration fiscale");
      const status = "transmise";
      const { data: d } = await admin.from("tax_declarations").update({ status, receipt_ref: ref.slice(0, 120), receipt_at: body.receipt_at ?? new Date().toISOString(), transmitted_at: new Date().toISOString() })
        .eq("id", body.id).in("status", ["validee", "transmise"]).select().single();
      if (!d) throw new HttpError(409, "Seule une déclaration validée peut recevoir un accusé de réception");
      await audit(me.id, `Fiscalité ${d.year} : accusé de réception ${ref} enregistré (${status})`);
      return json({ ok: true });
    }
    case "certificates": {                                  // attestations annuelles, publiées après validation
      if (!yearOk(year)) throw new HttpError(400, "Année fiscale invalide");
      const { data: d } = await admin.from("tax_declarations").select("id").eq("year", year).in("status", ACTIVE).order("version", { ascending: false }).limit(1);
      if (!d?.length) throw new HttpError(409, "Validez d'abord la déclaration de l'année");
      const S = await sellers(year), now = new Date().toISOString();
      let created = 0;
      for (const s of S) {
        const t = totalOf(s), data = { year, name: `${s.first_name} ${s.last_name}`, quarters: [0, 1, 2, 3].map((q) => ({ missions: s.n[q], consideration: consideration(s, q), fees: euros(s.fees[q]), taxes: 0 })), ...t };
        const { data: ex } = await admin.from("tax_certificates").select("version, data").eq("companion_id", s.companion_id).eq("year", year).order("version", { ascending: false }).limit(1);
        if (ex?.length && canon(ex[0].data) === canon(data)) continue;            // déjà à jour : pas de doublon
        const { error } = await admin.from("tax_certificates").insert({ companion_id: s.companion_id, year, version: (ex?.[0]?.version ?? 0) + 1, declaration_id: d[0].id, data, published_at: body.publish ? now : null });
        if (!error) created++;
      }
      if (body.publish) {
        const { data: toPub } = await admin.from("tax_certificates").update({ published_at: now }).eq("year", year).is("published_at", null).select("companion_id");
        for (const c of new Set([...(toPub ?? []).map((x) => x.companion_id), ...(created ? S.map((s) => s.companion_id) : [])]))
          await notify(c, `Votre attestation fiscale ${year} est disponible dans Revenus → Mes documents fiscaux.`, null, "fiscal");
      }
      await audit(me.id, `Fiscalité ${year} : ${created} attestation(s) générée(s)${body.publish ? " et envoyée(s)" : ""}`);
      return json({ ok: true, created });
    }
    case "import_receipt": {                                // accusé de réception ou compte rendu officiel (XML ou PDF)
      const { data: d } = await admin.from("tax_declarations").select("*").eq("id", body.id).single();
      if (!d || !["validee", "transmise", "a_corriger"].includes(d.status)) throw new HttpError(409, "Seule une déclaration validée ou transmise peut recevoir un accusé");
      const name = String(body.file_name ?? "").replace(/[^\w.\- ]/g, "_").slice(0, 80), b64 = String(body.content_b64 ?? "");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new HttpError(400, "Fichier absent ou trop volumineux (5 Mo au plus)");
      const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46, text = isPdf ? "" : new TextDecoder().decode(bytes);
      if (!isPdf && !/^\s*(<\?xml|<)/.test(text)) throw new HttpError(400, "Format accepté : XML (compte rendu DGFiP) ou PDF");
      let official: string, errors: any[] = [], reference = String(body.reference ?? "").trim();
      if (!isPdf) {
        const p = parseStatusMessage(text);
        if (p.original && p.original !== d.message_ref_id) throw new HttpError(409, `Ce compte rendu concerne une autre déclaration (${p.original})`);
        official = p.official; errors = p.errors; reference = reference || p.original || d.message_ref_id;
        if (official === "recu" && body.official_status) official = String(body.official_status);
      } else {
        official = String(body.official_status ?? "");       // PDF : l'administrateur recopie le statut indiqué sur le document officiel
        if (!["recu", "accepte", "accepte_avec_erreurs", "rejete"].includes(official)) throw new HttpError(400, "Indiquez le statut figurant sur le document officiel");
      }
      if (reference.length < 3) throw new HttpError(400, "Indiquez la référence figurant sur le document officiel");
      const path = `${d.year}/accuses/${d.message_ref_id}-${Date.now()}.${isPdf ? "pdf" : "xml"}`;
      const up = await admin.storage.from("fiscal").upload(path, new Blob([bytes], { type: isPdf ? "application/pdf" : "application/xml" }), { upsert: false });
      if (up.error) throw up.error;
      await admin.from("tax_receipts").insert({ declaration_id: d.id, official_status: official, reference: reference.slice(0, 120), file_path: path, file_sha256: await sha256(isPdf ? b64 : text), file_name: name, errors, imported_by: me.id });
      const status = { recu: "transmise", accepte: "acceptee", accepte_avec_erreurs: "a_corriger", rejete: "rejetee" }[official]!;
      await admin.from("tax_declarations").update({ status, errors, receipt_ref: reference.slice(0, 120), receipt_at: new Date().toISOString(), transmitted_at: d.transmitted_at ?? new Date().toISOString() }).eq("id", d.id);
      // Une déclaration corrective acceptée solde les erreurs de la déclaration qu'elle corrige
      if (status === "acceptee" && d.corrects) await admin.from("tax_declarations").update({ status: "acceptee", errors: [] }).eq("id", d.corrects).eq("status", "a_corriger");
      await audit(me.id, `Fiscalité ${d.year} : document officiel importé pour ${d.message_ref_id} (${official}${errors.length ? `, ${errors.length} erreur(s)` : ""})`);
      return json({ ok: true, status, official, errors });
    }
    case "certificates_bundle": {                           // attestations de l'année pour le téléchargement groupé (ZIP)
      if (!yearOk(year)) throw new HttpError(400, "Année fiscale invalide");
      const { data: certs } = await admin.from("tax_certificates").select("companion_id, year, version, data, published_at").eq("year", year).order("version", { ascending: false });
      const latest = new Map<string, any>(); for (const c of certs ?? []) if (!latest.has(c.companion_id)) latest.set(c.companion_id, c);
      if (!latest.size) throw new HttpError(409, "Aucune attestation générée pour cette année");
      const S = new Map((await sellers(year)).map((s) => [s.companion_id, s]));
      const out = [...latest.values()].map((c) => { const s: any = S.get(c.companion_id) ?? {};
        return { ...c, nif: s.nif ?? null, postal_address: s.postal_address ?? null, tax_country: s.tax_country ?? "FR", legal_status: s.legal_status ?? null, business_name: s.business_name ?? null, siret: s.siret ?? null }; });
      await audit(me.id, `Fiscalité ${year} : téléchargement groupé de ${out.length} attestation(s)`);
      return json({ certificates: out });
    }
    case "export": {                                        // récapitulatif tableur (séparateur « ; », compatible Excel)
      if (!yearOk(year)) throw new HttpError(400, "Année fiscale invalide");
      const S = await sellers(year);
      const head = ["Année", "Nom", "Prénom", "Date de naissance", "Ville de naissance", "Adresse", "Pays de résidence fiscale", "NIF", "SIRET",
        ...[1, 2, 3, 4].flatMap((q) => [`Missions T${q}`, `Contrepartie nette T${q} (€)`, `Commissions T${q} (€)`]), "Missions", "Contrepartie nette (€)", "Commissions (€)", "Frais annexes remboursés (€)", "Informations complètes"];
      const cell = (v: unknown) => { const s = String(v ?? ""); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const lines = [head, ...S.map((s) => { const t = totalOf(s); return [year, s.last_name, s.first_name, s.birth_date, s.birth_city, s.postal_address, s.tax_country, s.nif, s.siret,
        ...[0, 1, 2, 3].flatMap((q) => [s.n[q], consideration(s, q), euros(s.fees[q])]), t.missions, t.consideration, t.fees, euros(Number((s as any).annex ?? 0)), checkSeller(s).some((i) => i.blocking) ? "non" : "oui"]; })];
      await audit(me.id, `Fiscalité ${year} : export du récapitulatif (${S.length} ligne(s))`);
      return json({ csv: "﻿" + lines.map((l) => l.map(cell).join(";")).join("\r\n"), name: `Side-by-Side-DAC7-${year}.csv` });
    }
    default: throw new HttpError(400, "Action inconnue");
  }
});
