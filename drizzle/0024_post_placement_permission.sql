-- Append one consent purpose; existing values and their order are preserved.
-- No pre-existing recruitment grant becomes a post-placement communication grant.
ALTER TABLE `consents` MODIFY COLUMN `consentType` enum('platform_processing','recruitment_communication','client_sharing','interview_processing','recording','background_check','marketing','post_placement_communication') NOT NULL;
