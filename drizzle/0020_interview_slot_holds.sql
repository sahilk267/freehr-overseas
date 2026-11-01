CREATE TABLE `interviewSlotHolds` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `ownerId` int NOT NULL, `candidateId` varchar(36) NOT NULL,
 `requestHash` varchar(64) NOT NULL, `scheduledAt` timestamp NOT NULL, `timezone` varchar(64) NOT NULL, `durationMinutes` int NOT NULL,
 `expiresAt` timestamp(3) NOT NULL, `status` varchar(32) NOT NULL DEFAULT 'active', `interviewId` varchar(36), `bookingHash` varchar(64),
 `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 KEY `interview_hold_candidate_idx` (`ownerId`,`candidateId`,`status`), KEY `interview_hold_expiry_idx` (`ownerId`,`expiresAt`),
 FOREIGN KEY (`ownerId`) REFERENCES `users` (`id`), FOREIGN KEY (`candidateId`) REFERENCES `candidates` (`id`), FOREIGN KEY (`interviewId`) REFERENCES `interviews` (`id`)
);
