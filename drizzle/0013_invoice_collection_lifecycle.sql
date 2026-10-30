-- Collection intent and evidenced payment promises; physical timers remain in automationQueue.
CREATE TABLE `invoiceCollectionSettings` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`invoiceId` varchar(36) NOT NULL,
	`contactId` varchar(36) NOT NULL,
	`senderIdentityId` varchar(36) NOT NULL,
	`revision` int NOT NULL DEFAULT 1,
	`enabled` boolean NOT NULL DEFAULT false,
	`onHold` boolean NOT NULL DEFAULT false,
	`holdReason` varchar(500),
	`graceDays` int NOT NULL DEFAULT 1,
	`maxNudges` int NOT NULL DEFAULT 3,
	`replyCursor` json NOT NULL,
	`lastEvaluatedAt` timestamp(3),
	`updatedById` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `invoiceCollectionSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `collection_invoice_unique` UNIQUE(`invoiceId`)
);
--> statement-breakpoint
CREATE TABLE `invoicePaymentPromises` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`invoiceId` varchar(36) NOT NULL,
	`revision` int NOT NULL,
	`amount` int NOT NULL,
	`currency` varchar(8) NOT NULL,
	`baselinePaid` int NOT NULL,
	`dueAt` timestamp(3) NOT NULL,
	`status` varchar(48) NOT NULL DEFAULT 'open',
	`evidence` text NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`commandHash` varchar(128) NOT NULL,
	`recordedById` int NOT NULL,
	`settledAt` timestamp(3),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `invoicePaymentPromises_id` PRIMARY KEY(`id`),
	CONSTRAINT `promise_invoice_revision_unique` UNIQUE(`invoiceId`,`revision`),
	CONSTRAINT `promise_command_unique` UNIQUE(`ownerId`,`idempotencyKey`)
);
--> statement-breakpoint
ALTER TABLE `invoiceCollectionSettings` ADD CONSTRAINT `invoiceCollectionSettings_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `invoiceCollectionSettings` ADD CONSTRAINT `invoiceCollectionSettings_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `invoiceCollectionSettings` ADD CONSTRAINT `invoiceCollectionSettings_contactId_contacts_id_fk` FOREIGN KEY (`contactId`) REFERENCES `contacts`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `invoiceCollectionSettings` ADD CONSTRAINT `invoiceCollectionSettings_senderIdentityId_emailIdentities_id_fk` FOREIGN KEY (`senderIdentityId`) REFERENCES `emailIdentities`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `invoiceCollectionSettings` ADD CONSTRAINT `invoiceCollectionSettings_updatedById_users_id_fk` FOREIGN KEY (`updatedById`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `invoicePaymentPromises` ADD CONSTRAINT `invoicePaymentPromises_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `invoicePaymentPromises` ADD CONSTRAINT `invoicePaymentPromises_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `invoicePaymentPromises` ADD CONSTRAINT `invoicePaymentPromises_recordedById_users_id_fk` FOREIGN KEY (`recordedById`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `collection_source_scan_idx` ON `invoiceCollectionSettings` (`enabled`,`lastEvaluatedAt`,`id`);
--> statement-breakpoint
CREATE INDEX `collection_owner_idx` ON `invoiceCollectionSettings` (`ownerId`,`invoiceId`);
--> statement-breakpoint
CREATE INDEX `promise_invoice_status_idx` ON `invoicePaymentPromises` (`ownerId`,`invoiceId`,`status`);
