#!/bin/bash
# Répétition des migrations 0010 → 0013 sur une copie locale de type production, puis restauration.
# Vérifie : (1) aucune donnée existante perdue, (2) chaque restauration rend exactement le schéma précédent.
set -u
export PATH=/usr/lib/postgresql/16/bin:$PATH
PORT=${PGPORT:-5499}; MIG=$(dirname "$0")/../serveur/supabase/migrations; RB=$(dirname "$0")/../serveur/supabase/rollback; STUBS=${STUBS:-/tmp/pgt}
P="psql -p $PORT -h localhost -U postgres -v ON_ERROR_STOP=1 -q -d rep"
OUT=/tmp/repetition; mkdir -p $OUT; ok=0; ko=0
res(){ if [ "$2" = "0" ]; then echo "✅ $1"; ok=$((ok+1)); else echo "❌ $1"; ko=$((ko+1)); fi; }
schema(){ pg_dump -p $PORT -h localhost -U postgres -s -d rep -n public -n private -n storage | grep -v '^--' | grep -v -E '^.(un)?restrict ' | sed '/^$/d' | sort > $1; }
TABLES="profiles companions bookings ledger audit_log notifications identity_checks settings disputes reviews companion_photos"
cols(){ for t in $TABLES; do echo "$t:$($P -tA -c "select string_agg(quote_ident(column_name), ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='$t'")"; done > $OUT/cols.txt; }
data(){ while IFS=: read t c; do echo "== $t $($P -tA -c "select md5(coalesce(string_agg(r, '|' order by r), '')) from (select row($c)::text r from $t) z")"; done < $OUT/cols.txt > $1; }
dropdb -U postgres -p $PORT -h localhost --if-exists rep 2>/dev/null; createdb -U postgres -p $PORT -h localhost rep
for f in $STUBS/pre.sql $STUBS/pre2.sql $STUBS/pre3.sql; do psql -p $PORT -h localhost -U postgres -q -d rep -f "$f" >/dev/null 2>&1; done
for f in $MIG/000[1-9]_*.sql; do $P -f "$f" >/dev/null 2>$OUT/err.txt || { echo "échec $f"; cat $OUT/err.txt; exit 1; }; done
# Données de type production (comptes, réservation payée, journal)
$P >/dev/null <<'SQL'
insert into auth.users(id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-0000000000a1','client@exemple.fr','{"first_name":"Sophie","last_name":"Martin","birth_date":"1980-01-01","city":"Paris"}'),
 ('00000000-0000-0000-0000-0000000000b1','acc@exemple.fr','{"first_name":"Camille","last_name":"Durand","birth_date":"1992-03-04","role":"companion","city":"Paris"}');
update profiles set identity_verified = true; update companions set verified = true, video_interview_ok = true, hourly_rate = 40, bio = 'Guide';
insert into bookings(client_id, companion_id, category, starts_at, hours, place, amount_service, amount_client_fee, amount_vat, amount_total, amount_commission, amount_payout, status)
 values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','culture', now() - interval '3 days', 2, 'Louvre', 80, 12, 2.4, 94.4, 16, 64, 'cloturee');
insert into ledger(booking_id, kind, amount) select id, 'Encaissement', 94.4 from bookings;
insert into audit_log(actor_id, action, ref) values ('00000000-0000-0000-0000-0000000000a1', 'Export RGPD', 'x');
insert into notifications(user_id, body) values ('00000000-0000-0000-0000-0000000000a1', 'Bienvenue');
SQL
schema $OUT/schema_0009.txt; cols; data $OUT/data_0009.txt
counts(){ $P -tA -c "select (select count(*) from profiles)||'/'||(select count(*) from companions)||'/'||(select count(*) from bookings)||'/'||(select count(*) from ledger)||'/'||(select count(*) from audit_log)||'/'||(select count(*) from notifications)"; }
C0=$(counts)
for f in $MIG/0010_*.sql $MIG/0011_*.sql $MIG/0012_*.sql; do $P -f "$f" >/dev/null 2>$OUT/err.txt; res "Application de $(basename $f)" $?; done
schema $OUT/schema_0012.txt
$P -f $MIG/0013_*.sql >/dev/null 2>$OUT/err.txt; res "Application de 0013_administration_securite.sql" $?
C1=$(counts); [ "$C0" = "$C1" ]; res "Aucune ligne perdue après 0010 → 0013 (profils/accompagnateurs/réservations/écritures/journal/notifications : $C1)" $?
data $OUT/data_0013.txt; diff -q $OUT/data_0009.txt $OUT/data_0013.txt >/dev/null; res "Contenu des données existantes identique (empreintes par table)" $?
$P -tA -c "select bio = 'Guide' and hourly_rate = 40 from companions" | grep -q t; res "Valeurs métier intactes (tarif, présentation)" $?
$P -f $RB/0013_down.sql >/dev/null 2>$OUT/err.txt; res "Restauration 0013 exécutée" $?
schema $OUT/schema_back_0012.txt; diff $OUT/schema_0012.txt $OUT/schema_back_0012.txt > $OUT/diff_0012.txt; res "Schéma revenu exactement à l'état 0012" $?
$P -f $RB/0012_0011_0010_down.sql >/dev/null 2>$OUT/err.txt; res "Restauration 0012 → 0010 exécutée" $?
schema $OUT/schema_back_0009.txt; diff $OUT/schema_0009.txt $OUT/schema_back_0009.txt > $OUT/diff_0009.txt; res "Schéma revenu exactement à l'état 0009 (production actuelle)" $?
C2=$(counts); [ "$C0" = "$C2" ]; res "Données toujours complètes après restauration ($C2)" $?
data $OUT/data_back.txt; diff -q $OUT/data_0009.txt $OUT/data_back.txt >/dev/null; res "Contenu des données identique à l'origine" $?
for f in $MIG/0010_*.sql $MIG/0011_*.sql $MIG/0012_*.sql $MIG/0013_*.sql; do $P -f "$f" >/dev/null 2>$OUT/err.txt || { res "Ré-application après restauration ($(basename $f))" 1; break; }; done; res "Ré-application complète possible après une restauration" $?
echo; echo "$ok/$((ok+ko)) vérifications réussies"; [ $ko = 0 ]
