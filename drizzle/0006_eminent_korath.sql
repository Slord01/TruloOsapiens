CREATE TABLE `osapiens_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`deliveryNoteId` int NOT NULL,
	`xentralNumber` varchar(128) NOT NULL,
	`customerName` varchar(512),
	`step` varchar(64) NOT NULL,
	`httpStatus` int,
	`success` boolean NOT NULL,
	`responseBody` text,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `osapiens_logs_id` PRIMARY KEY(`id`)
);
