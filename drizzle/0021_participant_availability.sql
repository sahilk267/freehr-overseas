CREATE TABLE `availabilityInvites` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `ownerId` int NOT NULL, `groupId` varchar(36) NOT NULL,
 `candidateId` varchar(36) NOT NULL, `jobId` varchar(36) NOT NULL, `participant` varchar(20) NOT NULL,
 `requestHash` varchar(64) NOT NULL, `tokenHash` varchar(64) NOT NULL, `revision` int NOT NULL DEFAULT 1,
 `status` varchar(24) NOT NULL DEFAULT 'pending', `expiresAt` timestamp(3) NOT NULL,
 `windows` json, `timezone` varchar(64), `submissionCount` int NOT NULL DEFAULT 0,
 `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY `availability_group_role_unique` (`groupId`,`participant`), KEY `availability_owner_idx` (`ownerId`,`createdAt`),
 FOREIGN KEY (`ownerId`) REFERENCES `users` (`id`), FOREIGN KEY (`candidateId`) REFERENCES `candidates` (`id`), FOREIGN KEY (`jobId`) REFERENCES `jobs` (`id`)
);
