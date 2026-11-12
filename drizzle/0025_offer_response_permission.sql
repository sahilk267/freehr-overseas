-- Candidate email-confirmed offer-response processing is a distinct purpose.
-- Existing enum values keep their order; no prior grant is broadened.
ALTER TABLE `consents` MODIFY COLUMN `consentType` enum('platform_processing','recruitment_communication','client_sharing','interview_processing','recording','background_check','marketing','post_placement_communication','offer_response') NOT NULL;
