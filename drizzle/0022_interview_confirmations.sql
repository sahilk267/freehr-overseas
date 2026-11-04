CREATE TABLE `interviewConfirmations` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `ownerId` int NOT NULL, `groupId` varchar(36) NOT NULL,
 `interviewId` varchar(36) NOT NULL, `candidateId` varchar(36) NOT NULL, `participant` varchar(20) NOT NULL,
 `requestHash` varchar(64) NOT NULL, `scheduleFingerprint` varchar(64) NOT NULL, `tokenHash` varchar(64) NOT NULL,
 `status` varchar(24) NOT NULL DEFAULT 'pending', `expiresAt` timestamp(3) NOT NULL, `respondedAt` timestamp(3),
 `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY `confirmation_group_role_unique` (`groupId`,`participant`), KEY `confirmation_owner_interview_idx` (`ownerId`,`interviewId`),
 FOREIGN KEY (`ownerId`) REFERENCES `users` (`id`), FOREIGN KEY (`interviewId`) REFERENCES `interviews` (`id`), FOREIGN KEY (`candidateId`) REFERENCES `candidates` (`id`)
);
