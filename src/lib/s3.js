import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { config } from "../config.js";
import { contentTypeOf } from "./media.js";

// Credentials are resolved by the default AWS provider chain:
// env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) for local/dev,
// or the EC2 instance IAM role in production.
export const s3 = new S3Client({ region: config.s3.region });

export function buildKey(...parts) {
    return [config.s3.prefix, ...parts]
        .filter(Boolean)
        .join("/")
        .replace(/\/+/g, "/");
}

export async function uploadBuffer(key, body, filename) {
    await s3.send(
        new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: key,
            Body: body,
            ContentType: contentTypeOf(filename || key),
        })
    );

    return key;
}

export async function presign(key) {
    if (!key) {
        return null;
    }

    return getSignedUrl(
        s3,
        new GetObjectCommand({
            Bucket: config.s3.bucket,
            Key: key,
        }),
        { expiresIn: config.s3.urlTtl }
    );
}

export async function deleteKeys(keys) {
    if (!keys.length) {
        return;
    }

    // S3 deletes a maximum of 1000 objects per request.
    for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);

        await s3.send(
            new DeleteObjectsCommand({
                Bucket: config.s3.bucket,
                Delete: {
                    Objects: chunk.map((Key) => ({ Key })),
                },
            })
        );
    }
}
