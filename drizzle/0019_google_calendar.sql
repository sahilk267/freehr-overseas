CREATE TABLE `googleCalendarConnections` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `ownerId` int NOT NULL, `status` varchar(48) NOT NULL DEFAULT 'disconnected', `revision` int NOT NULL DEFAULT 1,
 `calendarId` varchar(320) NOT NULL DEFAULT 'primary', `accountHash` varchar(64), `accountEmail` varchar(320), `tokensCipher` text, `scopes` json,
 `leaseToken` varchar(36), `leaseUntil` timestamp(3) NULL, `lastErrorCode` varchar(64), `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY `google_calendar_owner_unique` (`ownerId`), FOREIGN KEY (`ownerId`) REFERENCES `users` (`id`)
);
--> statement-breakpoint
CREATE TABLE `googleCalendarOAuthStates` (
 `id` varchar(64) NOT NULL PRIMARY KEY, `ownerId` int NOT NULL, `connectionId` varchar(36) NOT NULL, `revision` int NOT NULL,
 `sessionHash` varchar(64) NOT NULL, `verifierCipher` text, `expiresAt` timestamp(3) NOT NULL, `consumedAt` timestamp(3) NULL, `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY `google_calendar_state_owner_idx` (`ownerId`), FOREIGN KEY (`ownerId`) REFERENCES `users` (`id`), FOREIGN KEY (`connectionId`) REFERENCES `googleCalendarConnections` (`id`)
);
--> statement-breakpoint
CREATE TABLE `googleCalendarEventBindings` (
 `id` varchar(64) NOT NULL PRIMARY KEY, `ownerId` int NOT NULL, `connectionId` varchar(36) NOT NULL, `interviewId` varchar(36) NOT NULL,
 `eventId` varchar(128) NOT NULL, `syncedFingerprint` varchar(64), `providerEtag` varchar(512), `lastSyncedAt` timestamp(3) NULL, `lastErrorCode` varchar(64),
 `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 KEY `google_calendar_binding_owner_idx` (`ownerId`), FOREIGN KEY (`ownerId`) REFERENCES `users` (`id`), FOREIGN KEY (`connectionId`) REFERENCES `googleCalendarConnections` (`id`), FOREIGN KEY (`interviewId`) REFERENCES `interviews` (`id`)
);
