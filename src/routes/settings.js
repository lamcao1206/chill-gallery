import { Router } from "express";

import { supabase } from "../db/supabase.js";

export const settingsRouter = Router();

const DEFAULTS = { columns: 1, fullscreen: false, page_size: 24 };

const ALLOWED_COLUMNS = [1, 2, 3];
const ALLOWED_PAGE_SIZES = [24, 50, 100];

// ----- Get settings -----
settingsRouter.get("/api/settings", async (req, res, next) => {
    try {
        const { data } = await supabase
            .from("settings")
            .select("columns, fullscreen, page_size")
            .eq("user_id", req.user.id)
            .maybeSingle();

        res.json(data || DEFAULTS);
    } catch (err) {
        next(err);
    }
});

// ----- Update settings -----
settingsRouter.put("/api/settings", async (req, res, next) => {
    try {
        const columns = Number(req.body.columns);
        const pageSize = Number(req.body.page_size);
        const fullscreen = Boolean(req.body.fullscreen);

        if (!ALLOWED_COLUMNS.includes(columns)) {
            return res
                .status(400)
                .json({ error: "columns must be 1, 2, or 3" });
        }
        if (!ALLOWED_PAGE_SIZES.includes(pageSize)) {
            return res
                .status(400)
                .json({ error: "page_size must be 24, 50, or 100" });
        }

        const row = {
            user_id: req.user.id,
            columns,
            fullscreen,
            page_size: pageSize,
        };

        const { error } = await supabase
            .from("settings")
            .upsert(row, { onConflict: "user_id" });

        if (error) {
            throw error;
        }

        res.json({ columns, fullscreen, page_size: pageSize });
    } catch (err) {
        next(err);
    }
});
