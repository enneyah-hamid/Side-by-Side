// Test unitaire des origines autorisées (la passerelle Supabase locale remplace les en-têtes CORS, d'où ce test direct)
import { corsHeaders } from "../serveur/supabase/functions/_shared/clients.ts";
const h = (o: string) => corsHeaders(new Request("http://x", { headers: { Origin: o } }))["Access-Control-Allow-Origin"];
Deno.test("C01 application Android (https://localhost) autorisée", () => { if (h("https://localhost") !== "https://localhost") throw new Error(h("https://localhost")); });
Deno.test("C02 application iOS (capacitor://localhost) autorisée", () => { if (h("capacitor://localhost") !== "capacitor://localhost") throw new Error(); });
Deno.test("C03 site web déclaré dans APP_ORIGIN autorisé", () => { if (h("https://sidebyside.example") !== "https://sidebyside.example") throw new Error(); });
Deno.test("C06 espace de gestion (https://sidebyside.zyntell.fr) autorisé", () => { if (h("https://sidebyside.zyntell.fr") !== "https://sidebyside.zyntell.fr") throw new Error(); });
Deno.test("C07 sous-domaine imitant la gestion refusé", () => { if (h("https://sidebyside.zyntell.fr.pirate.example") !== undefined) throw new Error(); });
Deno.test("C04 site pirate refusé (aucun en-tête)", () => { if (h("https://site-pirate.example") !== undefined) throw new Error(h("https://site-pirate.example")); });
Deno.test("C05 jamais « * »", () => { if (h("*") !== undefined) throw new Error(); });
