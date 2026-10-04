import { COOKIE_NAME, verifyToken } from "../lib/auth.js";

// Populates req.user when a valid JWT cookie is present. Never blocks.
export function loadUser(req, res, next) {
    const token = req.cookies?.[COOKIE_NAME];
    const payload = token ? verifyToken(token) : null;

    req.user = payload
        ? { id: payload.sub, email: payload.email }
        : null;

    res.locals.user = req.user;

    next();
}

// Blocks unauthenticated access. HTML requests get redirected to the
// login page; anything else (API/fetch) gets a 401.
export function requireAuth(req, res, next) {
    if (req.user) {
        return next();
    }

    const wantsHtml = req.accepts(["html", "json"]) === "html";

    if (wantsHtml) {
        const next_ = encodeURIComponent(req.originalUrl);
        return res.redirect(`/login?next=${next_}`);
    }

    return res.status(401).json({ error: "Unauthorized" });
}
