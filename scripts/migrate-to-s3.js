#!/usr/bin/env node
/**
 * Migrate the existing local image galleries into S3 + Supabase.
 *
 * Each sub-directory of LOCAL_IMAGE_ROOT becomes one gallery (this matches
 * the original FastAPI app, which only listed directories). Media files
 * inside each directory are uploaded to S3 and recorded in Supabase.
 *
 * Usage:
 *   LOCAL_IMAGE_ROOT=../images node scripts/migrate-to-s3.js
 *
 * Safe to re-run: galleries whose name already exists are skipped.
 */
import fs from "node:fs";
import path from "node:path";

import { config } from "../src/config.js";
import { supabase } from "../src/db/supabase.js";
import { buildKey, uploadBuffer } from "../src/lib/s3.js";
import {
    isMedia,
    mediaType,
    naturalCompare,
    slugify,
} from "../src/lib/media.js";

const LOCAL_IMAGE_ROOT = path.resolve(
    process.env.LOCAL_IMAGE_ROOT || "../images"
);

// Optional: attribute migrated galleries to a user (by email).
const OWNER_EMAIL = process.env.MIGRATE_OWNER_EMAIL || "";

function listGalleryDirs(root) {
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(naturalCompare);
}

function listMediaFiles(dir) {
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && isMedia(entry.name))
        .map((entry) => entry.name)
        .sort(naturalCompare);
}

async function resolveOwnerId() {
    if (!OWNER_EMAIL) {
        return null;
    }
    const { data } = await supabase
        .from("users")
        .select("id")
        .eq("email", OWNER_EMAIL.toLowerCase())
        .maybeSingle();

    if (!data) {
        console.warn(
            `! MIGRATE_OWNER_EMAIL "${OWNER_EMAIL}" not found; created_by will be null.`
        );
        return null;
    }
    return data.id;
}

async function galleryExists(name) {
    const { data } = await supabase
        .from("galleries")
        .select("id")
        .eq("name", name)
        .maybeSingle();
    return Boolean(data);
}

async function migrateGallery(name, ownerId) {
    const dir = path.join(LOCAL_IMAGE_ROOT, name);
    const files = listMediaFiles(dir);

    if (files.length === 0) {
        console.log(`- ${name}: no media, skipped`);
        return;
    }

    if (await galleryExists(name)) {
        console.log(`- ${name}: already migrated, skipped`);
        return;
    }

    const slug = slugify(name);
    const imageRows = [];
    let coverKey = null;

    for (let i = 0; i < files.length; i++) {
        const filename = files[i];
        const prefix = String(i).padStart(4, "0");
        const key = buildKey(slug, `${prefix}-${filename}`);

        const buffer = fs.readFileSync(path.join(dir, filename));
        await uploadBuffer(key, buffer, filename);

        if (!coverKey) {
            coverKey = key;
        }

        imageRows.push({
            s3_key: key,
            filename,
            media_type: mediaType(filename),
            position: i,
        });

        process.stdout.write(
            `\r  ${name}: uploaded ${i + 1}/${files.length}   `
        );
    }
    process.stdout.write("\n");

    const { data: gallery, error: galleryError } = await supabase
        .from("galleries")
        .insert({
            name,
            slug,
            cover_key: coverKey,
            image_count: imageRows.length,
            created_by: ownerId,
        })
        .select()
        .single();

    if (galleryError) {
        throw galleryError;
    }

    const { error: imagesError } = await supabase.from("images").insert(
        imageRows.map((row) => ({ ...row, gallery_id: gallery.id }))
    );

    if (imagesError) {
        throw imagesError;
    }

    console.log(`✓ ${name}: ${imageRows.length} items`);
}

async function main() {
    if (!fs.existsSync(LOCAL_IMAGE_ROOT)) {
        console.error(`Image root not found: ${LOCAL_IMAGE_ROOT}`);
        process.exit(1);
    }

    console.log(`Source : ${LOCAL_IMAGE_ROOT}`);
    console.log(`Bucket : ${config.s3.bucket} (prefix "${config.s3.prefix}")`);
    console.log("");

    const ownerId = await resolveOwnerId();
    const dirs = listGalleryDirs(LOCAL_IMAGE_ROOT);

    if (dirs.length === 0) {
        console.log("No gallery sub-directories found. Nothing to do.");
        return;
    }

    for (const name of dirs) {
        try {
            await migrateGallery(name, ownerId);
        } catch (err) {
            console.error(`✗ ${name}: ${err.message}`);
        }
    }

    console.log("\nDone.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
