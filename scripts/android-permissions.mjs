// Ajoute au fichier AndroidManifest.xml les autorisations utilisées par Side by Side.
import { readFileSync, writeFileSync } from "node:fs";
const f = "android/app/src/main/AndroidManifest.xml";
let x = readFileSync(f, "utf8");
const perms = ["android.permission.INTERNET", "android.permission.CAMERA", "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION", "android.permission.POST_NOTIFICATIONS", "android.permission.USE_BIOMETRIC"];
for (const p of perms) if (!x.includes(p)) x = x.replace("</manifest>", `    <uses-permission android:name="${p}" />\n</manifest>`);
writeFileSync(f, x);
console.log("Autorisations Android ajoutées.");
