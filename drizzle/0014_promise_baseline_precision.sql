-- Cumulative receipts can exceed one signed INT even though each receipt fits.
ALTER TABLE `invoicePaymentPromises` MODIFY COLUMN `baselinePaid` bigint NOT NULL;
