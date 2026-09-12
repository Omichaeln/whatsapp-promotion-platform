-- 010: index the receipt's own printed identity, independently of the outlet.
--
-- The canonical key is outlet|date|number|total, where the OUTLET is the one the
-- participant selected — their own input. One physical receipt submitted twice
-- against two branches therefore produced two identities and two entries for a
-- single purchase (reproduced). The printed identity (date + number + total)
-- belongs to the receipt, so it is the layer that catches this.
--
-- receipt_no is stored as printed; the normalised form is what the canonical key
-- uses (uppercase, alphanumeric only), so it is stored alongside for lookup. The
-- backfill can only uppercase existing rows — new rows carry the exact form.
alter table canonical_receipts add column receipt_no_norm text;
update canonical_receipts set receipt_no_norm = upper(receipt_no) where receipt_no_norm is null and receipt_no is not null;
create index if not exists ix_canonical_printed_identity
  on canonical_receipts (campaign_id, txn_date, receipt_no_norm, total_minor);
