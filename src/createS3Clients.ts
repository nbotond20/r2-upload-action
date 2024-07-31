import {
    S3Client,
    PutObjectCommandInput,
    PutObjectCommand,
    PutObjectCommandOutput,
    S3ServiceException,
} from "@aws-sdk/client-s3";

interface Config {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
}

export const createS3Clients = (
    numOfClients: number,
    config: Config
): S3Client[] => {
    return Array.from({ length: numOfClients }).map(() => {
        return new S3Client({
            region: "auto",
            endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
            },
        });
    });
};
