#!/bin/bash
# Tests de concurrence : 20 demandes simultanées sur le même créneau, 20 utilisations simultanées d'une carte cadeau
P="psql -U postgres -h localhost -p 5499 -d sbs -qtA"
$P -c "insert into gift_cards(code, amount, balance) values ('CADEAU50', 50, 50) on conflict do nothing;"
for i in $(seq 1 20); do
  $P -c "select t_ins('2032-05-05 15:00+00', 2);" > /tmp/c_book_$i.txt 2>&1 &
done; wait
echo "R01 20 réservations simultanées du même créneau → acceptées : $(cat /tmp/c_book_*.txt | grep -c '^inséré') (attendu : 1)"
ids=$($P -c "select id from bookings order by created_at limit 20")
for b in $ids; do
  $P -c "set role service_role; select hold_gift('$b','cadeau50','00000000-0000-0000-0000-00000000000a', 40);" > /tmp/c_gift_$b.txt 2>&1 &
done; wait
echo "R02 utilisations simultanées d'une carte de 50 € (40 € demandés chacune) → total réservé : $($P -c "select coalesce(sum(amount),0) from gift_holds where code='CADEAU50'") € ; solde restant : $($P -c "select balance from gift_cards where code='CADEAU50'") € (attendu : total 50, solde 0)"
b1=$(echo "$ids" | head -1)
$P -c "set role service_role; select release_gift('$b1'); select release_gift('$b1');" >/dev/null
echo "R03 libération rejouée deux fois → solde : $($P -c "select balance from gift_cards where code='CADEAU50'") € (attendu : 40 au plus, jamais plus que le montant libéré une fois)"
b2=$($P -c "select booking_id from gift_holds where status='held' limit 1")
$P -c "set role service_role; select consume_gift('$b2');" >/dev/null
for i in 1 2 3 4 5; do $P -c "set role service_role; select refund_gift('$b2', 100);" >/dev/null & done; wait
echo "R04 remboursement carte rejoué 5 fois en parallèle → remboursé : $($P -c "select refunded from gift_holds where booking_id='$b2'") € pour une réservation de $($P -c "select amount from gift_holds where booking_id='$b2'") € ; solde ≤ montant de la carte : $($P -c "select balance<=amount from gift_cards where code='CADEAU50'")"
$P -c "insert into profiles(id,role,first_name,last_name,birth_date) select gen_random_uuid(),'client','a','b','1990-01-01' where false;"
for i in $(seq 1 30); do $P -c "set role service_role; select rate_hit('00000000-0000-0000-0000-00000000000a','gift',5,60);" > /tmp/c_rate_$i.txt 2>&1 & done; wait
echo "R05 30 essais simultanés de codes cadeaux (limite 5/h) → autorisés : $(cat /tmp/c_rate_*.txt | grep -c '^t') (attendu : 5)"
rm -f /tmp/c_*.txt
