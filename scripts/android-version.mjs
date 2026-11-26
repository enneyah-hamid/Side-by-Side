// Numéro de version de l'application Android et signature numérique stable.
// - versionName : celui de package.json (ex. 2.9.0) ; versionCode : toujours croissant (numéro de compilation GitHub + 1000).
// - Si les secrets ANDROID_KEYSTORE_B64 et ANDROID_KEYSTORE_PASSWORD existent, l'application est signée avec la clé
//   de Side by Side : chaque nouvelle version s'installe alors par-dessus la précédente, sans perte de données.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const code = 1000 + Number(process.env.BUILD_NUMBER || 0);
const f = "android/app/build.gradle";
let g = readFileSync(f, "utf8");
g = g.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
const signed = existsSync("android/app/side-by-side.keystore") && !!process.env.ANDROID_KEYSTORE_PASSWORD;
if (signed && !g.includes("signingConfigs {")) {
  g = g.replace(/android\s*\{/, `android {
    signingConfigs {
        release {
            storeFile file("side-by-side.keystore")
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias "sidebyside"
            keyPassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            storeType "pkcs12"
        }
    }`);
  g = g.replace(/buildTypes\s*\{\s*release\s*\{/, `buildTypes {
        release {
            signingConfig signingConfigs.release`);
}
writeFileSync(f, g);
console.log(`Version ${pkg.version} (code ${code}) · signature : ${signed ? "clé Side by Side" : "clé de test (installation par-dessus impossible)"}`);
