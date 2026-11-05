CREATE TABLE `clientDiscoveryRequests` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `ownerId` int NOT NULL, `conversationId` varchar(36) NOT NULL, `contactId` varchar(36) NOT NULL,
 `sourceFingerprint` varchar(64) NOT NULL, `requestKeyHash` varchar(64) NOT NULL, `requestHash` varchar(64) NOT NULL, `tokenHash` varchar(64) NOT NULL,
 `status` varchar(24) NOT NULL DEFAULT 'pending', `revision` int NOT NULL DEFAULT 1,
 `ownerWindows` json NOT NULL, `clientWindows` json, `timezone` varchar(64) NOT NULL, `clientTimezone` varchar(64), `responseHash` varchar(64),
 `durationMinutes` int NOT NULL, `bufferMinutes` int NOT NULL, `autoSelect` boolean NOT NULL DEFAULT false, `expiresAt` timestamp(3) NOT NULL,
 `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY `discovery_owner_request_unique` (`ownerId`,`requestKeyHash`), KEY `discovery_conversation_status_idx` (`ownerId`,`conversationId`,`status`),
 FOREIGN KEY (`ownerId`) REFERENCES `users` (`id`), FOREIGN KEY (`conversationId`) REFERENCES `conversations` (`id`), FOREIGN KEY (`contactId`) REFERENCES `contacts` (`id`)
);
--> statement-breakpoint
CREATE TABLE `clientDiscoveryMeetings` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `ownerId` int NOT NULL, `requestId` varchar(36) NOT NULL, `bookingHash` varchar(64) NOT NULL,
 `scheduledAt` timestamp(3) NOT NULL, `durationMinutes` int NOT NULL, `bufferMinutes` int NOT NULL, `timezone` varchar(64) NOT NULL,
 `status` varchar(24) NOT NULL DEFAULT 'tentative', `revision` int NOT NULL DEFAULT 1,
 `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY `discovery_request_meeting_unique` (`requestId`), KEY `discovery_meeting_owner_time_idx` (`ownerId`,`status`,`scheduledAt`),
 FOREIGN KEY (`ownerId`) REFERENCES `users` (`id`), FOREIGN KEY (`requestId`) REFERENCES `clientDiscoveryRequests` (`id`)
);
