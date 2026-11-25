# Side by Side — serveur (Supabase + Stripe Connect)

## ✅ Déjà installé (25 novembre 2026)

- Projet Supabase **« Side by Side »**, organisation Zyntell, région **Paris (eu-west-3)**.
- Adresse du serveur : `https://xaogettvtlhfejnvmowk.supabase.co`
- Base de données : 20 tables protégées (5 migrations, dossier `supabase/migrations`), stockage privé `photos` et `documents`.
- 9 fonctions serveur en ligne : create-booking, create-payment, stripe-webhook, release-payout, refund-booking, tip, business-card, monthly-invoice, stripe-onboard.
- Contrôle de sécurité Supabase : aucune alerte, sauf la recherche admin par téléphone (voulue, réservée à l'admin).

Il reste à faire : les étapes 2 (Stripe), les secrets de l'étape 3 et l'étape 4 ci-dessous.
Les commandes `supabase functions deploy` de l'étape 3 ne sont plus nécessaires.

Ce dossier contient tout ce qu'il faut pour que l'application fonctionne pour de vrai :
la base de données (Supabase) et les paiements (Stripe Connect).

- `supabase/migrations/0001_side_by_side.sql` : toutes les tables, avec la sécurité par ligne.
  Chacun ne voit que ses propres données, et seul l'admin voit tout.
- `supabase/functions/` : les fonctions serveur (paiements, versements, remboursements…).

Le schéma a été testé sur PostgreSQL 16 avec 20 essais d'attaque, tous bloqués (voir « Sécurité » plus bas).

---

## 1. Créer le projet Supabase (10 min)

1. Créez un compte sur https://supabase.com, puis cliquez sur **New project**.
   - Région : **Europe (Paris ou Frankfurt)**, c'est important pour le RGPD.
   - Notez le mot de passe de la base.
2. Allez dans **SQL Editor**, collez tout le fichier `0001_side_by_side.sql`, puis cliquez sur **Run**.
3. Allez dans **Storage** et créez deux buckets **privés** :
   - `photos`
   - `documents`
4. Allez dans **Authentication → Providers** et activez :
   - **Email** ;
   - **Phone** (SMS via Twilio ou Vonage, pour le code SMS de l'inscription).
5. Allez dans **Project Settings → API** et notez :
   - `Project URL` ;
   - la clé `anon` (pour l'application) ;
   - la clé `service_role` (secrète, uniquement pour le serveur).

## 2. Créer le compte Stripe et activer Connect (30 min + validation Stripe)

1. Créez un compte sur https://stripe.com, au nom de la société (la future SASU Zyntell).
2. Allez dans **Connect → Get started** et choisissez **Platform or marketplace**, avec des comptes **Express**.
3. Allez dans **Developers → API keys** et notez la clé secrète `sk_test_...`.
   Commencez toujours en mode test.
4. Allez dans **Developers → Webhooks → Add endpoint** :
   - URL : `https://VOTRE-PROJET.supabase.co/functions/v1/stripe-webhook`
   - Événements : `payment_intent.succeeded`, `setup_intent.succeeded`, `account.updated`, `charge.dispute.created`
   - Notez le **Signing secret** `whsec_...`.

## 3. Installer les fonctions serveur

Sur un ordinateur, avec la Supabase CLI (https://supabase.com/docs/guides/cli) :

```bash
supabase login
supabase link --project-ref VOTRE-PROJET
supabase secrets set STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
  INTERNAL_KEY=une-longue-cle-secrete-au-hasard APP_ORIGIN=https://votre-domaine.fr
supabase functions deploy create-booking
supabase functions deploy create-payment
supabase functions deploy release-payout
supabase functions deploy refund-booking
supabase functions deploy tip
supabase functions deploy business-card
supabase functions deploy monthly-invoice
supabase functions deploy stripe-onboard
supabase functions deploy stripe-webhook --no-verify-jwt
```

## 4. Automatisations à brancher (Supabase → Database → Webhooks / Cron)

| Quand | Appeler |
|---|---|
| `bookings.end_client` **et** `end_companion` remplis | `release-payout`, avec l'en-tête `x-internal-key` |
| Le 1er de chaque mois à 6 h | `monthly-invoice` (facture des comptes entreprise) |
| Chaque nuit | publier les avis « à l'aveugle » de plus de 14 jours : `update reviews set status='publie' where status='aveugle' and created_at < now() - interval '14 days';` |

## Comment circule l'argent

1. **Le client paie Side by Side** : prestation + frais de service 15 % + TVA. L'argent reste sur le compte Stripe de la plateforme.
2. **Les deux valident « Je termine la mission »** : `release-payout` vire à l'accompagnateur la prestation moins 20 % de commission.
3. **Annulation** : `refund-booking` rembourse selon les règles (100 % au-delà de 48 h, 50 % entre 24 et 48 h, 0 % sous 24 h, et 24 h suffisent pour les membres Privilège).
4. **Pourboire** : il va à 100 % directement à l'accompagnateur.
5. **Entreprises** : la carte est enregistrée une fois (empreinte bancaire). Ensuite :
   - chaque réservation est débitée sur cette carte, dans la limite du plafond mensuel ;
   - une facture récapitulative est éditée chaque mois.

   Une pré-autorisation bancaire classique expire au bout de 7 jours. On enregistre donc la carte plutôt que de bloquer un montant.

Tous les prix sont recalculés par le serveur (`_shared/pricing.ts`). Le téléphone ne peut jamais imposer un montant.

## Ce qui reste à faire par un développeur

- **Brancher l'écran de l'application sur ces fonctions** : remplacer les données de démonstration par des appels Supabase, et intégrer Stripe Elements ou PaymentSheet pour la saisie de la carte.
- **Vérification d'identité réelle** : Ubble, Onfido ou Stripe Identity.
- **Envoi des e-mails** : Resend ou Brevo.
- **Factures en PDF.**
- **Notifications push.**
- **Applications iOS / Android** : React Native, Flutter ou Capacitor, avec Face ID et l'empreinte digitale.
- **Visio de l'entretien** (Daily ou Whereby) et **traduction automatique** des messages (DeepL).

## Sécurité

Règles en place dans la base (testées) :
- Chaque table est protégée par la sécurité au niveau des lignes : chacun ne voit que ses propres données.
- Un membre ne peut modifier que ses informations ordinaires (nom, téléphone, ville, contact de confiance, tarif et présentation pour un accompagnateur). Il ne peut pas se déclarer vérifié, se donner le Privilège, le statut Prestige, le rôle admin ou activer ses versements.
- Les réservations, les montants, les factures, la comptabilité et les cartes cadeaux ne peuvent être créés ou modifiés que par le serveur.
- Une carte cadeau ne peut pas être utilisée deux fois (déduction atomique).
- Un litige ou une alerte ne peut être ouvert que sur ses propres réservations.
- Les visiteurs non connectés ne voient rien.
- Les mineurs sont refusés par la base elle-même.

Les actions de l'admin (valider une identité, suspendre, publier un avis…) passent par des fonctions serveur
qui vérifient le rôle admin : ne jamais donner la clé `service_role` à l'application.

À faire au moment de l'installation :
1. **Clés secrètes** : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_KEY` uniquement dans les secrets Supabase, jamais dans l'application ni dans un e-mail.
2. **APP_ORIGIN** : indiquer l'adresse exacte du site (sinon le serveur refuse tous les appels du navigateur).
3. **Compte admin** : double authentification obligatoire (Authentication → MFA), mot de passe de 12 caractères minimum.
4. **Stockage** : buckets `photos` et `documents` privés ; ajouter les règles « chaque utilisateur n'accède qu'à son dossier `auth.uid()/…` » (Storage → Policies). La photo de référence n'est jamais publique.
5. **Limites de tentatives** : laisser actives les limites Supabase Auth (connexions, SMS) et activer la protection anti-robots (CAPTCHA) à l'inscription.
6. **Stripe** : activer Radar (anti-fraude) et 3D Secure ; ne jamais stocker de numéro de carte (Stripe s'en charge).
7. **Sauvegardes** : activer les sauvegardes quotidiennes (plan Pro) et l'hébergement en région Europe.
8. **Supervision** : Supabase → Advisors (sécurité et performances) à consulter chaque semaine.
