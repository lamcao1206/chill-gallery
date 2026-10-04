import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Router } from "express";
import multer from "multer";
import unzipper from "unzipper";

import { supabase } from "../db/supabase.js";
import { buildKey, uploadBuffer } from "../lib/s3.js";
import {
    isMedia,
    mediaType,
    naturalCompare,
    slugify,
} from "../lib/media.js";

export const uploadRouter = Router();

const upload = multer({
    dest: path.join(os.tmpdir(), "gallery-uploads"),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
    fileFilter: (req, file, cb) => {
        const ok =
            file.mimetype === "application/zip" ||
            file.mimetype === "application/x-zip-compressed" ||
            file.originalname.toLowerCase().endsWith(".zip");
        cb(ok ? null : new Error("Only .zip files are accepted."), ok);
    },
});

// Skip macOS resource forks and hidden files inside the zip.
function isJunk(entryPath) {
    const base = path.basename(entryPath);
    return (
        entryPath.includes("__MACOSX/") ||
        base.startsWith(".") ||
        base === "Thumbs.db"
    );
}

// ----- Upload form -----
uploadRouter.get("/upload", (req, res) => {
    res.render("upload", { title: "Upload gallery", error: null });
});

// ----- Upload handler -----
uploadRouter.post(
    "/upload",
    (req, res, next) => {
        upload.single("zipfile")(req, res, (err) => {
            if (err) {
                return res.status(400).render("upload", {
                    title: "Upload gallery",
                    error: err.message,
                });
            }
            next();
        });
    },
    async (req, res, next) => {
        const tempPath = req.file?.path;

        const fail = (status, message) => {
            if (tempPath) {
                fs.promises.unlink(tempPath).catch(() => {});
            }
            return res
                .status(status)
                .render("upload", { title: "Upload gallery", error: message });
        };

        try {
            const name = String(req.body.name || "").trim();

            if (!name) {
                return fail(400, "Please enter a gallery name.");
            }
            if (!req.file) {
                return fail(400, "Please choose a .zip file.");
            }

            const directory = await unzipper.Open.file(tempPath);

            const entries = directory.files
                .filter(
                    (entry) =>
                        entry.type === "File" &&
                        !isJunk(entry.path) &&
                        isMedia(entry.path)
                )
                .sort((a, b) => naturalCompare(a.path, b.path));

            if (entries.length === 0) {
                return fail(
                    400,
                    "No images or videos were found in that zip."
                );
            }

            const slug = slugify(name);

            // Upload every media entry to S3, keeping zip order.
            const imageRows = [];
            let coverKey = null;

            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                const filename = path.basename(entry.path);
                const prefix = String(i).padStart(4, "0");
                const key = buildKey(slug, `${prefix}-${filename}`);

                const buffer = await entry.buffer();
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
            }

            // Create the gallery row.
            const { data: gallery, error: galleryError } = await supabase
                .from("galleries")
                .insert({
                    name,
                    slug,
                    cover_key: coverKey,
                    image_count: imageRows.length,
                    created_by: req.user.id,
                })
                .select()
                .single();

            if (galleryError) {
                throw galleryError;
            }

            // Attach images.
            const { error: imagesError } = await supabase.from("images").insert(
                imageRows.map((row) => ({
                    ...row,
                    gallery_id: gallery.id,
                }))
            );

            if (imagesError) {
                throw imagesError;
            }

            await fs.promises.unlink(tempPath).catch(() => {});

            res.redirect(`/gallery/${gallery.slug}`);
        } catch (err) {
            if (tempPath) {
                fs.promises.unlink(tempPath).catch(() => {});
            }
            next(err);
        }
    }
);
