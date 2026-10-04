import { Router } from "express";

import { isProd } from "../config.js";
import { supabase } from "../db/supabase.js";
import {
    COOKIE_NAME,
    signToken,
    verifyPassword,
} from "../lib/auth.js";

export const authRouter = Router();

const COOKIE_OPTS = {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

function safeNext(value) {
    // Only allow same-site relative redirects.
    if (typeof value === "string" && value.startsWith("/") && !value.startsWith("//")) {
        return value;
    }
    return "/";
}

// ----- Login -----
authRouter.get("/login", (req, res) => {
    if (req.user) {
        return res.redirect("/");
    }

    res.render("login", {
        title: "Log in",
        error: null,
        next: safeNext(req.query.next),
    });
});

authRouter.post("/login", async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const next = safeNext(req.body.next);

    const render = (error) =>
        res.status(401).render("login", {
            title: "Log in",
            error,
            next,
        });

    if (!email || !password) {
        return render("Email and password are required.");
    }

    const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("email", email)
        .maybeSingle();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
        return render("Invalid email or password.");
    }

    res.cookie(COOKIE_NAME, signToken(user), COOKIE_OPTS);
    res.redirect(next);
});

// Registration is intentionally disabled. The single account is created
// out-of-band with `npm run create-user` (see scripts/create-user.js).

// ----- Logout -----
authRouter.post("/logout", (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.redirect("/login");
});
