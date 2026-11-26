// Préparation iOS (à lancer sur un Mac, après « npx cap add ios ») : lien de retour dans l'application,
// descriptions des autorisations exigées par Apple (Face ID, appareil photo, position, photos).
import { readFileSync, writeFileSync } from "node:fs";
const f = "ios/App/App/Info.plist";
let x = readFileSync(f, "utf8");
const add = (k, v) => { if (!x.includes(`<key>${k}</key>`)) x = x.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${k}</key>\n\t${v}\n</dict>\n</plist>\n`); };
add("CFBundleURLTypes", `<array><dict><key>CFBundleURLName</key><string>fr.zyntell.sidebyside</string><key>CFBundleURLSchemes</key><array><string>fr.zyntell.sidebyside</string></array></dict></array>`);
add("NSFaceIDUsageDescription", "<string>Side by Side utilise Face ID pour déverrouiller l'application, si vous l'activez.</string>");
add("NSCameraUsageDescription", "<string>Side by Side utilise l'appareil photo pour la vérification d'identité et votre photo de profil.</string>");
add("NSLocationWhenInUseUsageDescription", "<string>Votre position n'est partagée qu'en cas d'alerte SOS, avec votre accord.</string>");
add("NSPhotoLibraryUsageDescription", "<string>Pour choisir une photo de profil ou un justificatif.</string>");
writeFileSync(f, x);
console.log("Info.plist prêt pour TestFlight (lien de retour, Face ID, appareil photo, position, photos).");
