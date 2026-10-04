import { Router } from "express";

import { supabase } from "../db/supabase.js";
import { presign } from "../lib/s3.js";

export const galleryRouter = Router();

// ----- Home / gallery list -----
galleryRouter.get("/", async (req, res, next) => {
    try {
        const q = String(req.query.q || "").trim();
        const page = Math.max(1, Number(req.query.page) || 1);

        const allowedSizes = [12, 24, 48, 96];
        let pageSize = Number(req.query.page_size) || 24;
        if (!allowedSizes.includes(pageSize)) {
            pageSize = 24;
        }

        let countQuery = supabase
            .from("galleries")
            .select("id", { count: "exact", head: true });

        if (q) {
            countQuery = countQuery.ilike("name", `%${q}%`);
        }

        const { count } = await countQuery;
        const total = count || 0;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const currentPage = Math.min(page, totalPages);

        const start = (currentPage - 1) * pageSize;

        let listQuery = supabase
            .from("galleries")
            .select("name, slug, cover_key, image_count")
            .order("name", { ascending: true })
            .range(start, start + pageSize - 1);

        if (q) {
            listQuery = listQuery.ilike("name", `%${q}%`);
        }

        const { data: rows, error } = await listQuery;
        if (error) {
            throw error;
        }

        const galleries = await Promise.all(
            (rows || []).map(async (row) => ({
                name: row.name,
                slug: row.slug,
                count: row.image_count,
                cover: await presign(row.cover_key),
            }))
        );

        res.render("index", {
            title: "Image Galleries",
            galleries,
            query: q,
            page: currentPage,
            pageSize,
            total,
            totalPages,
        });
    } catch (err) {
        next(err);
    }
});

// ----- Gallery reader -----
galleryRouter.get("/gallery/:slug", async (req, res, next) => {
    try {
        const { data: gallery } = await supabase
            .from("galleries")
            .select("id, name, slug")
            .eq("slug", req.params.slug)
            .maybeSingle();

        if (!gallery) {
            return res.status(404).render("error", {
                title: "Not found",
                message: "Gallery not found.",
            });
        }

        const { data: rows, error } = await supabase
            .from("images")
            .select("s3_key, filename, media_type, position")
            .eq("gallery_id", gallery.id)
            .order("position", { ascending: true });

        if (error) {
            throw error;
        }

        const images = await Promise.all(
            (rows || []).map(async (row) => ({
                name: row.filename,
                url: await presign(row.s3_key),
                type: row.media_type,
            }))
        );

        res.render("gallery", {
            title: gallery.name,
            galleryName: gallery.name,
            images,
        });
    } catch (err) {
        next(err);
    }
});
