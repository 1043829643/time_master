CREATE TABLE `restore_receipts` (
	`owner` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`commit_token` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `chat_receipts_history` ON `chat_receipts` (`owner`,`created_at`,`request_id`);