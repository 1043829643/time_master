CREATE TABLE `chat_receipts` (
	`owner` text NOT NULL,
	`request_id` text NOT NULL,
	`request_text` text NOT NULL,
	`reply` text NOT NULL,
	`proposal` text,
	`work_revision` integer NOT NULL,
	`commit_token` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner`, `request_id`)
);
