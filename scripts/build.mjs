// Prépare le dossier www/ : copie la bibliothèque Supabase et assemble la page de l'application.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "www/vendor"), { recursive: true });
copyFileSync(join(root, "node_modules/@supabase/supabase-js/dist/umd/supabase.js"), join(root, "www/vendor/supabase.js"));
const app = readFileSync(join(root, "src/app.html"), "utf8");
const page = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://js.stripe.com; frame-src https://js.stripe.com https://hooks.stripe.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://xaogettvtlhfejnvmowk.supabase.co https://*.stripe.com; connect-src https://xaogettvtlhfejnvmowk.supabase.co wss://xaogettvtlhfejnvmowk.supabase.co https://api.stripe.com">
<style>:root{padding:env(safe-area-inset-top,0) 0 env(safe-area-inset-bottom,0)}body{margin:0}</style>
<script src="vendor/supabase.js"></script><script src="config.js"></script>
</head><body>
${app}
</body></html>`;
writeFileSync(join(root, "www/index.html"), page);
console.log("www/index.html prêt (" + Math.round(page.length / 1024) + " Ko)");
