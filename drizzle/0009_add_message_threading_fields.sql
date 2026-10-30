ALTER TABLE `messages` ADD `providerUid` int;
--> statement-breakpoint
ALTER TABLE `messages` ADD `providerFolder` varchar(120);
--> statement-breakpoint
ALTER TABLE `messages` ADD `messageId` varchar(255);
--> statement-breakpoint
ALTER TABLE `messages` ADD `inReplyTo` varchar(255);
--> statement-breakpoint
ALTER TABLE `messages` ADD `references` json;
--> statement-breakpoint
CREATE INDEX `message_provider_uid_idx` ON `messages` (`providerUid`, `providerFolder`);
--> statement-breakpoint
CREATE INDEX `message_rfc_message_id_idx` ON `messages` (`messageId`);
--> statement-breakpoint
CREATE INDEX `message_provider_msg_id_idx` ON `messages` (`providerMessageId`);
