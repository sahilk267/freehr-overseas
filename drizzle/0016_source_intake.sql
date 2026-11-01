CREATE TABLE `intakeSources` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `ownerId` int NOT NULL,
  `name` varchar(160) NOT NULL,
  `kind` enum('candidate','prospect') NOT NULL,
  `enabled` boolean NOT NULL DEFAULT true,
  `tokenHash` varchar(64) NOT NULL,
  `revision` int NOT NULL DEFAULT 1,
  `requestKey` varchar(80) NOT NULL,
  `createdById` int NOT NULL,
  `lastReceivedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `intake_source_request_unique` (`ownerId`,`requestKey`),
  KEY `intake_source_owner_idx` (`ownerId`,`enabled`),
  FOREIGN KEY (`ownerId`) REFERENCES `users` (`id`),
  FOREIGN KEY (`createdById`) REFERENCES `users` (`id`)
);
--> statement-breakpoint
CREATE TABLE `intakeBatches` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `ownerId` int NOT NULL,
  `sourceId` varchar(36) NOT NULL,
  `batchKey` varchar(80) NOT NULL,
  `payloadHash` varchar(64) NOT NULL,
  `results` json NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `intake_batch_key_unique` (`ownerId`,`sourceId`,`batchKey`),
  KEY `intake_batch_source_time_idx` (`sourceId`,`createdAt`),
  FOREIGN KEY (`ownerId`) REFERENCES `users` (`id`),
  FOREIGN KEY (`sourceId`) REFERENCES `intakeSources` (`id`)
);
