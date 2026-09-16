CREATE TABLE `chat_parts` (
	`owner` text NOT NULL,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`owner`, `request_id`, `kind`, `position`)
);
--> statement-breakpoint
CREATE TABLE `operation_effects` (
	`owner` text NOT NULL,
	`operation_id` text NOT NULL,
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`payload` text,
	PRIMARY KEY(`owner`, `operation_id`, `kind`, `id`)
);
--> statement-breakpoint
CREATE TABLE `operation_receipts` (
	`owner` text NOT NULL,
	`operation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner`, `operation_id`)
);
--> statement-breakpoint
CREATE TABLE `workspace_records` (
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`payload` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`owner`, `kind`, `id`)
);
--> statement-breakpoint
ALTER TABLE `chat_receipts` ADD `sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_receipts` ADD `payload_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `chat_receipts_sync` ON `chat_receipts` (`owner`,`sequence`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `storage_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `commit_token` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER prevent_legacy_workspace_write
BEFORE UPDATE OF payload ON workspaces
WHEN NEW.storage_version = 1 AND json_type(NEW.payload, '$.projects') IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'workspace upgrade required');
END;
