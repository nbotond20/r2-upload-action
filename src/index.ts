import type { R2Config } from "./types.js";
import { getInput, setOutput, setFailed } from "@actions/core";
import {
	S3Client,
	type PutObjectCommandInput,
	PutObjectCommand,
	type S3ServiceException,
} from "@aws-sdk/client-s3";
import * as fs from "fs";
import mime from "mime";
import md5 from "md5";
import path from "path";
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
	batchSize: Number.parseInt(getInput("batch-size") || "1"),
};

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

	console.log("Files count: ", files.length);
	console.log("Batch size: ", config.batchSize);
	console.log("Batch count: ", fileBatches.length);

	for (let i = 0; i < fileBatches.length; i++) {
		console.log(`\nBatch ${i + 1} of ${fileBatches.length}`);
		const batch = fileBatches[i];
		console.time(`✅ Batch ${i + 1}`);
		const uploadPromises = batch.map(async (file) => {
			console.log(`R2 Uploading - ${file}`);

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
					console.log(`✔️ R2 Uploaded - ${file}`);
				})
				.catch((err) => {
					const error = err as S3ServiceException;
					// biome-ignore lint/suspicious/noPrototypeBuiltins:
					if (error.hasOwnProperty("$metadata")) {
						console.log(`✖️ R2 failed - ${file}`);
						if (error.$metadata.httpStatusCode !== 412)
							// If-None-Match
							throw error;
					}
				});

			return promise;
		});

		await Promise.allSettled(uploadPromises);

		console.timeEnd(`✅ Batch ${i + 1}`);
	}
};

run(config)
	.then(() => setOutput("result", "success"))
	.catch((err) => {
		// biome-ignore lint/suspicious/noPrototypeBuiltins:
		if (err.hasOwnProperty("$metadata")) {
			console.error(`R2 Error - ${err.message}`);
		} else {
			console.error("Error", err);
		}

		setOutput("result", "failure");
		setFailed(err.message);
	});
