-- Preserve active legacy suppressions before normalizing surviving phone hashes.
-- This updates identity indexes, never merges people or grants contact permission.
INSERT INTO `suppressionList` (`id`,`ownerId`,`channel`,`valueHash`,`reason`,`source`,`active`)
SELECT CONCAT('sup_',REPLACE(UUID(),'-','')), c.`ownerId`, 'phone',
  SHA2(REGEXP_REPLACE(c.`phone`,'[[:space:]().-]',''),256),
  s.`reason`, 'canonical_phone_alias', true
FROM `candidates` c JOIN `suppressionList` s
  ON s.`ownerId`=c.`ownerId` AND s.`channel`='phone' AND s.`valueHash`=c.`phoneHash` AND s.`active`=true
WHERE REGEXP_REPLACE(c.`phone`,'[[:space:]().-]','') REGEXP '^[+][1-9][0-9]{7,14}$'
  AND c.`phoneHash` <> SHA2(REGEXP_REPLACE(c.`phone`,'[[:space:]().-]',''),256)
ON DUPLICATE KEY UPDATE `active`=true;
--> statement-breakpoint
UPDATE `candidates`
SET `phoneHash`=SHA2(REGEXP_REPLACE(`phone`,'[[:space:]().-]',''),256)
WHERE REGEXP_REPLACE(`phone`,'[[:space:]().-]','') REGEXP '^[+][1-9][0-9]{7,14}$';
--> statement-breakpoint
UPDATE `contacts` SET `phone`=REGEXP_REPLACE(`phone`,'[[:space:]().-]','')
WHERE REGEXP_REPLACE(`phone`,'[[:space:]().-]','') REGEXP '^[+][1-9][0-9]{7,14}$';
--> statement-breakpoint
UPDATE `contacts` SET `email`=LOWER(TRIM(`email`)) WHERE `email` IS NOT NULL;
--> statement-breakpoint
-- Canonicalize valid legacy company URLs too. Keep duplicate rows intact so
-- intake can hold collisions rather than creating another company or merging.
UPDATE `companies`
SET `domain`=TRIM(TRAILING '.' FROM REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(TRIM(`domain`)), '^[a-z][a-z0-9+.-]*://', ''), '[/#?].*$', ''), '^www[.]', ''))
WHERE TRIM(TRAILING '.' FROM REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(TRIM(`domain`)), '^[a-z][a-z0-9+.-]*://', ''), '[/#?].*$', ''), '^www[.]', '')) REGEXP '^[a-z0-9][a-z0-9.-]*[.][a-z]{2,63}$';
