#!/usr/bin/env node

/**
 * Migrate the existing local image galleries into S3 + Supabase.
 *
 * Safe to re-run:
 * - Existing completed galleries are skipped.
 * - Incomplete galleries are detected and repaired.
 * - Stopping the script with Ctrl+C is safe.
 *
 * Usage:
 *   LOCAL_IMAGE_ROOT=../images node scripts/migrate-to-s3.js
 *
 * Optional:
 *   MIGRATE_OWNER_EMAIL=someone@example.com
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

// Optional: attribute migrated galleries to a user.
const OWNER_EMAIL = process.env.MIGRATE_OWNER_EMAIL || "";

/**
 * List gallery directories.
 */
function listGalleryDirs(root) {
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(naturalCompare);
}

/**
 * List media files inside a gallery.
 */
function listMediaFiles(dir) {
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isFile() &&
                isMedia(entry.name)
        )
        .map((entry) => entry.name)
        .sort(naturalCompare);
}

/**
 * Resolve optional owner.
 */
async function resolveOwnerId() {
    if (!OWNER_EMAIL) {
        return null;
    }

    const { data, error } = await supabase
        .from("users")
        .select("id")
        .eq("email", OWNER_EMAIL.toLowerCase())
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (!data) {
        console.warn(
            `! MIGRATE_OWNER_EMAIL "${OWNER_EMAIL}" not found; created_by will be null.`
        );

        return null;
    }

    return data.id;
}

/**
 * Find an existing gallery.
 *
 * Returns the gallery row instead of only true/false.
 */
async function findGallery(name) {
    const { data, error } = await supabase
        .from("galleries")
        .select("id, name, slug, image_count, cover_key")
        .eq("name", name)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data;
}

/**
 * Get the number of images currently stored for a gallery.
 */
async function getGalleryImageCount(galleryId) {
    const { count, error } = await supabase
        .from("images")
        .select("id", {
            count: "exact",
            head: true,
        })
        .eq("gallery_id", galleryId);

    if (error) {
        throw error;
    }

    return count ?? 0;
}

/**
 * Delete existing image records for an incomplete gallery.
 *
 * We keep the gallery itself and rebuild its image records.
 */
async function deleteGalleryImages(galleryId) {
    const { error } = await supabase
        .from("images")
        .delete()
        .eq("gallery_id", galleryId);

    if (error) {
        throw error;
    }
}

/**
 * Migrate one gallery.
 */
async function migrateGallery(name, ownerId) {
    const dir = path.join(LOCAL_IMAGE_ROOT, name);

    const files = listMediaFiles(dir);

    if (files.length === 0) {
        console.log(`- ${name}: no media, skipped`);
        return;
    }

    /*
     * ------------------------------------------------------------
     * 1. CHECK DATABASE BEFORE UPLOADING ANYTHING
     * ------------------------------------------------------------
     */

    const existingGallery = await findGallery(name);

    if (existingGallery) {
        const dbImageCount = await getGalleryImageCount(
            existingGallery.id
        );

        console.log(
            `- ${name}: found in DB (${dbImageCount}/${files.length} images)`
        );

        /*
         * Everything is already there.
         *
         * Skip this gallery completely.
         */
        if (
            dbImageCount === files.length &&
            existingGallery.image_count === files.length
        ) {
            console.log(`  ✓ already complete, skipped`);
            return;
        }

        /*
         * Gallery exists but image count doesn't match.
         *
         * This usually means the previous migration was interrupted.
         */
        console.log(
            `  ! incomplete gallery detected, repairing...`
        );

        await deleteGalleryImages(existingGallery.id);

        /*
         * Continue below and upload/rebuild the images.
         */
    }

    /*
     * ------------------------------------------------------------
     * 2. UPLOAD FILES TO S3
     * ------------------------------------------------------------
     */

    const slug = existingGallery?.slug || slugify(name);

    const imageRows = [];
    let coverKey = existingGallery?.cover_key || null;

    for (let i = 0; i < files.length; i++) {
        const filename = files[i];

        const prefix = String(i).padStart(4, "0");

        const key = buildKey(
            slug,
            `${prefix}-${filename}`
        );

        const filePath = path.join(dir, filename);

        const buffer = fs.readFileSync(filePath);

        await uploadBuffer(
            key,
            buffer,
            filename
        );

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

    /*
     * ------------------------------------------------------------
     * 3. CREATE OR UPDATE GALLERY
     * ------------------------------------------------------------
     */

    let galleryId;

    if (existingGallery) {
        /*
         * Gallery already exists.
         *
         * Update its metadata instead of inserting another row.
         */
        const { data: gallery, error } = await supabase
            .from("galleries")
            .update({
                slug,
                cover_key: coverKey,
                image_count: imageRows.length,
                created_by: ownerId,
            })
            .eq("id", existingGallery.id)
            .select()
            .single();

        if (error) {
            throw error;
        }

        galleryId = gallery.id;

        console.log(
            `  ✓ gallery repaired: ${name}`
        );
    } else {
        /*
         * Brand new gallery.
         */
        const { data: gallery, error: galleryError } =
            await supabase
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

        galleryId = gallery.id;
    }

    /*
     * ------------------------------------------------------------
     * 4. INSERT IMAGE RECORDS
     * ------------------------------------------------------------
     */

    const { error: imagesError } = await supabase
        .from("images")
        .insert(
            imageRows.map((row) => ({
                ...row,
                gallery_id: galleryId,
            }))
        );

    if (imagesError) {
        throw imagesError;
    }

    console.log(
        `✓ ${name}: ${imageRows.length} items`
    );
}

/**
 * Main migration.
 */
async function main() {
    /*
     * Check source directory.
     */
    if (!fs.existsSync(LOCAL_IMAGE_ROOT)) {
        console.error(
            `Image root not found: ${LOCAL_IMAGE_ROOT}`
        );

        process.exit(1);
    }

    console.log(`Source : ${LOCAL_IMAGE_ROOT}`);
    console.log(
        `Bucket : ${config.s3.bucket} (prefix "${config.s3.prefix}")`
    );

    console.log("");

    /*
     * Resolve owner.
     */
    const ownerId = await resolveOwnerId();

    /*
     * Find galleries.
     */
    const dirs = listGalleryDirs(
        LOCAL_IMAGE_ROOT
    );

    if (dirs.length === 0) {
        console.log(
            "No gallery sub-directories found. Nothing to do."
        );

        return;
    }

    console.log(
        `Found ${dirs.length} gallery directories.\n`
    );

    /*
     * Process sequentially.
     */
    for (const name of dirs) {
        try {
            await migrateGallery(
                name,
                ownerId
            );
        } catch (err) {
            console.error(
                `✗ ${name}: ${err.message}`
            );
        }
    }

    console.log("\nDone.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});