ALTER TABLE `workspaceSettings`
  ADD COLUMN `backgroundEnabled` boolean NOT NULL DEFAULT false,
  ADD COLUMN `backgroundRevision` int NOT NULL DEFAULT 1,
  ADD COLUMN `backgroundLastHeartbeatAt` timestamp NULL,
  ADD COLUMN `backgroundLastResult` json,
  ADD COLUMN `backgroundLastError` varchar(500);
