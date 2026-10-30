-- Replace the supporting index atomically so the placement foreign key stays valid.
ALTER TABLE `invoices`
  ADD INDEX `invoice_placement_idx` (`placementId`),
  DROP INDEX `invoice_placement_unique`;
