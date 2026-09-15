ALTER TABLE `invoices` DROP INDEX `invoice_placement_unique`;--> statement-breakpoint
CREATE INDEX `invoice_placement_idx` ON `invoices` (`placementId`);
