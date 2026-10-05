ALTER TABLE `messages` ADD `providerUid` int;
ALTER TABLE `messages` ADD `providerFolder` varchar(120);
ALTER TABLE `messages` ADD `messageId` varchar(255);
ALTER TABLE `messages` ADD `inReplyTo` varchar(255);
ALTER TABLE `messages` ADD `references` json;
CREATE INDEX `message_provider_uid_idx` ON `messages` (`providerUid`, `providerFolder`);
CREATE INDEX `message_rfc_message_id_idx` ON `messages` (`messageId`);
CREATE INDEX `message_provider_msg_id_idx` ON `messages` (`providerMessageId`);
