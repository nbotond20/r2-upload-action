import type { R2Config, FileMap } from "./types.js";
import { getInput, setOutput, setFailed, getBooleanInput } from "@actions/core";
import {
	type S3Client,
	type PutObjectCommandInput,
	PutObjectCommand,
	type PutObjectCommandOutput,
	type S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from "fs";
import mime from "mime";
import md5 from "md5";
import path from "path";
import { createS3Clients } from "./createS3Clients.js";
import { createBatches } from "./createBatches.js";
const config: R2Config = {
	accountId: getInput("r2-account-id", { required: true }),
	accessKeyId: getInput("r2-access-key-id", { required: true }),
	secretAccessKey: getInput("r2-secret-access-key", { required: true }),
	bucket: getInput("r2-bucket", { required: true }),
	sourceDir: getInput("source-dir", { required: true }),
	destinationDir: getInput("destination-dir"),
	outputFileUrl: getInput("output-file-url") === "true",
	cacheControl: getInput("cache-control"),
};

export const NUMBER_OF_S3_CLIENTS = 5;

const s3Clients = createS3Clients(NUMBER_OF_S3_CLIENTS, {
	accessKeyId: config.accessKeyId,
	secretAccessKey: config.secretAccessKey,
	accountId: config.accountId,
});

const getFileList = (dir: string) => {
	let files: string[] = [];
	const items = fs.readdirSync(dir, {
		withFileTypes: true,
	});

	for (const item of items) {
		const isDir = item.isDirectory();
		const absolutePath = `${dir}/${item.name}`;
		if (isDir) {
			files = [...files, ...getFileList(absolutePath)];
		} else {
			files.push(absolutePath);
		}
	}

	return files;
};

const uploadFiles = async (client: S3Client, files: string[]) => {
	for (const file of files) {
		console.log(file);
		const fileStream = fs.readFileSync(file);
		console.log(config.sourceDir);
		console.log(config.destinationDir);
		const fileName = file.replace(config.sourceDir, "");
		const fileKey = path.join(
			config.destinationDir !== "" ? config.destinationDir : config.sourceDir,
			fileName,
		);

		if (fileKey.includes(".gitkeep")) {
			return; // Skip the current iteration
		}

		console.log(fileKey);

		const mimeType = mime.getType(file);

		const uploadParams: PutObjectCommandInput = {
			Bucket: config.bucket,
			Key: fileKey,
			Body: fileStream,
			ContentLength: fs.statSync(file).size,
			ContentType: mimeType ?? "application/octet-stream",
			...(config.cacheControl ? { CacheControl: config.cacheControl } : {}),
		};

		const cmd = new PutObjectCommand(uploadParams);

		const digest = md5(fileStream);

		cmd.middlewareStack.add(
			// biome-ignore lint/suspicious/noExplicitAny: we need the any here
			(next: any) => async (args: any) => {
				args.request.headers["if-none-match"] = `"${digest}"`;
				return await next(args);
			},
			{
				step: "build",
				name: "addETag",
			},
		);

		try {
			await client.send(cmd);
			console.log(`R2 Success - ${file}`);

			await getSignedUrl(client, cmd);
		} catch (err: unknown) {
			const error = err as S3ServiceException;
			// biome-ignore lint/suspicious/noPrototypeBuiltins: we need to check if the property exists
			if (error.hasOwnProperty("$metadata")) {
				if (error.$metadata.httpStatusCode !== 412)
					// If-None-Match
					throw error;
			}
		}
	}
};

const run = async (config: R2Config) => {
	const map = new Map<string, PutObjectCommandOutput>();
	const urls: FileMap = {};

	const files: string[] = getFileList(config.sourceDir);
	const fileBatches = createBatches(files, s3Clients.length);

	for (let i = 0; i < s3Clients.length; i++) {
		const client = s3Clients[i];
		const batch = fileBatches[i];

		await uploadFiles(client, batch);
	}

	if (config.outputFileUrl) setOutput("file-urls", urls);
	return map;
};

run(config)
	.then((result) => setOutput("result", "success"))
	.catch((err) => {
		// biome-ignore lint/suspicious/noPrototypeBuiltins: we need to check if the property exists
		if (err.hasOwnProperty("$metadata")) {
			console.error(`R2 Error - ${err.message}`);
		} else {
			console.error("Error", err);
		}

		setOutput("result", "failure");
		setFailed(err.message);
	});
