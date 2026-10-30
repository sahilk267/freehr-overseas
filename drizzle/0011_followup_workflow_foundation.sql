CREATE TABLE `automationGrants` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`planId` varchar(36) NOT NULL,
	`planRevision` int NOT NULL,
	`scopeHash` varchar(128) NOT NULL,
	`maxSends` int NOT NULL,
	`expiresAt` timestamp(3) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`createdById` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `automationGrants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `emailDispatches` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`messageId` varchar(36) NOT NULL,
	`approvalId` varchar(36) NOT NULL,
	`planId` varchar(36),
	`planRevision` int,
	`stepIndex` int,
	`grantId` varchar(36),
	`recipientHash` varchar(128) NOT NULL,
	`status` varchar(48) NOT NULL DEFAULT 'queued',
	`scheduledAt` timestamp(3) NOT NULL,
	`claimedAt` timestamp(3),
	`completedAt` timestamp(3),
	`lastError` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `emailDispatches_id` PRIMARY KEY(`id`),
	CONSTRAINT `dispatch_approval_unique` UNIQUE(`approvalId`),
	CONSTRAINT `dispatch_message_unique` UNIQUE(`messageId`)
);
--> statement-breakpoint
CREATE TABLE `followUpPlans` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`conversationId` varchar(36) NOT NULL,
	`candidateId` varchar(36),
	`senderIdentityId` varchar(36) NOT NULL,
	`recipient` varchar(320) NOT NULL,
	`recipientHash` varchar(128) NOT NULL,
	`scenarioId` varchar(8) NOT NULL,
	`resourceType` varchar(32) NOT NULL,
	`resourceId` varchar(64) NOT NULL,
	`resourceFingerprint` varchar(128) NOT NULL,
	`replyCursor` json NOT NULL,
	`enrollmentKey` varchar(128) NOT NULL,
	`objective` varchar(500) NOT NULL,
	`status` varchar(48) NOT NULL DEFAULT 'scheduled',
	`revision` int NOT NULL DEFAULT 1,
	`stepIndex` int NOT NULL DEFAULT 0,
	`steps` json NOT NULL,
	`timezone` varchar(64) NOT NULL,
	`businessDaysOnly` boolean NOT NULL DEFAULT false,
	`responseWindowMinutes` int NOT NULL DEFAULT 1440,
	`executionMode` varchar(16) NOT NULL DEFAULT 'review',
	`nextActionAt` timestamp(3),
	`deadlineAt` timestamp(3) NOT NULL,
	`reason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `followUpPlans_id` PRIMARY KEY(`id`),
	CONSTRAINT `followup_enrollment_unique` UNIQUE(`ownerId`,`enrollmentKey`)
);
--> statement-breakpoint
CREATE TABLE `workflowEvents` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`eventKey` varchar(128) NOT NULL,
	`eventType` varchar(96) NOT NULL,
	`aggregateId` varchar(64) NOT NULL,
	`revision` int NOT NULL,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workflowEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `workflow_event_key_unique` UNIQUE(`ownerId`,`eventKey`)
);
--> statement-breakpoint
ALTER TABLE `automationGrants` ADD CONSTRAINT `automationGrants_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `automationGrants` ADD CONSTRAINT `automationGrants_planId_followUpPlans_id_fk` FOREIGN KEY (`planId`) REFERENCES `followUpPlans`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `automationGrants` ADD CONSTRAINT `automationGrants_createdById_users_id_fk` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `emailDispatches` ADD CONSTRAINT `emailDispatches_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `emailDispatches` ADD CONSTRAINT `emailDispatches_messageId_messages_id_fk` FOREIGN KEY (`messageId`) REFERENCES `messages`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `emailDispatches` ADD CONSTRAINT `emailDispatches_approvalId_approvals_id_fk` FOREIGN KEY (`approvalId`) REFERENCES `approvals`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `emailDispatches` ADD CONSTRAINT `emailDispatches_planId_followUpPlans_id_fk` FOREIGN KEY (`planId`) REFERENCES `followUpPlans`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `emailDispatches` ADD CONSTRAINT `emailDispatches_grantId_automationGrants_id_fk` FOREIGN KEY (`grantId`) REFERENCES `automationGrants`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `followUpPlans` ADD CONSTRAINT `followUpPlans_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `followUpPlans` ADD CONSTRAINT `followUpPlans_conversationId_conversations_id_fk` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `followUpPlans` ADD CONSTRAINT `followUpPlans_candidateId_candidates_id_fk` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `followUpPlans` ADD CONSTRAINT `followUpPlans_senderIdentityId_emailIdentities_id_fk` FOREIGN KEY (`senderIdentityId`) REFERENCES `emailIdentities`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workflowEvents` ADD CONSTRAINT `workflowEvents_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `grant_plan_scope_idx` ON `automationGrants` (`ownerId`,`planId`,`active`);
--> statement-breakpoint
CREATE INDEX `dispatch_owner_recipient_time_idx` ON `emailDispatches` (`ownerId`,`recipientHash`,`claimedAt`);
--> statement-breakpoint
CREATE INDEX `followup_owner_status_idx` ON `followUpPlans` (`ownerId`,`status`);
--> statement-breakpoint
CREATE INDEX `followup_candidate_idx` ON `followUpPlans` (`ownerId`,`candidateId`);
--> statement-breakpoint
CREATE INDEX `followup_conversation_idx` ON `followUpPlans` (`ownerId`,`conversationId`);
--> statement-breakpoint
CREATE INDEX `workflow_event_aggregate_idx` ON `workflowEvents` (`ownerId`,`aggregateId`);
