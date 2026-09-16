CREATE TABLE `conversation_memories` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE TABLE `proposal_targets` (
	`owner` text NOT NULL,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`id` text NOT NULL,
	PRIMARY KEY(`owner`, `request_id`, `kind`, `id`)
);
--> statement-breakpoint
CREATE INDEX `proposal_targets_record` ON `proposal_targets` (`owner`,`kind`,`id`);--> statement-breakpoint
ALTER TABLE `chat_receipts` ADD `protocol_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_receipts` ADD `state_reason` text;--> statement-breakpoint
ALTER TABLE `chat_receipts` ADD `superseded_by` text;--> statement-breakpoint
ALTER TABLE `chat_receipts` ADD `turn_context` text;