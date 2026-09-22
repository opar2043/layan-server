import type { Request, Response } from "express";
import { getCollection } from "../../shared/db";
import { generateId, isoNow } from "../../shared/utils";
import { sendError, sendSuccess } from "../../shared/response";
import { hashPassword, verifyPassword } from "../../auth/password";
import { signToken } from "../../auth/jwt";
import type { AuthRequest } from "../../auth/middleware";

export type AuthHandler = (req: Request, res: Response) => Promise<Response | void>;

export const register: AuthHandler = async (req, res) => {
  const users = getCollection("app_user");
  const { email, phone, password, user_type } = req.body;

  if (!email || !password) return sendError(res, 400, "email and password are required");

  const exists = await users.findOne({ email });
  if (exists) return sendError(res, 409, "Email already registered");

  const user = {
    _id: generateId("app_user"),
    email,
    phone: phone ?? "",
    password_hash: await hashPassword(password),
    user_type: user_type ?? "customer",
    created_at: isoNow(),
  };

  await users.insertOne(user);

  const userToken= { 
    sub: user._id,
    email: user.email, 
    user_type: user.user_type
  }
  const token = signToken(userToken);
  return sendSuccess(res, { token, user }, 201);
};

export const login: AuthHandler = async (req, res) => {
  const users = getCollection("app_user");
  const { email, password } = req.body;

  if (!email || !password) return sendError(res, 400, "email and password are required");

  const user = await users.findOne({ email });
  if (!user || typeof user.password_hash !== "string" || !(await verifyPassword(password, user.password_hash))) {
    return sendError(res, 401, "Invalid credentials");
  }

  const token = signToken({
    sub: user._id,
    ...(typeof user.email === "string" ? { email: user.email } : {}),
    ...(typeof user.user_type === "string" ? { user_type: user.user_type } : {}),
  });
  return sendSuccess(res, { token, user });
};

export const me: AuthHandler = async (req, res) => {
  const user = (req as AuthRequest).user;
  if (!user) return sendError(res, 401, "Not authenticated");

  const appUser = await getCollection("app_user").findOne({ _id: user.sub });
  if (!appUser) return sendError(res, 404, "User not found");

  return sendSuccess(res, appUser);
};