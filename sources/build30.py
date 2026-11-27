# V3.0 : application mobile (sans administration) + espace de gestion web séparé (/gestion)
import os, re, shutil
h0 = open('base_v29.html').read()
mob = open('v30_mobile.js').read(); adm = open('v30_admin.js').read()
def rep(h, a, b, cnt=1):
    assert h.count(a) == cnt, (a[:90], h.count(a)); return h.replace(a, b)
def common(h, extra_js):
    mark = "/* ================= V2.5 — Mode connecté, lot 2"
    h = rep(h, mark, mob + "\n" + extra_js + "\n" + mark)
    # Onglets et écrans de l'administration fournis par le module (mobile : aucun)
    h = rep(h, "admin:['dashboard','disputes','users','settings','audit']", "admin:ADMIN_TABS")
    i = h.index("admin:{dashboard:()=>aPhoneSearch()"); j = h.index("}", h.index("audit:aAudit", i)) + 1
    h = h[:i] + "admin:ADMIN_VIEWS" + h[j:]
    h = rep(h, "default:return v29Click(a,el,id,v,b)||", "default:return v30AdminClick(a,el,id,v,b)||v30Click(a,el,id,v,b)||v29Click(a,el,id,v,b)||")
    h = rep(h, "  {const r29=v29Submit(k,f,d);if(r29)return r29}", "  {const r30=v30AdminSubmit(k,f,d)||v30Submit(k,f,d);if(r30)return r30}\n  {const r29=v29Submit(k,f,d);if(r29)return r29}")
    h = rep(h, "v28Init();v29Init();", "v28Init();v29Init();v30Init();v30AdminInit();")
    # Plus aucun lien vers l'administration dans l'application
    h = rep(h, '<div class="login-foot"><button class="linkbtn" data-a="role" data-v="admin">Accès administrateur Side by Side</button></div>', '')
    # Assurance responsabilité civile OBLIGATOIRE (contrat et CGU)
    h = rep(h, "Disposer d\\'une assurance responsabilité civile professionnelle (recommandée).", "Disposer d\\'une assurance responsabilité civile couvrant son activité rémunérée et déposer dans l\\'application une attestation à jour (obligatoire : sans attestation valide, aucune réservation ne peut être reçue).")
    h = rep(h, "Les accompagnateurs passent en plus un entretien vidéo avec l\\'équipe Side by Side et font valider leurs photos.'", "Les accompagnateurs passent en plus un entretien vidéo avec l\\'équipe Side by Side, font valider leurs photos et déposent une attestation d\\'assurance responsabilité civile à jour couvrant leur activité rémunérée.'")
    return h
STUB = "function v30AdminClick(){return false}function v30AdminSubmit(){return false}function v30AdminInit(){}"
# 1. Application mobile et démonstration
mobile = common(h0, STUB)
open('compagnon.html', 'w').write(mobile)
# 2. Espace de gestion : même code et même design, mode « administration uniquement », script externe (CSP stricte)
web = common(h0, adm)
web = rep(web, "{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,flowType:'pkce'}}", "{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,flowType:'pkce',storage:window.sessionStorage,storageKey:'sbs-gestion'}}")
web = rep(web, '</style>', 'body .tools .lang{display:none}main .wrap,header.top .wrap{max-width:1180px}.card.chart svg{max-height:260px;width:100%}nav.tabs .wrap{max-width:1180px;overflow-x:auto}nav.tabs button{min-width:84px}.login .login-in{max-width:460px}table.t{min-width:640px}\n</style>')
os.makedirs('gestion_build', exist_ok=True)
# scripts inline → fichier app.js
scripts = re.findall(r'<script>([\s\S]*?)</script>', web)
assert len(scripts) >= 1
js = '\n;\n'.join(scripts)
web_html = re.sub(r'<script>[\s\S]*?</script>', '', web)
web_html = web_html.replace('</body>', '<script src="app.js"></script>\n</body>', 1)
web_html = web_html.replace('<title>', '<meta name="robots" content="noindex, nofollow">\n<title>', 1)
open('gestion_build/app.js', 'w').write(js)
# Page complète : aucune ressource externe (polices hébergées sur le site), scripts en fichiers séparés
frag = re.sub(r'<link rel="(preconnect|stylesheet)" href="https://fonts\.(googleapis|gstatic)\.com[^>]*>\n?', '', web_html)
frag = frag.replace('<script src="app.js"></script>\n', '')
heads = ''.join(re.findall(r'<meta[^>]*>|<title>[\s\S]*?</title>|<style>[\s\S]*?</style>', frag))
body = re.sub(r'<meta[^>]*>|<title>[\s\S]*?</title>|<style>[\s\S]*?</style>', '', frag).strip()
heads = heads.replace('<title>Side by Side</title>', '<title>Gestion — Side by Side</title>').replace('<meta name="claude:viewport-fit-sides" content="cover">', '')
fonts = '''<style>@font-face{font-family:"Manrope";src:url("/assets/fonts/Manrope.woff") format("woff");font-weight:200 800;font-display:swap}
@font-face{font-family:"Cormorant Garamond";src:url("/assets/fonts/CormorantGaramond.woff") format("woff");font-weight:300 700;font-display:swap}
@font-face{font-family:"Cinzel";src:url("/assets/fonts/Cinzel.woff") format("woff");font-weight:400 900;font-display:swap}</style>'''
page = f'''<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
{heads}
<link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
{fonts}
</head>
<body>
{body}
<script src="vendor/supabase.js"></script>
<script src="config.js"></script>
<script src="app.js"></script>
</body>
</html>
'''
assert '<script>' not in page and 'fonts.googleapis' not in page
open('gestion_build/index.html', 'w').write(page)
open('gestion_build/config.js', 'w').write('''// Connexion de l'espace de gestion au serveur Side by Side (même projet Supabase que l'application).
// Clé PUBLIQUE uniquement : la sécurité est assurée par le serveur (rôles, double authentification, RLS).
// Ne jamais mettre ici la clé service_role ni une clé secrète.
window.SBS_CONFIG = {
  url: "https://xaogettvtlhfejnvmowk.supabase.co",
  key: "sb_publishable_n8hXjAPnzKKiBns6JxarVA_HVx8ZwXL",
  stripePk: ""
};
window.SBS_ADMIN_WEB = true;
''')
print('ok mobile', len(mobile), 'gestion', len(web_html), len(js), 'scripts', len(scripts))
