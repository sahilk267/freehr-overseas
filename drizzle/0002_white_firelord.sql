CREATE TABLE `emailIdentities` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`email` varchar(320) NOT NULL,
	`purpose` enum('owner','clients','talent','interviews','finance','privacy') NOT NULL,
	`status` enum('draft','active','disabled','unverified') NOT NULL DEFAULT 'draft',
	`displayName` varchar(160) NOT NULL DEFAULT 'FreelanceHR',
	`replyTo` varchar(320),
	`lastHealthCheckAt` timestamp,
	`lastHealthStatus` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `emailIdentities_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_identity_owner_email_unique` UNIQUE(`ownerId`,`email`)
);
--> statement-breakpoint
ALTER TABLE `emailIdentities` ADD CONSTRAINT `emailIdentities_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `email_identity_owner_status_idx` ON `emailIdentities` (`ownerId`,`status`);