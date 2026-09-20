import { Router } from "express";
import { create, findAll, findById, remove, update } from "./customer-business-profile";

const router = Router();

router.get("/", findAll);
router.get("/:id", findById);
router.post("/", create);
router.put("/:id", update);
router.delete("/:id", remove);

export default router;
