#!/usr/bin/env node
/**
 * Install as scripts/migrate-to-s3.js (same imports as the original).
 * Run ONLY ONE migration process, with no concurrent gallery edits.
 *
 * LOCAL_IMAGE_ROOT=../images MIGRATE_CONCURRENCY=4 node scripts/migrate-to-s3.js
 * MIGRATE_BATCH_SIZE=50      Upload + commit this many files at a time (1..500).
 * MIGRATE_ATTEMPTS=4         Total attempts per transient failure (1..10).
 * MIGRATE_OWNER_EMAIL=...    Optional owner for NEW galleries only.
 * MIGRATE_REUPLOAD=1         Re-upload matching DB files, e.g. changed local content.
 *
 * No schema changes or new packages required. Does not delete rows or S3 objects.
 * Existing DB rows are trusted to refer to uploaded S3 objects. This is not an
 * integrity audit: enable MIGRATE_REUPLOAD to restore missing/changed objects.
 * Keys retain the original index-based format. Removed/reordered/renamed files
 * can produce unexpected old rows; stop and reconcile those explicitly.
 *
 * Uses uploadBuffer because the supplied S3 helper only exposes that interface.
 * Memory includes up to CONCURRENCY full files plus SDK overhead; for large
 * videos use concurrency=1 or extend the helper with streaming/multipart upload.
 * Configure network timeouts in your Supabase/S3 clients; this wrapper cannot
 * cancel a hung helper. SDK retries may compound these outer retries.
 * Ctrl+C/SIGTERM: finish in-flight files, commit successes, then stop.
 * A forced kill can require re-uploading the current uncommitted batch.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { config } from "../src/config.js";
import { supabase } from "../src/db/supabase.js";
import { buildKey, uploadBuffer } from "../src/lib/s3.js";
import {
    isMedia,
    mediaType,
    naturalCompare,
    slugify,
} from "../src/lib/media.js";

const ROOT = path.resolve(process.env.LOCAL_IMAGE_ROOT || "../images");

const OWNER_EMAIL = (process.env.MIGRATE_OWNER_EMAIL || "")
    .trim()
    .toLowerCase();

function integer(name, fallback, max) {
    const value = Number(process.env[name] ?? fallback);

    if (!Number.isInteger(value) || value < 1 || value > max) {
        throw new Error(
            `${name} must be an integer between 1 and ${max}`
        );
    }

    return value;
}

const CONCURRENCY = integer("MIGRATE_CONCURRENCY", 4, 32);
const BATCH_SIZE = integer("MIGRATE_BATCH_SIZE", 50, 500);
const ATTEMPTS = integer("MIGRATE_ATTEMPTS", 4, 10);
const REUPLOAD = process.env.MIGRATE_REUPLOAD === "1";

let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        stopping = true;
        process.exitCode = signal === "SIGINT" ? 130 : 143;

        console.warn(
            `\n${signal}: finishing in-flight uploads and saving progress...`
        );
    });
}

function transient(error) {
    const status = Number(
        error.status ??
        error.statusCode ??
        error.$metadata?.httpStatusCode
    );

    if ([408, 429, 500, 502, 503, 504].includes(status)) {
        return true;
    }

    const code = error.code || error.cause?.code || error.name;

    return (
        [
            "ECONNRESET",
            "ETIMEDOUT",
            "EAI_AGAIN",
            "ECONNREFUSED",
            "UND_ERR_CONNECT_TIMEOUT",
            "UND_ERR_SOCKET",
            "TimeoutError",
            "NetworkingError",
            "SlowDown",
            "RequestTimeout",
            "40001",
            "40P01",
            "53300",
            "57P01",
        ].includes(code) ||
        /fetch failed|network error/i.test(error.message || "")
    );
}

async function retry(label, operation) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= ATTEMPTS || !transient(error)) {
                throw error;
            }

            const ms = Math.round(
                Math.random() *
                Math.min(15_000, 500 * 2 ** (attempt - 1))
            );

            console.warn(
                `  ${label}: retry ${attempt}/${ATTEMPTS - 1} in ${ms}ms`
            );

            await delay(ms);
        }
    }
}

// Rebuild the query for each attempt; preserve HTTP status for classification.
async function query(factory) {
    const result = await factory();

    if (result.error) {
        const error = new Error(
            result.error.message || "Supabase request failed"
        );

        Object.assign(error, result.error, {
            status: result.status,
        });

        throw error;
    }

    return result;
}

const db = (label, factory) =>
    retry(label, () => query(factory));

async function listNames(dir, predicate) {
    return (await readdir(dir, { withFileTypes: true }))
        .filter(predicate)
        .map((entry) => entry.name)
        .sort(naturalCompare);
}

async function findGallery(name) {
    const { data } = await db("find gallery", () =>
        supabase
            .from("galleries")
            .select("id,name,slug,image_count,cover_key")
            .eq("name", name)
            .maybeSingle()
    );

    return data;
}

async function imageRows(galleryId) {
    const rows = [];

    // Continue until empty rather than assuming a short page means EOF.
    // The server may apply a smaller row limit than the requested page size.
    for (let offset = 0; ; ) {
        const { data } = await db("list images", () =>
            supabase
                .from("images")
                .select("id,s3_key,filename,media_type,position")
                .eq("gallery_id", galleryId)
                .order("id")
                .range(offset, offset + 199)
        );

        if (!data?.length) {
            return rows;
        }

        rows.push(...data);
        offset += data.length;
    }
}

async function ensureGallery(name, slug, ownerId) {
    // Re-read before retrying an insert: the previous request may have
    // committed while its response was lost.
    // Requires a single migration writer.
    return retry("create gallery", async () => {
        const existing = await findGallery(name);

        if (existing) {
            return existing;
        }

        const { data } = await query(() =>
            supabase
                .from("galleries")
                .insert({
                    name,
                    slug,
                    created_by: ownerId,
                    image_count: 0,
                    cover_key: null,
                })
                .select("id,name,slug,image_count,cover_key")
                .single()
        );

        return data;
    });
}

async function saveRows(galleryId, rows) {
    if (!rows.length) {
        return;
    }

    // No upsert conflict target is assumed. Reconcile uncertain insert
    // outcomes before retrying so a lost response does not duplicate
    // an accepted batch.
    let uncertain = false;

    await retry("insert images", async () => {
        let missing = rows;

        if (uncertain) {
            const existing = new Set(
                (await imageRows(galleryId)).map((row) => row.s3_key)
            );

            missing = rows.filter(
                (row) => !existing.has(row.s3_key)
            );
        }

        if (!missing.length) {
            return;
        }

        try {
            await query(() =>
                supabase.from("images").insert(
                    missing.map((row) => ({
                        ...row,
                        gallery_id: galleryId,
                    }))
                )
            );
        } catch (error) {
            uncertain = true;
            throw error;
        }
    });
}

async function uploadBatch(rows, dir, progress) {
    const uploaded = [];
    const errors = [];

    let cursor = 0;

    await Promise.all(
        Array.from(
            { length: Math.min(CONCURRENCY, rows.length) },
            async () => {
                while (
                    !stopping &&
                    errors.length === 0 &&
                    cursor < rows.length
                ) {
                    const row = rows[cursor++];

                    try {
                        // Async reads, with only one buffer per active worker.
                        const buffer = await readFile(
                            path.join(dir, row.filename)
                        );

                        await retry(
                            `upload ${row.filename}`,
                            () =>
                                uploadBuffer(
                                    row.s3_key,
                                    buffer,
                                    row.filename
                                )
                        );

                        uploaded.push(row);
                        progress();
                    } catch (error) {
                        errors.push(
                            new Error(
                                `${row.filename}: ${error.message}`,
                                { cause: error }
                            )
                        );
                    }
                }
            }
        )
    );

    // All workers settle before the caller saves successes or moves on.
    return { uploaded, errors };
}

async function migrateGallery(name, ownerId) {
    const dir = path.join(ROOT, name);

    const files = await listNames(
        dir,
        (entry) => entry.isFile() && isMedia(entry.name)
    );

    if (!files.length) {
        console.log(`- ${name}: no media`);
        return "skipped";
    }

    let gallery = await findGallery(name);

    const slug = gallery?.slug || slugify(name);

    if (!slug) {
        throw new Error(
            "Empty gallery slug; rename the local directory"
        );
    }

    const { data: collision } = await db("check slug", () =>
        supabase
            .from("galleries")
            .select("id,name")
            .eq("slug", slug)
            .maybeSingle()
    );

    if (collision && collision.id !== gallery?.id) {
        throw new Error(
            `Slug ${slug} already belongs to ${collision.name}; resolve before uploading`
        );
    }

    const expected = files.map((filename, position) => ({
        s3_key: buildKey(
            slug,
            `${String(position).padStart(4, "0")}-${filename}`
        ),
        filename,
        media_type: mediaType(filename),
        position,
    }));

    const expectedKeys = new Set(
        expected.map((row) => row.s3_key)
    );

    if (expectedKeys.size !== expected.length) {
        throw new Error("S3 key collision in local file list");
    }

    const existing = gallery
        ? await imageRows(gallery.id)
        : [];

    const byKey = new Map(
        existing.map((row) => [row.s3_key, row])
    );

    if (
        existing.length !== byKey.size ||
        existing.some((row) => !expectedKeys.has(row.s3_key))
    ) {
        throw new Error(
            "Duplicate or unexpected DB image keys; reconcile manually (nothing deleted)"
        );
    }

    // Catch mismatched metadata instead of accepting equal counts.
    for (const row of expected) {
        const old = byKey.get(row.s3_key);

        if (
            old &&
            (
                old.filename !== row.filename ||
                old.position !== row.position ||
                old.media_type !== row.media_type
            )
        ) {
            throw new Error(
                `DB metadata mismatch for ${row.filename}; reconcile manually`
            );
        }
    }

    if (stopping) {
        return "interrupted";
    }

    gallery ||= await ensureGallery(name, slug, ownerId);

    const pending = expected.filter(
        (row) => REUPLOAD || !byKey.has(row.s3_key)
    );

    let done = expected.length - pending.length;

    console.log(
        `- ${name}: ${done}/${expected.length} already recorded; ${pending.length} to upload`
    );

    for (
        let offset = 0;
        offset < pending.length && !stopping;
        offset += BATCH_SIZE
    ) {
        const batch = pending.slice(
            offset,
            offset + BATCH_SIZE
        );

        const { uploaded, errors } = await uploadBatch(
            batch,
            dir,
            () => {
                done++;

                if (process.stdout.isTTY) {
                    process.stdout.write(
                        `\r  ${name}: ${done}/${expected.length}   `
                    );
                }
            }
        );

        if (process.stdout.isTTY) {
            process.stdout.write("\n");
        }

        await saveRows(
            gallery.id,
            uploaded.filter((row) => !byKey.has(row.s3_key))
        );

        if (!process.stdout.isTTY) {
            console.log(
                `  ${name}: ${done}/${expected.length} uploaded or resumed`
            );
        }

        if (errors.length) {
            throw new AggregateError(
                errors,
                errors.map((error) => error.message).join("; ")
            );
        }
    }

    if (stopping) {
        return "interrupted";
    }

    const stored = await imageRows(gallery.id);

    if (
        stored.length !== expected.length ||
        new Set(stored.map((row) => row.s3_key)).size !==
            expected.length ||
        stored.some((row) => !expectedKeys.has(row.s3_key))
    ) {
        throw new Error("Final DB verification failed");
    }

    // Publish completion last.
    // Preserve an existing valid cover and ownership.
    const coverKey = expectedKeys.has(gallery.cover_key)
        ? gallery.cover_key
        : expected[0].s3_key;

    await db("finalize gallery", () =>
        supabase
            .from("galleries")
            .update({
                image_count: expected.length,
                cover_key: coverKey,
            })
            .eq("id", gallery.id)
            .select("id")
            .single()
    );

    console.log(`✓ ${name}: ${expected.length} items`);

    return pending.length ? "migrated" : "skipped";
}

async function main() {
    const dirs = await listNames(
        ROOT,
        (entry) => entry.isDirectory()
    );

    console.log(
        `Source: ${ROOT}\nBucket: ${config.s3.bucket} (prefix "${config.s3.prefix}")`
    );

    console.log(
        `Galleries: ${dirs.length}; upload workers: ${CONCURRENCY}; batch size: ${BATCH_SIZE}`
    );

    let ownerId = null;

    if (OWNER_EMAIL) {
        const { data } = await db("resolve owner", () =>
            supabase
                .from("users")
                .select("id")
                .eq("email", OWNER_EMAIL)
                .maybeSingle()
        );

        if (!data) {
            throw new Error(
                `Owner ${OWNER_EMAIL} not found; correct MIGRATE_OWNER_EMAIL`
            );
        }

        ownerId = data.id;
    }

    const started = Date.now();

    const counts = {
        migrated: 0,
        skipped: 0,
        failed: 0,
        interrupted: 0,
    };

    for (const name of dirs) {
        if (stopping) {
            break;
        }

        try {
            const result = await migrateGallery(name, ownerId);
            counts[result]++;
        } catch (error) {
            counts.failed++;
            console.error(`✗ ${name}: ${error.message}`);
        }
    }

    console.log(
        `\n${stopping ? "Stopped" : "Finished"}: ${JSON.stringify(counts)} in ${((Date.now() - started) / 1000).toFixed(1)}s`
    );

    if (counts.failed && !process.exitCode) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error.message);

    if (!process.exitCode) {
        process.exitCode = 1;
    }
});