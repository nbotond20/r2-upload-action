import type { R2Config } from "./types.js";
import * as core from "@actions/core";
import {
	S3Client,
	type PutObjectCommandInput,
	PutObjectCommand,
	type S3ServiceException,
} from "@aws-sdk/client-s3";
import * as fs from "node:fs";
import mime from "mime";
import md5 from "md5";
import path from "node:path";
import { createBatches } from "./createBatches.js";

const config: R2Config = {
	accountId: core.getInput("r2-account-id", { required: true }),
	accessKeyId: core.getInput("r2-access-key-id", { required: true }),
	secretAccessKey: core.getInput("r2-secret-access-key", { required: true }),
	bucket: core.getInput("r2-bucket", { required: true }),
	sourceDir: core.getInput("source-dir", { required: true }),
	destinationDir: core.getInput("destination-dir"),
	outputFileUrl: core.getInput("output-file-url") === "true",
	cacheControl: core.getInput("cache-control"),
	batchSize: Number.parseInt(core.getInput("batch-size") || "1"),
};

core.setSecret("r2-secret-access-key");
core.setSecret("r2-access-key-id");
core.setSecret("r2-account-id");

const S3 = new S3Client({
	region: "auto",
	endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
	},
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

const run = async (config: R2Config) => {
	const files: string[] = getFileList(config.sourceDir);
	const fileBatches = createBatches(files, config.batchSize);

	core.info(`Files count: ${files.length}`);
	core.info(`Batch size: ${config.batchSize}`);
	core.info(`Batch count: ${fileBatches.length}`);

	for (let i = 0; i < fileBatches.length; i++) {
		core.startGroup(`Batch ${i + 1} of ${fileBatches.length}`);
		const batch = fileBatches[i];

		const startTime = Date.now();
		const uploadPromises = batch.map(async (file) => {
			core.info(`R2 Uploading - ${file}`);

			const fileStream = fs.readFileSync(file);

			const fileName = file.replace(config.sourceDir, "");
			const fileKey = path.join(
				config.destinationDir !== "" ? config.destinationDir : config.sourceDir,
				fileName,
			);

			if (fileKey.includes(".gitkeep")) {
				return; // Skip the current iteration
			}

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

			const promise = S3.send(cmd)
				.then(() => {
					core.info(`✔️ R2 Uploaded - ${file}`);
				})
				.catch((err) => {
					const error = err as S3ServiceException;
					// biome-ignore lint/suspicious/noPrototypeBuiltins:
					if (error.hasOwnProperty("$metadata")) {
						if (error.$metadata.httpStatusCode === 412) {
							core.info(`✔️ R2 Not Modified - ${file}`);
							return;
						}

						core.error(`✖️ R2 failed - ${file}`);
						throw error;
					}

					throw error;
				});

			return promise;
		});

		await Promise.all(uploadPromises);
		core.endGroup();
		const endTime = Date.now();
		const elapsedTime = (endTime - startTime) / 1000;
		core.info(`↪️ done in ${elapsedTime} seconds`);
	}
};

run(config).catch((error) => {
	core.error("Error: ", error);
	core.setFailed(error.message);
	process.exit(1);
});
