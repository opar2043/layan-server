import { Router } from "express";
import { login, me, register } from "./auth";
import { protect } from "../../auth/middleware";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.get("/me", protect, me);

export default router;