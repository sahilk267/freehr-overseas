CREATE TABLE `teamMembers` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`memberUserId` int,
	`email` varchar(320) NOT NULL,
	`displayName` varchar(160),
	`role` enum('owner','recruiter','coordinator','finance','viewer') NOT NULL DEFAULT 'recruiter',
	`status` enum('invited','active','revoked') NOT NULL DEFAULT 'invited',
	`permissionOverrides` json,
	`joinedAt` timestamp,
	`revokedAt` timestamp,
	`createdById` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `teamMembers_id` PRIMARY KEY(`id`),
	CONSTRAINT `team_member_owner_email_unique` UNIQUE(`ownerId`,`email`)
);
--> statement-breakpoint
CREATE TABLE `teamInvitations` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`memberId` varchar(36) NOT NULL,
	`email` varchar(320) NOT NULL,
	`role` enum('owner','recruiter','coordinator','finance','viewer') NOT NULL,
	`tokenHash` varchar(128) NOT NULL,
	`status` enum('pending','accepted','revoked','expired') NOT NULL DEFAULT 'pending',
	`expiresAt` timestamp NOT NULL,
	`acceptedAt` timestamp,
	`revokedAt` timestamp,
	`createdById` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `teamInvitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `teamInvitations_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
ALTER TABLE `teamMembers` ADD CONSTRAINT `teamMembers_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teamMembers` ADD CONSTRAINT `teamMembers_memberUserId_users_id_fk` FOREIGN KEY (`memberUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teamMembers` ADD CONSTRAINT `teamMembers_createdById_users_id_fk` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teamInvitations` ADD CONSTRAINT `teamInvitations_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teamInvitations` ADD CONSTRAINT `teamInvitations_memberId_teamMembers_id_fk` FOREIGN KEY (`memberId`) REFERENCES `teamMembers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teamInvitations` ADD CONSTRAINT `teamInvitations_createdById_users_id_fk` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `team_member_owner_status_idx` ON `teamMembers` (`ownerId`,`status`);--> statement-breakpoint
CREATE INDEX `team_invite_owner_status_idx` ON `teamInvitations` (`ownerId`,`status`);--> statement-breakpoint
CREATE INDEX `team_invite_member_idx` ON `teamInvitations` (`memberId`);
