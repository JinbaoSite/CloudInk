import type { NextFunction, Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET || "dev-only-change-this-secret-before-production",
);
export type AuthedRequest = Request & { userId: string };
export async function tokenFor(userId: string) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const token = req.cookies?.session;
    if (!token) throw new Error();
    const { payload } = await jwtVerify(token, secret);
    if (!payload.sub) throw new Error();
    (req as AuthedRequest).userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "请先登录" });
  }
}
export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.COOKIE_SECURE === "true",
  maxAge: 7 * 86400_000,
  path: "/",
};
