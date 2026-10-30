-- Keep the physical queue timer precise enough to match follow-up/outbox projections.
ALTER TABLE `automationQueue` MODIFY COLUMN `scheduledAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
