// Ajoute au fichier AndroidManifest.xml les autorisations utilisées par Side by Side,
// le lien de retour dans l'application (fr.zyntell.sidebyside://) pour la confirmation d'e-mail,
// le mot de passe oublié et la connexion Google / Apple, et le redimensionnement de l'écran quand le clavier s'ouvre.
import { readFileSync, writeFileSync } from "node:fs";
const f = "android/app/src/main/AndroidManifest.xml";
let x = readFileSync(f, "utf8");
const perms = ["android.permission.INTERNET", "android.permission.CAMERA", "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION", "android.permission.POST_NOTIFICATIONS", "android.permission.USE_BIOMETRIC"];
for (const p of perms) if (!x.includes(p)) x = x.replace("</manifest>", `    <uses-permission android:name="${p}" />\n</manifest>`);
if (!x.includes('android:scheme="fr.zyntell.sidebyside"')) {
  x = x.replace(/(<activity[^>]*MainActivity[\s\S]*?)(<\/activity>)/, `$1    <intent-filter android:autoVerify="false">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="fr.zyntell.sidebyside" />
            </intent-filter>
        $2`);
}
if (!/windowSoftInputMode/.test(x)) x = x.replace(/(<activity[^>]*?)(android:name="[^"]*MainActivity")/, `$1android:windowSoftInputMode="adjustResize" $2`);
writeFileSync(f, x);
console.log("Autorisations, lien de retour et clavier Android configurés.");
