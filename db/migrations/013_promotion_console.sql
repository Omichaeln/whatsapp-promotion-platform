-- Promotion console: the quantity a receipt actually bought, as a column.
--
-- The promotion administrator's first question about an entry is "how many packs
-- did they buy?", and they filter on it. The number was only ever inside
-- validation_results.rules_json, under the qualifying_product rule's detail, so
-- answering that needed a JSON walk over every row of the campaign and broke
-- whenever the rules shape changed. It is evidence about the purchase, so it
-- belongs on the receipt.
alter table receipts add column qualifying_packs integer;
alter table receipts add column qualifying_grams integer;

-- Backfill from the decision that was actually recorded. json_extract over the
-- rules array is fine ONCE, here; it is the query-time cost this column removes.
-- Rows whose extraction never ran, or ran under an older schema, stay null and
-- are shown as "not read" rather than as zero — a zero would read as "bought
-- nothing", which is a different statement from "we could not tell".
update receipts set
  qualifying_packs = (
    select cast(json_extract(r.value, '$.detail.primaryPacks') as integer)
      from validation_results v, json_each(v.rule_results_json) r
     where v.receipt_id = receipts.id
       and json_valid(v.rule_results_json)
       and json_extract(r.value, '$.key') = 'qualifying_product'
       and json_extract(r.value, '$.detail.primaryPacks') is not null
     order by v.attempt_no desc limit 1),
  qualifying_grams = (
    select cast(json_extract(r.value, '$.detail.totalGrams') as integer)
      from validation_results v, json_each(v.rule_results_json) r
     where v.receipt_id = receipts.id
       and json_valid(v.rule_results_json)
       and json_extract(r.value, '$.key') = 'qualifying_product'
       and json_extract(r.value, '$.detail.totalGrams') is not null
     order by v.attempt_no desc limit 1)
where exists (select 1 from validation_results v where v.receipt_id = receipts.id);

-- The promotion console's entry list filters on campaign + outlet and sorts by
-- recency; without this it scans the campaign's receipts for every page.
create index if not exists idx_receipts_promo_filter on receipts (campaign_id, selected_outlet_id, status, created_at desc);
