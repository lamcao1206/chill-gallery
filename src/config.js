import dotenv from "dotenv";

dotenv.config();

function required(name) {
    const value = process.env[name];

    if (!value) {
        throw new Error(
            `Missing required environment variable: ${name}`
        );
    }

    return value;
}

// New-style Supabase secret key (sb_secret_...). Falls back to the legacy
// service_role key so existing setups keep working.
const supabaseSecretKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseSecretKey) {
    throw new Error(
        "Missing required environment variable: SUPABASE_SECRET_KEY"
    );
}

export const config = {
    port: Number(process.env.PORT || 8000),
    nodeEnv: process.env.NODE_ENV || "development",

    jwt: {
        secret: required("JWT_SECRET"),
        expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    },

    supabase: {
        url: required("SUPABASE_URL"),
        // Server-side secret key — bypasses RLS. Keep it off the browser.
        secretKey: supabaseSecretKey,
    },

    s3: {
        region: process.env.AWS_REGION || "us-east-1",
        bucket: required("S3_BUCKET"),
        prefix: (process.env.S3_PREFIX || "galleries").replace(
            /\/+$/,
            ""
        ),
        urlTtl: Number(process.env.S3_URL_TTL || 3600),
    },
};

export const isProd = config.nodeEnv === "production";
