import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { config } from "../config.js";

export async function hashPassword(password) {
    return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

export function signToken(user) {
    return jwt.sign(
        { sub: user.id, email: user.email },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
    );
}

export function verifyToken(token) {
    try {
        return jwt.verify(token, config.jwt.secret);
    } catch {
        return null;
    }
}

export const COOKIE_NAME = "token";
