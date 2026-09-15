CREATE TABLE `aiModelRoutes` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`taskType` varchar(96) NOT NULL,
	`primaryModel` varchar(200) NOT NULL,
	`fallbackModels` json,
	`schemaVersion` varchar(64) NOT NULL DEFAULT 'v1',
	`maxInputChars` int NOT NULL DEFAULT 12000,
	`maxOutputTokens` int NOT NULL DEFAULT 1200,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aiModelRoutes_id` PRIMARY KEY(`id`),
	CONSTRAINT `ai_route_owner_task_unique` UNIQUE(`ownerId`,`taskType`)
);
--> statement-breakpoint
CREATE TABLE `aiUsage` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`routeId` varchar(36),
	`queueJobId` varchar(36),
	`taskType` varchar(96) NOT NULL,
	`requestedModel` varchar(200),
	`selectedModel` varchar(200),
	`status` varchar(48) NOT NULL,
	`latencyMs` int,
	`errorCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aiUsage_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`requestedBy` varchar(96) NOT NULL DEFAULT 'ai',
	`actionType` varchar(96) NOT NULL,
	`resourceType` varchar(96) NOT NULL,
	`resourceId` varchar(64) NOT NULL,
	`status` enum('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
	`reason` text,
	`payload` json,
	`decidedById` int,
	`decidedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `approvals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auditEvents` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`actorType` enum('user','ai','system','cron','provider') NOT NULL,
	`actorId` varchar(96),
	`action` varchar(120) NOT NULL,
	`resourceType` varchar(96) NOT NULL,
	`resourceId` varchar(64) NOT NULL,
	`previousState` varchar(64),
	`nextState` varchar(64),
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `auditEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `automationQueue` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`jobType` varchar(96) NOT NULL,
	`status` varchar(48) NOT NULL DEFAULT 'queued',
	`payload` json NOT NULL,
	`priority` int NOT NULL DEFAULT 100,
	`scheduledAt` timestamp NOT NULL DEFAULT (now()),
	`lockedAt` timestamp,
	`lockToken` varchar(96),
	`attempts` int NOT NULL DEFAULT 0,
	`maxAttempts` int NOT NULL DEFAULT 3,
	`idempotencyKey` varchar(160) NOT NULL,
	`lastError` text,
	`result` json,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `automationQueue_id` PRIMARY KEY(`id`),
	CONSTRAINT `queue_idempotency_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `candidateDocuments` (
	`id` varchar(36) NOT NULL,
	`candidateId` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`documentType` enum('cv','portfolio','offer','identity','other') NOT NULL DEFAULT 'cv',
	`storageKey` varchar(512) NOT NULL,
	`storageUrl` text NOT NULL,
	`originalName` varchar(255) NOT NULL,
	`mimeType` varchar(128) NOT NULL,
	`sizeBytes` int NOT NULL,
	`sha256` varchar(128),
	`scanState` varchar(48) NOT NULL DEFAULT 'pending',
	`parseState` varchar(48) NOT NULL DEFAULT 'not_requested',
	`parsedData` json,
	`provenance` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `candidateDocuments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `candidates` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`fullName` varchar(160) NOT NULL,
	`email` varchar(320),
	`emailHash` varchar(128),
	`phone` varchar(64),
	`phoneHash` varchar(128),
	`headline` varchar(255),
	`location` varchar(160),
	`workAuthorization` varchar(120),
	`availability` varchar(120),
	`compensationExpectation` int,
	`currency` varchar(8) NOT NULL DEFAULT 'INR',
	`profileState` varchar(48) NOT NULL DEFAULT 'imported',
	`sourceType` varchar(64) NOT NULL DEFAULT 'manual',
	`sourceUrl` text,
	`sourceCollectedAt` timestamp,
	`lastConfirmedAt` timestamp,
	`doNotContactAt` timestamp,
	`withdrawnAt` timestamp,
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `candidates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `companies` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`domain` varchar(255),
	`companyType` enum('prospect','client') NOT NULL DEFAULT 'prospect',
	`pipelineState` varchar(48) NOT NULL DEFAULT 'new',
	`sector` varchar(120),
	`sizeBand` varchar(64),
	`location` varchar(160),
	`sourceUrl` text,
	`sourceType` varchar(64) NOT NULL DEFAULT 'manual',
	`sourceCollectedAt` timestamp,
	`hiringSignal` text,
	`confidence` int NOT NULL DEFAULT 0,
	`verificationState` varchar(48) NOT NULL DEFAULT 'pending',
	`onboardingApprovedAt` timestamp,
	`onboardingApprovedById` int,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `companies_id` PRIMARY KEY(`id`),
	CONSTRAINT `company_owner_domain_unique` UNIQUE(`ownerId`,`domain`)
);
--> statement-breakpoint
CREATE TABLE `consents` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`candidateId` varchar(36) NOT NULL,
	`jobId` varchar(36),
	`companyId` varchar(36),
	`consentType` enum('platform_processing','recruitment_communication','client_sharing','interview_processing','recording','background_check','marketing') NOT NULL,
	`status` enum('granted','withdrawn','expired','denied') NOT NULL,
	`dataScope` json,
	`noticeVersion` varchar(64) NOT NULL,
	`method` varchar(64) NOT NULL DEFAULT 'portal',
	`grantedAt` timestamp,
	`withdrawnAt` timestamp,
	`expiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `consents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`companyId` varchar(36) NOT NULL,
	`name` varchar(160) NOT NULL,
	`title` varchar(160),
	`email` varchar(320),
	`phone` varchar(64),
	`contactPermission` varchar(48) NOT NULL DEFAULT 'unknown',
	`optedOutAt` timestamp,
	`sourceType` varchar(64) NOT NULL DEFAULT 'manual',
	`sourceUrl` text,
	`lastVerifiedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`companyId` varchar(36),
	`contactId` varchar(36),
	`candidateId` varchar(36),
	`jobId` varchar(36),
	`channel` enum('email','whatsapp','sms','portal','manual') NOT NULL DEFAULT 'email',
	`status` varchar(48) NOT NULL DEFAULT 'not_started',
	`classification` varchar(64),
	`lastMessageAt` timestamp,
	`nextActionAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `feeProposals` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`companyId` varchar(36) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`state` varchar(48) NOT NULL DEFAULT 'draft',
	`feeType` enum('percentage','fixed') NOT NULL DEFAULT 'percentage',
	`feeValue` varchar(32) NOT NULL,
	`currency` varchar(8) NOT NULL DEFAULT 'INR',
	`guaranteeDays` int NOT NULL DEFAULT 90,
	`paymentTermsDays` int NOT NULL DEFAULT 30,
	`ownershipDays` int NOT NULL DEFAULT 180,
	`termsText` text,
	`termsHash` varchar(128),
	`sentAt` timestamp,
	`acceptedAt` timestamp,
	`acceptedBy` varchar(320),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `feeProposals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`interviewId` varchar(36) NOT NULL,
	`authorName` varchar(160) NOT NULL,
	`rawFeedback` text NOT NULL,
	`scorecard` json,
	`aiSummary` json,
	`finalDecision` varchar(64),
	`submittedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `feedback_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`incidentType` varchar(96) NOT NULL,
	`severity` enum('low','medium','high','critical') NOT NULL DEFAULT 'medium',
	`status` varchar(48) NOT NULL DEFAULT 'detected',
	`affectedResourceType` varchar(96),
	`affectedResourceId` varchar(64),
	`summary` text NOT NULL,
	`containmentNotes` text,
	`detectedAt` timestamp NOT NULL DEFAULT (now()),
	`resolvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `incidents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `interviews` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`companyId` varchar(36) NOT NULL,
	`candidateId` varchar(36) NOT NULL,
	`jobId` varchar(36) NOT NULL,
	`shortlistId` varchar(36),
	`status` varchar(48) NOT NULL DEFAULT 'proposed',
	`scheduledAt` timestamp,
	`durationMinutes` int NOT NULL DEFAULT 45,
	`timezone` varchar(64) NOT NULL DEFAULT 'Asia/Kolkata',
	`meetingUrl` text,
	`calendarProvider` varchar(64),
	`calendarEventId` varchar(255),
	`rescheduleCount` int NOT NULL DEFAULT 0,
	`reminderSentAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `interviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`companyId` varchar(36) NOT NULL,
	`placementId` varchar(36) NOT NULL,
	`invoiceNumber` varchar(64) NOT NULL,
	`status` varchar(48) NOT NULL DEFAULT 'draft',
	`currency` varchar(8) NOT NULL DEFAULT 'INR',
	`amount` int NOT NULL,
	`taxAmount` int NOT NULL DEFAULT 0,
	`dueAt` timestamp,
	`issuedAt` timestamp,
	`paidAt` timestamp,
	`disputeReason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoice_number_unique` UNIQUE(`invoiceNumber`),
	CONSTRAINT `invoice_placement_unique` UNIQUE(`placementId`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`companyId` varchar(36) NOT NULL,
	`feeProposalId` varchar(36),
	`title` varchar(200) NOT NULL,
	`department` varchar(120),
	`employmentType` varchar(64) NOT NULL DEFAULT 'full_time',
	`pipelineState` varchar(48) NOT NULL DEFAULT 'draft',
	`location` varchar(160),
	`workModel` varchar(48),
	`compensationMin` int,
	`compensationMax` int,
	`currency` varchar(8) NOT NULL DEFAULT 'INR',
	`experienceMinYears` int,
	`experienceMaxYears` int,
	`mustHaveSkills` json,
	`niceToHaveSkills` json,
	`scorecard` json,
	`intake` json,
	`requirementQuality` int NOT NULL DEFAULT 0,
	`clientConfirmedAt` timestamp,
	`clientConfirmedBy` varchar(320),
	`targetJoiningAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`candidateId` varchar(36) NOT NULL,
	`jobId` varchar(36) NOT NULL,
	`status` varchar(48) NOT NULL DEFAULT 'candidate_found',
	`ruleScore` int NOT NULL DEFAULT 0,
	`semanticScore` int NOT NULL DEFAULT 0,
	`confidence` int NOT NULL DEFAULT 0,
	`evidence` json,
	`missingEvidence` json,
	`lowConfidence` boolean NOT NULL DEFAULT false,
	`modelRoute` varchar(120),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `matches_id` PRIMARY KEY(`id`),
	CONSTRAINT `match_candidate_job_unique` UNIQUE(`candidateId`,`jobId`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` varchar(36) NOT NULL,
	`conversationId` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`direction` enum('inbound','outbound') NOT NULL,
	`status` varchar(48) NOT NULL DEFAULT 'draft',
	`body` text NOT NULL,
	`subject` varchar(255),
	`providerMessageId` varchar(255),
	`idempotencyKey` varchar(160) NOT NULL,
	`aiGenerated` boolean NOT NULL DEFAULT false,
	`sentAt` timestamp,
	`deliveredAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `message_idempotency_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`invoiceId` varchar(36) NOT NULL,
	`provider` varchar(64),
	`providerEventId` varchar(255),
	`amount` int NOT NULL,
	`currency` varchar(8) NOT NULL DEFAULT 'INR',
	`status` varchar(48) NOT NULL DEFAULT 'pending',
	`paidAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_provider_event_unique` UNIQUE(`provider`,`providerEventId`)
);
--> statement-breakpoint
CREATE TABLE `placements` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`companyId` varchar(36) NOT NULL,
	`candidateId` varchar(36) NOT NULL,
	`jobId` varchar(36) NOT NULL,
	`status` varchar(48) NOT NULL DEFAULT 'offer_pending',
	`annualCompensation` int,
	`currency` varchar(8) NOT NULL DEFAULT 'INR',
	`offerIssuedAt` timestamp,
	`offerAcceptedAt` timestamp,
	`joiningConfirmedAt` timestamp,
	`joiningEvidence` json,
	`guaranteeStartAt` timestamp,
	`guaranteeEndAt` timestamp,
	`replacementRequestedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `placements_id` PRIMARY KEY(`id`),
	CONSTRAINT `placement_candidate_job_unique` UNIQUE(`candidateId`,`jobId`)
);
--> statement-breakpoint
CREATE TABLE `policyVersions` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`version` int NOT NULL,
	`status` enum('draft','active','archived') NOT NULL DEFAULT 'draft',
	`name` varchar(160) NOT NULL,
	`content` json NOT NULL,
	`createdById` int NOT NULL,
	`activatedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `policyVersions_id` PRIMARY KEY(`id`),
	CONSTRAINT `policy_owner_version_unique` UNIQUE(`ownerId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `rightsRequests` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`candidateId` varchar(36) NOT NULL,
	`requestType` enum('access','correction','withdrawal','deletion','complaint') NOT NULL,
	`status` varchar(48) NOT NULL DEFAULT 'received',
	`details` text,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`resolvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rightsRequests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `screenings` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`candidateId` varchar(36) NOT NULL,
	`jobId` varchar(36) NOT NULL,
	`status` varchar(48) NOT NULL DEFAULT 'not_started',
	`answers` json,
	`evidence` json,
	`aiSummary` json,
	`confidence` int NOT NULL DEFAULT 0,
	`recommendation` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `screenings_id` PRIMARY KEY(`id`),
	CONSTRAINT `screening_candidate_job_unique` UNIQUE(`candidateId`,`jobId`)
);
--> statement-breakpoint
CREATE TABLE `shortlists` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`companyId` varchar(36) NOT NULL,
	`jobId` varchar(36) NOT NULL,
	`candidateId` varchar(36) NOT NULL,
	`matchId` varchar(36),
	`status` varchar(48) NOT NULL DEFAULT 'prepared',
	`consentId` varchar(36),
	`shareExpiresAt` timestamp,
	`sharedAt` timestamp,
	`viewedAt` timestamp,
	`clientFeedback` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shortlists_id` PRIMARY KEY(`id`),
	CONSTRAINT `shortlist_candidate_job_unique` UNIQUE(`candidateId`,`jobId`)
);
--> statement-breakpoint
CREATE TABLE `suppressionList` (
	`id` varchar(36) NOT NULL,
	`ownerId` int NOT NULL,
	`channel` varchar(32) NOT NULL,
	`valueHash` varchar(128) NOT NULL,
	`reason` varchar(160) NOT NULL,
	`source` varchar(96) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `suppressionList_id` PRIMARY KEY(`id`),
	CONSTRAINT `suppression_owner_channel_value_unique` UNIQUE(`ownerId`,`channel`,`valueHash`)
);
--> statement-breakpoint
CREATE TABLE `workspaceSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerId` int NOT NULL,
	`businessName` varchar(160) NOT NULL DEFAULT 'FreelanceHR',
	`businessTimezone` varchar(64) NOT NULL DEFAULT 'Asia/Kolkata',
	`automationMode` enum('safe','controlled','autopilot') NOT NULL DEFAULT 'safe',
	`emergencyStop` boolean NOT NULL DEFAULT false,
	`dailyOutboundLimit` int NOT NULL DEFAULT 20,
	`quietHoursStart` varchar(5) NOT NULL DEFAULT '20:00',
	`quietHoursEnd` varchar(5) NOT NULL DEFAULT '08:00',
	`policyConfig` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_owner_unique` UNIQUE(`ownerId`)
);
--> statement-breakpoint
ALTER TABLE `aiModelRoutes` ADD CONSTRAINT `aiModelRoutes_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `aiUsage` ADD CONSTRAINT `aiUsage_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `aiUsage` ADD CONSTRAINT `aiUsage_routeId_aiModelRoutes_id_fk` FOREIGN KEY (`routeId`) REFERENCES `aiModelRoutes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `aiUsage` ADD CONSTRAINT `aiUsage_queueJobId_automationQueue_id_fk` FOREIGN KEY (`queueJobId`) REFERENCES `automationQueue`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_decidedById_users_id_fk` FOREIGN KEY (`decidedById`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditEvents` ADD CONSTRAINT `auditEvents_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `automationQueue` ADD CONSTRAINT `automationQueue_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `candidateDocuments` ADD CONSTRAINT `candidateDocuments_candidateId_candidates_id_fk` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `candidateDocuments` ADD CONSTRAINT `candidateDocuments_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `candidates` ADD CONSTRAINT `candidates_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `companies` ADD CONSTRAINT `companies_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `companies` ADD CONSTRAINT `companies_onboardingApprovedById_users_id_fk` FOREIGN KEY (`onboardingApprovedById`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `consents` ADD CONSTRAINT `consents_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `consents` ADD CONSTRAINT `consents_candidateId_candidates_id_fk` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `consents` ADD CONSTRAINT `consents_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `consents` ADD CONSTRAINT `consents_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_contactId_contacts_id_fk` FOREIGN KEY (`contactId`) REFERENCES `contacts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_candidateId_candidates_id_fk` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `feeProposals` ADD CONSTRAINT `feeProposals_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `feeProposals` ADD CONSTRAINT `feeProposals_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `feedback` ADD CONSTRAINT `feedback_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `feedback` ADD CONSTRAINT `feedback_interviewId_interviews_id_fk` FOREIGN KEY (`interviewId`) REFERENCES `interviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `incidents` ADD CONSTRAINT `incidents_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interviews` ADD CONSTRAINT `interviews_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interviews` ADD CONSTRAINT `interviews_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interviews` ADD CONSTRAINT `interviews_candidateId_candidates_id_fk` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interviews` ADD CONSTRAINT `interviews_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interviews` ADD CONSTRAINT `interviews_shortlistId_shortlists_id_fk` FOREIGN KEY (`shortlistId`) REFERENCES `shortlists`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_placementId_placements_id_fk` FOREIGN KEY (`placementId`) REFERENCES `placements`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_feeProposalId_feeProposals_id_fk` FOREIGN KEY (`feeProposalId`) REFERENCES `feeProposals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `matches` ADD CONSTRAINT `matches_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `matches` ADD CONSTRAINT `matches_candidateId_candidates_id_fk` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `matches` ADD CONSTRAINT `matches_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_conversationId_conversations_id_fk` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `placements` ADD CONSTRAINT `placements_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `placements` ADD CONSTRAINT `placements_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `placements` ADD CONSTRAINT `placements_candidateId_candidates_id_fk` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `placements` ADD CONSTRAINT `placements_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policyVersions` ADD CONSTRAINT `policyVersions_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policyVersions` ADD CONSTRAINT `policyVersions_createdById_users_id_fk` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rightsRequests` ADD CONSTRAINT `rightsRequests_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rightsRequests` ADD CONSTRAINT `rightsRequests_candidateId_candidates_id_fk` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `screenings` ADD CONSTRAINT `screenings_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `screenings` ADD CONSTRAINT `screenings_candidateId_candidates_id_fk` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `screenings` ADD CONSTRAINT `screenings_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shortlists` ADD CONSTRAINT `shortlists_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shortlists` ADD CONSTRAINT `shortlists_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shortlists` ADD CONSTRAINT `shortlists_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shortlists` ADD CONSTRAINT `shortlists_candidateId_candidates_id_fk` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shortlists` ADD CONSTRAINT `shortlists_matchId_matches_id_fk` FOREIGN KEY (`matchId`) REFERENCES `matches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shortlists` ADD CONSTRAINT `shortlists_consentId_consents_id_fk` FOREIGN KEY (`consentId`) REFERENCES `consents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `suppressionList` ADD CONSTRAINT `suppressionList_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceSettings` ADD CONSTRAINT `workspaceSettings_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ai_usage_owner_created_idx` ON `aiUsage` (`ownerId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `approval_owner_status_idx` ON `approvals` (`ownerId`,`status`);--> statement-breakpoint
CREATE INDEX `approval_resource_idx` ON `approvals` (`resourceType`,`resourceId`);--> statement-breakpoint
CREATE INDEX `audit_owner_created_idx` ON `auditEvents` (`ownerId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_resource_idx` ON `auditEvents` (`resourceType`,`resourceId`);--> statement-breakpoint
CREATE INDEX `queue_ready_idx` ON `automationQueue` (`ownerId`,`status`,`scheduledAt`);--> statement-breakpoint
CREATE INDEX `candidate_doc_candidate_idx` ON `candidateDocuments` (`candidateId`);--> statement-breakpoint
CREATE INDEX `candidate_doc_parse_idx` ON `candidateDocuments` (`parseState`);--> statement-breakpoint
CREATE INDEX `candidate_owner_state_idx` ON `candidates` (`ownerId`,`profileState`);--> statement-breakpoint
CREATE INDEX `candidate_owner_email_hash_idx` ON `candidates` (`ownerId`,`emailHash`);--> statement-breakpoint
CREATE INDEX `company_owner_state_idx` ON `companies` (`ownerId`,`pipelineState`);--> statement-breakpoint
CREATE INDEX `consent_candidate_type_idx` ON `consents` (`candidateId`,`consentType`,`status`);--> statement-breakpoint
CREATE INDEX `consent_share_idx` ON `consents` (`candidateId`,`jobId`,`companyId`);--> statement-breakpoint
CREATE INDEX `contact_company_idx` ON `contacts` (`companyId`);--> statement-breakpoint
CREATE INDEX `contact_owner_permission_idx` ON `contacts` (`ownerId`,`contactPermission`);--> statement-breakpoint
CREATE INDEX `conversation_owner_status_idx` ON `conversations` (`ownerId`,`status`);--> statement-breakpoint
CREATE INDEX `conversation_candidate_idx` ON `conversations` (`candidateId`);--> statement-breakpoint
CREATE INDEX `proposal_company_state_idx` ON `feeProposals` (`companyId`,`state`);--> statement-breakpoint
CREATE INDEX `feedback_interview_idx` ON `feedback` (`interviewId`);--> statement-breakpoint
CREATE INDEX `incident_owner_status_idx` ON `incidents` (`ownerId`,`status`);--> statement-breakpoint
CREATE INDEX `interview_owner_status_idx` ON `interviews` (`ownerId`,`status`);--> statement-breakpoint
CREATE INDEX `interview_scheduled_idx` ON `interviews` (`scheduledAt`);--> statement-breakpoint
CREATE INDEX `invoice_owner_status_idx` ON `invoices` (`ownerId`,`status`);--> statement-breakpoint
CREATE INDEX `job_owner_state_idx` ON `jobs` (`ownerId`,`pipelineState`);--> statement-breakpoint
CREATE INDEX `job_company_idx` ON `jobs` (`companyId`);--> statement-breakpoint
CREATE INDEX `match_job_status_idx` ON `matches` (`jobId`,`status`);--> statement-breakpoint
CREATE INDEX `message_conversation_idx` ON `messages` (`conversationId`);--> statement-breakpoint
CREATE INDEX `payment_invoice_idx` ON `payments` (`invoiceId`);--> statement-breakpoint
CREATE INDEX `placement_owner_status_idx` ON `placements` (`ownerId`,`status`);--> statement-breakpoint
CREATE INDEX `policy_status_idx` ON `policyVersions` (`ownerId`,`status`);--> statement-breakpoint
CREATE INDEX `rights_owner_status_idx` ON `rightsRequests` (`ownerId`,`status`);--> statement-breakpoint
CREATE INDEX `screening_job_status_idx` ON `screenings` (`jobId`,`status`);--> statement-breakpoint
CREATE INDEX `shortlist_job_status_idx` ON `shortlists` (`jobId`,`status`);
